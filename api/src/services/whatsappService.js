'use strict';
// ================================================
// SALESPULSE — WhatsApp Coach (serviço)
//
// Mantém um socket do WhatsApp Web por vendedor (Baileys — WebSocket puro,
// sem Chromium/Puppeteer) e serve ao frontend as mensagens NOVAS de cada
// conversa. O coach em si roda no navegador (mesmo motor da modalidade de
// áudio); aqui é só a ponte com o WhatsApp.
//
// Decisões que moldam este arquivo:
//  - SOMENTE LEITURA. O serviço nunca envia mensagem — o vendedor copia a
//    sugestão e cola no WhatsApp dele. Isso reduz muito o risco de bloqueio
//    da conta e mantém o vendedor no controle do que o cliente recebe.
//  - SÓ CONVERSAS NOVAS, do QR em diante: `syncFullHistory: false` e apenas
//    eventos `notify` (mensagem chegando agora). Histórico antigo do celular
//    nunca é puxado.
//  - Credenciais no Postgres, não em disco: o App Service recicla o processo
//    e reescreve o filesystem a cada deploy — sem isso o vendedor teria que
//    reescanear o QR toda vez.
//  - Só conversas 1:1: grupos, status e newsletters são ignorados.
//
// ATENÇÃO OPERACIONAL: o socket vive no processo. O App Service precisa de
// "Always On" ligado e de UMA instância (sem scale-out) — com 2 instâncias,
// metade das requisições cairia num processo que não tem o socket.
// ================================================

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  proto,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const db = require('../db/pool');

const MAX_EVENTS = 600;        // buffer por sessão (o frontend consome por seq)
const KEYS_FLUSH_MS = 2500;    // gravação das chaves do Signal em lote
const MAX_RECONNECT = 5;

// Baileys espera um logger no formato pino. Silenciamos: os eventos que
// importam já são refletidos no status da sessão.
const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/** sessões vivas, por usuário: userId -> session */
const sessions = new Map();

// ══════════════════════════════════════
// AUTH STATE — persistido no Postgres
// ══════════════════════════════════════

// Buffers viram {type:'Buffer',data:[...]} no JSONB; o replacer/reviver do
// Baileys é quem sabe fazer essa ida e volta sem corromper as chaves.
function reviveJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function loadAuthState(userId) {
  const { rows } = await db.query('SELECT creds, keys FROM whatsapp_sessions WHERE user_id = $1', [userId]);
  const row = rows[0];

  // creds e keys só valem JUNTOS: as chaves do Signal pertencem àquele
  // pareamento. Sem creds (QR gerado e nunca escaneado, ou logout), as chaves
  // que sobraram são lixo — reusá-las com credenciais novas corrompe a sessão.
  const savedCreds = row && row.creds ? reviveJson(row.creds, null) : null;
  const creds = savedCreds || initAuthCreds();
  const keyStore = savedCreds ? reviveJson(row.keys, {}) : {};

  let keysDirty = false;
  let flushTimer = null;

  async function writeKeys() {
    flushTimer = null;
    if (!keysDirty) return;
    keysDirty = false;
    try {
      await db.query(`
        INSERT INTO whatsapp_sessions (user_id, keys, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET keys = $2, updated_at = CURRENT_TIMESTAMP
      `, [userId, JSON.stringify(keyStore, BufferJSON.replacer)]);
    } catch (err) {
      console.error('[WA KEYS SAVE]', err.message);
    }
  }

  function scheduleKeysFlush() {
    keysDirty = true;
    if (!flushTimer) flushTimer = setTimeout(writeKeys, KEYS_FLUSH_MS);
  }

  const keys = {
    get: (type, ids) => {
      const data = {};
      for (const id of ids) {
        let value = keyStore[type] ? keyStore[type][id] : undefined;
        if (value && type === 'app-state-sync-key') {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        if (value !== undefined) data[id] = value;
      }
      return data;
    },
    set: (data) => {
      for (const type of Object.keys(data)) {
        if (!keyStore[type]) keyStore[type] = {};
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          if (value === null || value === undefined) delete keyStore[type][id];
          else keyStore[type][id] = value;
        }
      }
      scheduleKeysFlush();
    },
  };

  async function saveCreds() {
    try {
      await db.query(`
        INSERT INTO whatsapp_sessions (user_id, creds, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET creds = $2, updated_at = CURRENT_TIMESTAMP
      `, [userId, JSON.stringify(creds, BufferJSON.replacer)]);
    } catch (err) {
      console.error('[WA CREDS SAVE]', err.message);
    }
  }

  async function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await writeKeys();
  }

  return { state: { creds, keys }, saveCreds, flushNow };
}

