'use strict';
// Registro local de instâncias (uma por empresa). Fica em data/instances.json,
// fora do git — contém DATABASE_URLs (segredos) de cada cliente.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'instances.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

function list() {
  return load();
}

function get(id) {
  return load().find((i) => i.id === id) || null;
}

function add(data) {
  const instances = load();
  if (instances.some((i) => i.appName === data.appName)) {
    throw new Error(`A instância "${data.appName}" já está registrada.`);
  }
  const inst = {
    id: crypto.randomBytes(6).toString('hex'),
    company: data.company,
    appName: data.appName,
    resourceGroup: data.resourceGroup,
    url: data.url || `https://${data.appName}.azurewebsites.net`,
    scmUrl: data.scmUrl || `https://${data.appName}.scm.azurewebsites.net`,
    dbUrl: data.dbUrl || null,
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
  };
  instances.push(inst);
  save(instances);
  return inst;
}

function update(id, patch) {
  const instances = load();
  const idx = instances.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error('Instância não encontrada.');
  const allowed = ['company', 'appName', 'resourceGroup', 'url', 'scmUrl', 'dbUrl', 'notes',
    'cnpj', 'contactName', 'contactEmail', 'contactPhone'];
  for (const key of allowed) {
    if (patch[key] !== undefined) instances[idx][key] = patch[key];
  }
  save(instances);
  return instances[idx];
}

function remove(id) {
  const instances = load();
  const idx = instances.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error('Instância não encontrada.');
  const [removed] = instances.splice(idx, 1);
  save(instances);
  return removed;
}

// Versão segura para mandar ao frontend (sem connection string completa)
function toPublic(inst) {
  const { dbUrl, ...rest } = inst;
  let dbHost = null;
  if (dbUrl) {
    const m = dbUrl.match(/@([^:/]+)/);
    dbHost = m ? m[1] : '(configurado)';
  }
  return { ...rest, hasDb: !!dbUrl, dbHost };
}

module.exports = { list, get, add, update, remove, toPublic };
