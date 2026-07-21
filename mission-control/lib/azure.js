'use strict';
// Wrapper do Azure CLI. Todas as chamadas saem com
// AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1 por causa da interceptação TLS
// intermitente do AVG nesta máquina (ver playbook de deploy).
const { exec } = require('child_process');

const AZ_ENV = {
  ...process.env,
  AZURE_CLI_DISABLE_CONNECTION_VERIFICATION: '1',
};

function quote(arg) {
  // cmd.exe: aspas duplas em volta; aspas internas viram \" (suficiente para
  // os valores que passamos: nomes, connection strings, settings KEY=VALUE)
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function az(args, { timeout = 120000, json = true } = {}) {
  const cmd = ['az', ...args.map(quote), ...(json ? ['-o', 'json'] : [])].join(' ');
  return new Promise((resolve, reject) => {
    exec(cmd, { env: AZ_ENV, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || '').trim().split('\n').slice(0, 6).join('\n');
        return reject(new Error(`az ${args[0]} ${args[1] || ''} falhou: ${detail}`));
      }
      if (!json) return resolve(stdout.trim());
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch (parseErr) {
        reject(new Error(`az devolveu JSON inválido: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

async function listWebapps() {
  const apps = await az(['webapp', 'list', '--query',
    '[].{name:name, resourceGroup:resourceGroup, state:state, host:defaultHostName, location:location}']);
  return apps || [];
}

async function webappShow(name, rg) {
  return az(['webapp', 'show', '-n', name, '-g', rg, '--query',
    '{state:state, host:defaultHostName, linuxFx:siteConfig.linuxFxVersion, plan:appServicePlanId, location:location, startup:siteConfig.appCommandLine, lastModified:lastModifiedTimeUtc}']);
}

async function appsettingsList(name, rg) {
  const rows = await az(['webapp', 'config', 'appsettings', 'list', '-n', name, '-g', rg]);
  const map = {};
  for (const row of rows || []) map[row.name] = row.value;
  return map;
}

async function appsettingsSet(name, rg, settings) {
  const pairs = Object.entries(settings).map(([k, v]) => `${k}=${v}`);
  return az(['webapp', 'config', 'appsettings', 'set', '-n', name, '-g', rg, '--settings', ...pairs,
    '--query', '[].name']);
}

async function restart(name, rg) {
  return az(['webapp', 'restart', '-n', name, '-g', rg], { json: false });
}

async function createWebapp({ name, rg, plan, runtime = 'NODE:22-lts' }) {
  return az(['webapp', 'create', '-n', name, '-g', rg, '-p', plan, '--runtime', runtime,
    '--query', '{name:name, host:defaultHostName, state:state}'], { timeout: 300000 });
}

async function setStartupFile(name, rg, startupFile) {
  return az(['webapp', 'config', 'set', '-n', name, '-g', rg, '--startup-file', startupFile,
    '--query', 'appCommandLine'], { timeout: 180000 });
}

// Credenciais Kudu — cacheadas por app (mudam raramente)
const credsCache = new Map();
async function publishingCredentials(name, rg) {
  if (credsCache.has(name)) return credsCache.get(name);
  const creds = await az(['webapp', 'deployment', 'list-publishing-credentials', '-n', name, '-g', rg,
    '--query', '{user:publishingUserName, pass:publishingPassword}']);
  credsCache.set(name, creds);
  return creds;
}

async function listPlans() {
  return az(['appservice', 'plan', 'list', '--query',
    '[].{name:name, resourceGroup:resourceGroup, sku:sku.name, tier:sku.tier, location:location, apps:numberOfSites}']);
}

module.exports = {
  az, listWebapps, webappShow, appsettingsList, appsettingsSet,
  restart, createWebapp, setStartupFile, publishingCredentials, listPlans,
};