async function clearAuth(userId) {
  try {
    await db.query('UPDATE whatsapp_sessions SET creds = NULL, keys = \'{}\'::jsonb, phone = NULL, connected_at = NULL WHERE user_id = $1', [userId]);
  } catch (err) {
    console.error('[WA AUTH CLEAR]', err.message);
  }
}

// ══════════════════════════════════════
// EXTRAÇÃO DE TEXTO DA MENSAGEM
// ══════════════════════════════════════
function extractText(message) {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage && message.extendedTextMessage.text) return message.extendedTextMessage.text;
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return extractText(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return extractText(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage) return extractText(message.documentWithCaptionMessage.message);
  // Mídia: o coach não vê o conteúdo, mas precisa saber que algo chegou —
  // "mandei o catálogo" muda a dica seguinte.
  if (message.imageMessage) return message.imageMessage.caption ? `[imagem] ${message.imageMessage.caption}` : '[imagem]';
  if (message.videoMessage) return message.videoMessage.caption ? `[vídeo] ${message.videoMessage.caption}` : '[vídeo]';
  if (message.audioMessage) return '[áudio]';
  if (message.documentMessage) return `[documento] ${message.documentMessage.fileName || ''}`.trim();
  if (message.stickerMessage) return '[figurinha]';
  if (message.locationMessage) return '[localização]';
  if (message.contactMessage || message.contactsArrayMessage) return '[contato]';
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedDisplayText || null;
  if (message.listResponseMessage) return message.listResponseMessage.title || null;
  return null; // reações, recibos, protocolo: não viram dica
}

// Só conversa 1:1 de gente: fora grupos, status, newsletter e o próprio nº
function isCoachableJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (jid.endsWith('@g.us')) return false;
  if (jid.endsWith('@broadcast')) return false;
  if (jid.endsWith('@newsletter')) return false;
  if (jid === 'status@broadcast') return false;
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function prettyPhone(jid) {
  const num = String(jid || '').split('@')[0].split(':')[0];
  return num ? `+${num}` : '';
}

// ══════════════════════════════════════
// SESSÃO
// ══════════════════════════════════════
function newSession(userId) {
  return {
    userId,
    sock: null,
    status: 'connecting',  // connecting | qr | connected | logged_out | error | closed
    qr: null,
    phone: null,
    error: null,
    chats: new Map(),      // jid -> { jid, name, lastAt, count }
    events: [],            // mensagens novas, consumidas por seq
    seq: 0,
    reconnects: 0,
    stopping: false,
    saveCreds: null,
    flushNow: null,
    startedAt: Date.now(),
  };
}

function pushEvent(s, evt) {
  s.seq += 1;
  s.events.push({ seq: s.seq, ...evt });
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
}

function publicState(s) {
  if (!s) return { status: 'idle', qr: null, phone: null, chats: [], seq: 0, error: null };
  return {
    status: s.status,
    qr: s.qr,
    phone: s.phone,
    error: s.error,
    seq: s.seq,
    chats: [...s.chats.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .map(c => ({ jid: c.jid, name: c.name, phone: prettyPhone(c.jid), lastAt: c.lastAt, count: c.count })),
  };
}

async function startSocket(s) {
  const { state, saveCreds, flushNow } = await loadAuthState(s.userId);
  s.saveCreds = saveCreds;
  s.flushNow = flushNow;

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    version = undefined; // Baileys cai no default embutido
  }

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
    logger: silentLogger,
    browser: Browsers.appropriate('SalesPulse'),
    // Só conversas novas: nada de puxar anos de histórico do celular.
    syncFullHistory: false,
    // Não marca o vendedor como online — se marcasse, o celular dele pararia
    // de notificar as mensagens que o SalesPulse já "leu".
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  s.sock = sock;

  sock.ev.on('creds.update', () => { saveCreds(); });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
        s.status = 'qr';
        s.error = null;
      } catch (e) {
        console.error('[WA QR]', e.message);
      }
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.qr = null;
      s.error = null;
      s.reconnects = 0;
      s.phone = prettyPhone(sock.user && sock.user.id);
      try {
        await db.query(`
          INSERT INTO whatsapp_sessions (user_id, phone, connected_at, updated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id) DO UPDATE SET phone = $2, connected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        `, [s.userId, s.phone]);
      } catch (e) { console.error('[WA CONNECT SAVE]', e.message); }
    }

    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;

      if (s.stopping) { s.status = 'closed'; return; }

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        // Vendedor desconectou o aparelho pelo celular: credenciais mortas.
        s.status = 'logged_out';
        s.qr = null;
        s.phone = null;
        await clearAuth(s.userId);
        sessions.delete(s.userId);
        return;
      }

      if (s.reconnects >= MAX_RECONNECT) {
        s.status = 'error';
        s.error = 'Não foi possível reconectar ao WhatsApp. Reconecte para escanear de novo.';
        return;
      }

      // Queda de rede / restartRequired: reconecta com backoff, sem QR novo
      s.reconnects += 1;
      s.status = 'connecting';
      const delay = Math.min(15000, 1500 * s.reconnects);
      setTimeout(() => {
        if (s.stopping || sessions.get(s.userId) !== s) return;
        startSocket(s).catch(err => {
          s.status = 'error';
          s.error = err.message;
        });
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', (up) => {
    // 'notify' = mensagem chegando agora. 'append'/history sync = passado,
    // que por decisão de produto o coach não acompanha.
    if (!up || up.type !== 'notify') return;
    for (const m of up.messages || []) {
      try { handleIncoming(s, m); } catch (e) { console.error('[WA MSG]', e.message); }
    }
  });
}

