'use strict';
// ================================================
// Proxy do Live Coach: a dica é gerada AQUI, no backend, com a chave da
// OpenAI do servidor (ai_settings, via knowledgeService.getOpenAI). O
// navegador nunca mais vê a chave — ele só manda o prompt e recebe o JSON.
// De quebra, cada chamada é MEDIDA por usuário (ai_usage) para faturar por
// tenant e vigiar a margem (o custo da OpenAI é variável).
// ================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db/pool');
const knowledge = require('../services/knowledgeService');

// gpt-4o-mini-transcribe pode não existir na conta. Depois da 1ª falha,
// paramos de tentá-lo (senão toda transcrição paga uma chamada perdida).
let _miniTranscribeOk = true;

// Só modelos aprovados podem ser pedidos pelo cliente — evita alguém apontar
// a SUA chave para um modelo caro. maxTokens e prompt têm teto (anti-abuso).
const ALLOWED_MODELS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']);
const MAX_PROMPT_CHARS = 60000;   // prompt do coach = método + conversa + briefing
const MAX_OUTPUT_TOKENS = 900;    // teto do JSON da dica (folga sem exagero)

async function complete(req, res) {
  const body = req.body || {};
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt obrigatório' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: 'prompt muito grande' });
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'gpt-4o-mini';
  const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 320, 1), MAX_OUTPUT_TOKENS);
  const temperature = Math.min(Math.max(Number(body.temperature != null ? body.temperature : 0.6), 0), 1.5);
  const source = String(body.source || 'coach').slice(0, 32);

  try {
    const openai = await knowledge.getOpenAI();
    // maxRetries 0 + timeout curto: o coach prefere falhar rápido (o cliente
    // degrada para "sem dica") a segurar uma dica atrasada = dica errada.
    const completion = await openai.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
      },
      { timeout: 9000, maxRetries: 0 }
    );

    const content = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : null;
    const usage = completion.usage || {};

    // Medição por tenant — nunca bloqueia a resposta se o insert falhar.
    const managerId = req.user.role === 'manager' ? req.user.id : (req.user.manager_id || null);
    db.query(
      `INSERT INTO ai_usage (user_id, manager_id, model, source, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, managerId, model, source, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
    ).catch((e) => console.error('[AI_USAGE]', e.message));

    return res.json({ content, usage });
  } catch (err) {
    console.error('[COACH COMPLETE]', err && err.message);
    return res.status(502).json({ error: 'Falha ao gerar a dica' });
  }
}

// Transcrição do Live Coach — WAV 16kHz do navegador → Whisper no servidor.
// A chave da OpenAI nunca vem para o browser. Tenta gpt-4o-mini-transcribe
// (mais preciso) e cai para whisper-1 com verbose_json + filtro estatístico de
// alucinação — a MESMA lógica que rodava no cliente, agora centralizada aqui.
async function transcribe(req, res) {
  if (!req.file) return res.status(400).json({ error: 'áudio obrigatório' });
  const prompt = String(req.body.prompt || '').slice(0, 500);
  const language = /^[a-z]{2}$/i.test(req.body.language || '') ? req.body.language : 'pt';
  const ext = (path.extname(req.file.originalname || '').replace('.', '') || 'wav').toLowerCase();
  let tmp;
  try {
    const openai = await knowledge.getOpenAI();
    tmp = path.join(os.tmpdir(), `coach_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(tmp, req.file.buffer);

    let text = '';
    let seconds = null;
    let done = false;

    if (_miniTranscribeOk) {
      try {
        const r = await openai.audio.transcriptions.create(
          { file: fs.createReadStream(tmp), model: 'gpt-4o-mini-transcribe', language, temperature: 0, prompt },
          { timeout: 15000, maxRetries: 0 }
        );
        text = (r.text || '').trim();
        done = true;
      } catch (e) {
        _miniTranscribeOk = false; // some do caminho quente; cai para whisper-1
      }
    }

    if (!done) {
      const r = await openai.audio.transcriptions.create(
        { file: fs.createReadStream(tmp), model: 'whisper-1', language, temperature: 0, prompt, response_format: 'verbose_json' },
        { timeout: 15000, maxRetries: 0 }
      );
      const segs = (r.segments || []).filter((s) =>
        (s.no_speech_prob === undefined || s.no_speech_prob < 0.5) &&
        (s.avg_logprob === undefined || s.avg_logprob > -1.2)
      );
      text = segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      seconds = r.duration != null ? Math.round(r.duration) : null;
    }

    // Medição por tenant (best-effort; nunca bloqueia a resposta)
    const managerId = req.user.role === 'manager' ? req.user.id : (req.user.manager_id || null);
    db.query(
      `INSERT INTO ai_usage (user_id, manager_id, model, source, audio_seconds) VALUES ($1, $2, $3, 'transcribe', $4)`,
      [req.user.id, managerId, done ? 'gpt-4o-mini-transcribe' : 'whisper-1', seconds]
    ).catch((e) => console.error('[AI_USAGE transcribe]', e.message));

    return res.json({ text });
  } catch (err) {
    console.error('[COACH TRANSCRIBE]', err && err.message);
    return res.status(502).json({ error: 'Falha na transcrição' });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
  }
}

