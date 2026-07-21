'use strict';
// Cliente Kudu (SCM) — logs do container, deployments e zipdeploy.
const { request, requestJson, basicAuth } = require('./http');
const azure = require('./azure');

async function authHeader(inst) {
  const creds = await azure.publishingCredentials(inst.appName, inst.resourceGroup);
  return basicAuth(creds.user, creds.pass);
}

// Tail do log docker do app (o *_default_docker.log é o stdout do Node)
async function dockerLogTail(inst, maxBytes = 256 * 1024) {
  const auth = await authHeader(inst);
  const scm = inst.scmUrl || `https://${inst.appName}.scm.azurewebsites.net`;
  const { status, json } = await requestJson(`${scm}/api/logs/docker`, {
    headers: { Authorization: auth },
    timeout: 45000,
  });
  if (status !== 200 || !Array.isArray(json)) {
    throw new Error(`Kudu /api/logs/docker devolveu HTTP ${status}`);
  }
  // Pega o log "default_docker" mais recente (é o stdout da aplicação)
  const candidates = json
    .filter((f) => /default_docker\.log$/i.test(f.path || f.href || ''))
    .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
  const target = candidates[0] || json[0];
  if (!target) return { file: null, content: '(nenhum arquivo de log encontrado)' };

  const res = await request(target.href, {
    headers: { Authorization: auth, Range: `bytes=-${maxBytes}` },
    timeout: 60000,
  });
  let buf = res.buffer;
  if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes); // servidor ignorou o Range
  let content = buf.toString('utf8');
  // Descarta a primeira linha possivelmente cortada ao meio
  const nl = content.indexOf('\n');
  if (buf.length >= maxBytes && nl > 0) content = content.slice(nl + 1);
  return {
    file: target.path || target.href,
    lastUpdated: target.lastUpdated,
    content,
  };
}

async function latestDeployment(inst) {
  const auth = await authHeader(inst);
  const scm = inst.scmUrl || `https://${inst.appName}.scm.azurewebsites.net`;
  const { status, json } = await requestJson(`${scm}/api/deployments/latest`, {
    headers: { Authorization: auth },
    timeout: 45000,
  });
  if (status !== 200) throw new Error(`Kudu /api/deployments/latest devolveu HTTP ${status}`);
  return json;
}

async function zipDeploy(inst, zipBuffer) {
  const auth = await authHeader(inst);
  const scm = inst.scmUrl || `https://${inst.appName}.scm.azurewebsites.net`;
  const res = await request(`${scm}/api/zipdeploy?isAsync=true`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/zip',
      'Content-Length': zipBuffer.length,
    },
    body: zipBuffer,
    timeout: 600000,
  });
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`zipdeploy devolveu HTTP ${res.status}: ${res.buffer.toString('utf8').slice(0, 300)}`);
  }
  return { accepted: true };
}

// Espera o deployment terminar. status 4 = sucesso, 3 = falha.
async function waitForDeployment(inst, { timeoutMs = 600000, onTick } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 8000));
    try {
      last = await latestDeployment(inst);
    } catch (err) {
      if (onTick) onTick(`(kudu instável, tentando de novo: ${err.message})`);
      continue;
    }
    if (onTick) onTick(`deployment: complete=${last.complete} status=${last.status} ${last.progress || ''}`);
    if (last.complete) {
      if (last.status === 4) return last;
      throw new Error(`Deploy falhou (status ${last.status}). Veja o log em ${inst.scmUrl}/api/deployments/latest/log`);
    }
  }
  throw new Error('Timeout esperando o deployment concluir.');
}

module.exports = { dockerLogTail, latestDeployment, zipDeploy, waitForDeployment };