function handleIncoming(s, m) {
  const jid = m.key && m.key.remoteJid;
  if (!isCoachableJid(jid)) return;

  const text = extractText(m.message);
  if (!text || !text.trim()) return;

  const fromMe = !!(m.key && m.key.fromMe);
  const name = (!fromMe && m.pushName) ? m.pushName : null;
  const t = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();

  let chat = s.chats.get(jid);
  if (!chat) {
    chat = { jid, name: name || prettyPhone(jid), lastAt: t, count: 0 };
    s.chats.set(jid, chat);
  }
  if (name && chat.name !== name) chat.name = name;
  chat.lastAt = t;
  chat.count += 1;

  pushEvent(s, {
    jid,
    name: chat.name,
    phone: prettyPhone(jid),
    // Mesmos papéis da modalidade de áudio: quem vende x quem compra
    speaker: fromMe ? 'seller' : 'client',
    text: text.trim().slice(0, 4000),
    t,
    id: (m.key && m.key.id) || null,
  });
}

// ══════════════════════════════════════
// API DO SERVIÇO
// ══════════════════════════════════════
async function connect(userId) {
  const existing = sessions.get(userId);
  if (existing && ['connected', 'qr', 'connecting'].includes(existing.status)) {
    return publicState(existing);
  }
  if (existing) { try { existing.sock && existing.sock.end(); } catch (e) {} }

  const s = newSession(userId);
  sessions.set(userId, s);
  try {
    await startSocket(s);
  } catch (err) {
    s.status = 'error';
    s.error = err.message;
    console.error('[WA CONNECT]', err);
  }
  return publicState(s);
}

function status(userId) {
  return publicState(sessions.get(userId));
}

// Mensagens novas desde o último seq visto pelo frontend
function events(userId, since) {
  const s = sessions.get(userId);
  if (!s) return { status: 'idle', seq: 0, events: [] };
  const from = Number(since) || 0;
  return {
    status: s.status,
    seq: s.seq,
    // Se o buffer girou e o cliente ficou para trás, ele recebe o que sobrou
    events: s.events.filter(e => e.seq > from),
  };
}

async function disconnect(userId) {
  const s = sessions.get(userId);
  if (s) {
    s.stopping = true;
    try { if (s.flushNow) await s.flushNow(); } catch (e) {}
    try { if (s.sock) await s.sock.logout(); } catch (e) {
      try { s.sock && s.sock.end(); } catch (e2) {}
    }
    sessions.delete(userId);
  }
  await clearAuth(userId);
  return { status: 'idle' };
}

async function getBriefing(userId) {
  const { rows } = await db.query('SELECT briefing FROM whatsapp_sessions WHERE user_id = $1', [userId]);
  return (rows[0] && rows[0].briefing) || {};
}

async function saveBriefing(userId, briefing) {
  await db.query(`
    INSERT INTO whatsapp_sessions (user_id, briefing, updated_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id) DO UPDATE SET briefing = $2, updated_at = CURRENT_TIMESTAMP
  `, [userId, JSON.stringify(briefing || {})]);
  return { success: true };
}

module.exports = { connect, status, events, disconnect, getBriefing, saveBriefing };