// Token EFÊMERO da OpenAI Realtime (cliente-bot de voz). O backend cria um
// client_secret de vida curta (~1 min) com a chave do servidor; o navegador
// conecta o WebRTC com ELE, nunca com a chave real. Emite para os dois flavors
// (GA /realtime/calls e beta /realtime) — o cliente tenta na ordem, igual antes.
async function realtimeToken(req, res) {
  try {
    const { rows } = await db.query('SELECT openai_key FROM ai_settings LIMIT 1');
    const key = rows[0] && rows[0].openai_key;
    if (!key) return res.status(500).json({ error: 'IA não configurada' });

    const attempts = [];

    // GA: /v1/realtime/client_secrets → { value: 'ek_...' }
    try {
      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { type: 'realtime', model: 'gpt-realtime' } }),
      });
      if (r.ok) {
        const d = await r.json();
        const secret = d.value || (d.client_secret && d.client_secret.value);
        if (secret) attempts.push({ flavor: 'ga', url: 'https://api.openai.com/v1/realtime/calls?model=gpt-realtime', headers: {}, secret });
      }
    } catch (e) { /* segue para o beta */ }

    // Beta: /v1/realtime/sessions → { client_secret: { value } }
    try {
      const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenAI-Beta': 'realtime=v1' },
        body: JSON.stringify({ model: 'gpt-4o-realtime-preview' }),
      });
      if (r.ok) {
        const d = await r.json();
        const secret = d.client_secret && d.client_secret.value;
        if (secret) attempts.push({ flavor: 'beta', url: 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', headers: { 'OpenAI-Beta': 'realtime=v1' }, secret });
      }
    } catch (e) { /* nenhum flavor deu → 502 abaixo */ }

    if (!attempts.length) return res.status(502).json({ error: 'Falha ao criar sessão realtime' });

    // Medição: cada token = início de uma sessão de voz do cliente-bot.
    const managerId = req.user.role === 'manager' ? req.user.id : (req.user.manager_id || null);
    db.query(
      `INSERT INTO ai_usage (user_id, manager_id, model, source) VALUES ($1, $2, 'gpt-realtime', 'realtime')`,
      [req.user.id, managerId]
    ).catch((e) => console.error('[AI_USAGE realtime]', e.message));

    return res.json({ attempts });
  } catch (err) {
    console.error('[REALTIME TOKEN]', err && err.message);
    return res.status(502).json({ error: 'Falha ao criar sessão realtime' });
  }
}

module.exports = { complete, transcribe, realtimeToken };
