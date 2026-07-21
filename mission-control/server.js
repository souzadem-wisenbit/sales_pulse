'use strict';
// SalesPulse Mission Control — painel local de operação da frota de instâncias.
// Roda SOMENTE em 127.0.0.1 (sem autenticação própria: é uma ferramenta local
// do dono da operação; os segredos ficam em mission-control/data/, fora do git).
const path = require('path');
const express = require('express');

const registry = require('./lib/registry');
const azure = require('./lib/azure');
const kudu = require('./lib/kudu');
const db = require('./lib/instanceDb');
const provision = require('./lib/provision');
const { requestJson } = require('./lib/http');

const PORT = process.env.MC_PORT || 5599;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Handler async padrão: erros viram JSON {error}
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[MC] ${req.method} ${req.path}:`, err.message);
    const hint = db.dbErrorHint(err);
    res.status(err.httpStatus || 500).json({ error: err.message, ...(hint ? { hint } : {}) });
  });
};

function getInst(req) {
  const inst = registry.get(req.params.id);
  if (!inst) {
    const err = new Error('Instância não encontrada.');
    err.httpStatus = 404;
    throw err;
  }
  return inst;
}

// ===== Frota / registro =====

app.get('/api/instances', wrap(async (req, res) => {
  res.json(registry.list().map(registry.toPublic));
}));

// Status ao vivo de todas as instâncias em paralelo (health + estado Azure).
// O estado Azure é cacheado por 60s; o health é sempre ao vivo.
const azureStateCache = new Map(); // appName -> {t, data}
app.get('/api/fleet/status', wrap(async (req, res) => {
  const instances = registry.list();
  const results = await Promise.all(instances.map(async (inst) => {
    const out = { id: inst.id, health: null, latencyMs: null, azure: null };
    const t0 = Date.now();
    try {
      const { status, json } = await requestJson(`${inst.url}/api/health`, { timeout: 8000 });
      out.latencyMs = Date.now() - t0;
      out.health = status === 200 && json && json.status === 'ok' ? 'online' : `http ${status}`;
    } catch (err) {
      out.health = 'offline';
      out.latencyMs = null;
    }
    if (inst.dbUrl) {
      try {
        await Promise.race([
          db.q(inst, 'SELECT 1'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        out.db = 'ok';
      } catch (err) {
        out.db = 'down';
      }
    }
    const cached = azureStateCache.get(inst.appName);
    if (cached && Date.now() - cached.t < 60000) {
      out.azure = cached.data;
    } else {
      try {
        const info = await azure.webappShow(inst.appName, inst.resourceGroup);
        out.azure = info;
        azureStateCache.set(inst.appName, { t: Date.now(), data: info });
      } catch (err) {
        out.azure = { error: err.message };
      }
    }
    return out;
  }));
  res.json(results);
}));

app.post('/api/instances', wrap(async (req, res) => {
  const { company, appName, resourceGroup, dbUrl, notes } = req.body;
  if (!company || !appName || !resourceGroup) {
    return res.status(400).json({ error: 'company, appName e resourceGroup são obrigatórios.' });
  }
  let finalDbUrl = dbUrl;
  let dbSource = 'manual';
  if (!finalDbUrl) {
    // Busca a DATABASE_URL direto das App Settings da instância
    const settings = await azure.appsettingsList(appName, resourceGroup);
    finalDbUrl = settings.DATABASE_URL;
    dbSource = 'app settings';
    if (!finalDbUrl) return res.status(400).json({ error: 'A instância não tem DATABASE_URL nas App Settings — informe manualmente.' });
  }
  // Registra mesmo se o banco estiver fora — monitorar instância quebrada é
  // justamente o papel do painel. O card/aba de dados mostra o erro.
  let dbTest;
  try {
    const test = await db.testConnection(finalDbUrl);
    dbTest = { ok: true, users: test.users };
  } catch (err) {
    dbTest = { ok: false, error: err.message };
  }
  const inst = registry.add({ company, appName, resourceGroup, dbUrl: finalDbUrl, notes });
  res.status(201).json({ ...registry.toPublic(inst), dbSource, dbTest });
}));

app.put('/api/instances/:id', wrap(async (req, res) => {
  getInst(req);
  const inst = registry.update(req.params.id, req.body);
  if (req.body.dbUrl !== undefined) await db.closePool(inst.id);
  res.json(registry.toPublic(inst));
}));

app.delete('/api/instances/:id', wrap(async (req, res) => {
  getInst(req);
  await db.closePool(req.params.id);
  registry.remove(req.params.id);
  res.status(204).send();
}));

// Web apps da assinatura (para o modal "registrar existente")
app.get('/api/azure/webapps', wrap(async (req, res) => {
  const [apps] = await Promise.all([azure.listWebapps()]);
  const registered = new Set(registry.list().map((i) => i.appName));
  res.json(apps.map((a) => ({ ...a, registered: registered.has(a.name) })));
}));

app.get('/api/azure/plans', wrap(async (req, res) => {
  res.json(await azure.listPlans());
}));

// ===== Dados da instância =====

app.get('/api/instances/:id/overview', wrap(async (req, res) => {
  res.json(await db.overview(getInst(req)));
}));

app.get('/api/instances/:id/users', wrap(async (req, res) => {
  res.json(await db.listUsers(getInst(req)));
}));

app.post('/api/instances/:id/users', wrap(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email e password são obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha precisa de pelo menos 6 caracteres.' });
  if (role && !['seller', 'manager', 'superadmin'].includes(role)) return res.status(400).json({ error: 'role inválida.' });
  res.status(201).json(await db.createUser(getInst(req), req.body));
}));

app.put('/api/instances/:id/users/:uid', wrap(async (req, res) => {
  res.json(await db.updateUser(getInst(req), req.params.uid, req.body));
}));

app.delete('/api/instances/:id/users/:uid', wrap(async (req, res) => {
  await db.deleteUser(getInst(req), req.params.uid);
  res.status(204).send();
}));

app.get('/api/instances/:id/sessions', wrap(async (req, res) => {
  res.json(await db.listSessions(getInst(req), {
    userId: req.query.user_id,
    limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
    offset: parseInt(req.query.offset, 10) || 0,
  }));
}));

app.get('/api/instances/:id/sessions/:sid', wrap(async (req, res) => {
  res.json(await db.getSession(getInst(req), req.params.sid));
}));

app.delete('/api/instances/:id/sessions/:sid', wrap(async (req, res) => {
  await db.deleteSession(getInst(req), req.params.sid);
  res.status(204).send();
}));

// ----- Clientes (personas) -----
app.get('/api/instances/:id/clients', wrap(async (req, res) => {
  res.json(await db.listClients(getInst(req)));
}));
app.post('/api/instances/:id/clients', wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Nome é obrigatório.' });
  res.status(201).json(await db.createClient(getInst(req), req.body));
}));
app.put('/api/instances/:id/clients/:cid', wrap(async (req, res) => {
  res.json(await db.updateClient(getInst(req), req.params.cid, req.body));
}));
app.delete('/api/instances/:id/clients/:cid', wrap(async (req, res) => {
  await db.deleteClient(getInst(req), req.params.cid);
  res.status(204).send();
}));

// ----- Produtos -----
app.get('/api/instances/:id/products', wrap(async (req, res) => {
  res.json(await db.listProducts(getInst(req)));
}));
app.post('/api/instances/:id/products', wrap(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Nome é obrigatório.' });
  res.status(201).json(await db.createProduct(getInst(req), req.body));
}));
app.put('/api/instances/:id/products/:pid', wrap(async (req, res) => {
  res.json(await db.updateProduct(getInst(req), req.params.pid, req.body));
}));
app.delete('/api/instances/:id/products/:pid', wrap(async (req, res) => {
  await db.deleteProduct(getInst(req), req.params.pid);
  res.status(204).send();
}));

// ----- Sessões agendadas -----
app.get('/api/instances/:id/scheduled', wrap(async (req, res) => {
  res.json(await db.listScheduled(getInst(req)));
}));
app.post('/api/instances/:id/scheduled', wrap(async (req, res) => {
  if (!req.body.seller_id || !req.body.client_id) {
    return res.status(400).json({ error: 'Vendedor e cliente são obrigatórios.' });
  }
  res.status(201).json(await db.createScheduled(getInst(req), req.body));
}));
app.put('/api/instances/:id/scheduled/:sid', wrap(async (req, res) => {
  res.json(await db.updateScheduled(getInst(req), req.params.sid, req.body));
}));
app.delete('/api/instances/:id/scheduled/:sid', wrap(async (req, res) => {
  await db.deleteScheduled(getInst(req), req.params.sid);
  res.status(204).send();
}));

// ----- Usuários de toda a frota (empresa ↔ usuários) -----
app.get('/api/fleet/users', wrap(async (req, res) => {
  const instances = registry.list();
  const results = await Promise.all(instances.map(async (inst) => {
    try {
      const users = await db.listUsers(inst);
      return { instanceId: inst.id, company: inst.company, appName: inst.appName, url: inst.url, ok: true, users };
    } catch (err) {
      return {
        instanceId: inst.id, company: inst.company, appName: inst.appName, url: inst.url, ok: false,
        error: err.message, hint: db.dbErrorHint(err),
      };
    }
  }));
  res.json(results);
}));

app.get('/api/instances/:id/live-calls', wrap(async (req, res) => {
  res.json(await db.listLiveCalls(getInst(req), { userId: req.query.user_id }));
}));

app.get('/api/instances/:id/live-calls/:cid', wrap(async (req, res) => {
  res.json(await db.getLiveCall(getInst(req), req.params.cid));
}));

// ===== Logs / operação =====

app.get('/api/instances/:id/logs', wrap(async (req, res) => {
  const maxKb = Math.min(parseInt(req.query.maxKb, 10) || 256, 1024);
  res.json(await kudu.dockerLogTail(getInst(req), maxKb * 1024));
}));

app.post('/api/instances/:id/restart', wrap(async (req, res) => {
  const inst = getInst(req);
  await azure.restart(inst.appName, inst.resourceGroup);
  azureStateCache.delete(inst.appName);
  res.json({ ok: true });
}));

app.get('/api/instances/:id/settings', wrap(async (req, res) => {
  const inst = getInst(req);
  const SECRET_RE = /(SECRET|KEY|URL|PASSWORD|TOKEN)/i;
  const [site, settings, ai] = await Promise.all([
    azure.webappShow(inst.appName, inst.resourceGroup).catch((e) => ({ error: e.message })),
    azure.appsettingsList(inst.appName, inst.resourceGroup).catch(() => null),
    db.aiSettings(inst).catch((e) => ({ error: e.message })),
  ]);
  const appSettings = settings
    ? Object.entries(settings).map(([name, value]) => ({
        name,
        value: SECRET_RE.test(name) && value ? `${value.slice(0, 6)}…${value.slice(-4)}` : value,
        secret: SECRET_RE.test(name),
      }))
    : null;
  res.json({
    site,
    appSettings,
    ai,
    links: {
      app: inst.url,
      scm: inst.scmUrl,
      portal: `https://portal.azure.com/#resource/subscriptions/${encodeURIComponent(process.env.MC_SUBSCRIPTION || '4b358dd0-6b24-45a3-ad97-34b629dfa609')}/resourceGroups/${encodeURIComponent(inst.resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(inst.appName)}/appServices`,
    },
  });
}));

app.post('/api/instances/:id/db-test', wrap(async (req, res) => {
  const inst = getInst(req);
  res.json(await db.testConnection(inst.dbUrl));
}));

// ===== Provisionamento =====

app.post('/api/provision', wrap(async (req, res) => {
  const { company, appName, resourceGroup, plan, dbUrl, adminEmail, adminPassword } = req.body;
  const missing = ['company', 'appName', 'resourceGroup', 'plan', 'dbUrl', 'adminEmail', 'adminPassword']
    .filter((k) => !req.body[k]);
  if (missing.length) return res.status(400).json({ error: `Campos obrigatórios: ${missing.join(', ')}` });
  if (!/^[a-z0-9-]{2,60}$/.test(appName)) {
    return res.status(400).json({ error: 'Nome do app deve ter só letras minúsculas, números e hífens.' });
  }
  if (registry.list().some((i) => i.appName === appName)) {
    return res.status(400).json({ error: 'Já existe uma instância registrada com esse nome de app.' });
  }
  const job = provision.createJob(req.body);
  res.status(202).json({ jobId: job.id });
}));

app.get('/api/provision/:jobId', wrap(async (req, res) => {
  const job = provision.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json(provision.snapshot(job));
}));

// Progresso em tempo real via Server-Sent Events
app.get('/api/provision/:jobId/stream', (req, res) => {
  const job = provision.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(provision.snapshot(job));
  const listener = (snap) => send(snap);
  job.emitter.on('update', listener);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.removeListener('update', listener);
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'mission-control' }));

app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// start() é chamado pelo Electron (electron-main.js); rodar `node server.js`
// direto também funciona como fallback (modo navegador).
function start() {
  return new Promise((resolve) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[MC] backend em http://127.0.0.1:${PORT}`);
      resolve({ server, port: PORT });
    });
  });
}

module.exports = { app, start, PORT };

if (require.main === module) start();
