'use strict';
// Provisionamento de uma nova instância (nova empresa):
//   1. cria o Web App no Azure (mesmo plano/runtime da instância base)
//   2. configura App Settings (DATABASE_URL, JWT_SECRET novo, NODE_ENV)
//   3. roda as migrations no banco novo (Supabase criado manualmente)
//   4. cria o gestor inicial + ai_settings
//   5. empacota o código atual (staging em C:\dtmp, zip via Python — nunca
//      Compress-Archive, que grava '\' e quebra o build Linux)
//   6. zipdeploy via Kudu e espera concluir
//   7. health check e registro no painel
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const azure = require('./azure');
const kudu = require('./kudu');
const registry = require('./registry');
const { requestJson } = require('./http');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STAGE_ROOT = 'C:\\dtmp';

const jobs = new Map(); // jobId -> job

function createJob(input) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    input,
    status: 'running', // running | done | failed
    error: null,
    result: null,
    steps: [],
    emitter: new EventEmitter(),
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  run(job).catch(() => {});
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    result: job.result,
    steps: job.steps.map((s) => ({ name: s.name, status: s.status, lines: s.lines })),
    startedAt: job.startedAt,
  };
}

function emit(job) {
  job.emitter.emit('update', snapshot(job));
}

function step(job, name) {
  const s = { name, status: 'running', lines: [] };
  job.steps.push(s);
  emit(job);
  return {
    log(line) {
      s.lines.push(String(line));
      emit(job);
    },
    done() {
      s.status = 'done';
      emit(job);
    },
    fail(err) {
      s.status = 'failed';
      s.lines.push(`ERRO: ${err.message}`);
      emit(job);
    },
  };
}

async function run(job) {
  const inp = job.input;
  try {
    // ---- 1. Web App ----
    let s = step(job, `Criar Web App "${inp.appName}" no Azure`);
    try {
      const created = await azure.createWebapp({
        name: inp.appName,
        rg: inp.resourceGroup,
        plan: inp.plan,
      });
      s.log(`Web App criado: ${created.host}`);
      await azure.setStartupFile(inp.appName, inp.resourceGroup, 'node api/src/server.js');
      s.log('Startup command: node api/src/server.js');
      s.done();
    } catch (err) { s.fail(err); throw err; }

    // ---- 2. App Settings ----
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    s = step(job, 'Configurar App Settings');
    try {
      await azure.appsettingsSet(inp.appName, inp.resourceGroup, {
        DATABASE_URL: inp.dbUrl,
        JWT_SECRET: jwtSecret,
        NODE_ENV: 'production',
        SCM_DO_BUILD_DURING_DEPLOYMENT: 'false',
        WEBSITE_HTTPLOGGING_RETENTION_DAYS: '3',
      });
      s.log('DATABASE_URL, JWT_SECRET (gerado), NODE_ENV, SCM_DO_BUILD, HTTPLOGGING definidos');
      s.done();
    } catch (err) { s.fail(err); throw err; }

    // ---- 3. Migrations ----
    s = step(job, 'Rodar migrations no banco novo');
    const pool = new Pool({
      connectionString: inp.dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 20000,
    });
    try {
      const dir = path.join(REPO_ROOT, 'api', 'src', 'db', 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        await pool.query(sql);
        s.log(`✓ ${file}`);
      }
      s.done();
    } catch (err) { s.fail(err); await pool.end().catch(() => {}); throw err; }

    // ---- 4. Seed ----
    s = step(job, 'Criar gestor inicial e configurações de IA');
    try {
      const hash = await bcrypt.hash(inp.adminPassword, 10);
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [inp.adminEmail]);
      if (rows.length === 0) {
        await pool.query(`
          INSERT INTO users (name, email, password_hash, role, status)
          VALUES ($1, $2, $3, 'manager', 'active')
        `, [inp.adminName || 'Gestor', inp.adminEmail, hash]);
        s.log(`Gestor criado: ${inp.adminEmail}`);
      } else {
        s.log(`Gestor ${inp.adminEmail} já existia — mantido.`);
      }
      const { rows: ai } = await pool.query('SELECT id FROM ai_settings');
      if (ai.length === 0) {
        await pool.query(
          `INSERT INTO ai_settings (openai_key, preferred_model) VALUES ($1, 'gpt-4o-mini')`,
          [inp.openaiKey || null]
        );
        s.log(`ai_settings criado ${inp.openaiKey ? 'com chave OpenAI' : 'sem chave (definir depois no painel do app)'}`);
      } else if (inp.openaiKey) {
        await pool.query('UPDATE ai_settings SET openai_key = $1', [inp.openaiKey]);
        s.log('Chave OpenAI atualizada em ai_settings.');
      }
      s.done();
    } catch (err) { s.fail(err); throw err; }
    finally { await pool.end().catch(() => {}); }

    // ---- 5. Empacotar código ----
    s = step(job, 'Empacotar o código atual (staging + zip)');
    let zipPath;
    try {
      zipPath = await buildZip(s);
      const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
      s.log(`Zip pronto: ${zipPath} (${sizeMb} MB)`);
      s.done();
    } catch (err) { s.fail(err); throw err; }

    // ---- 6. Deploy ----
    const inst = {
      appName: inp.appName,
      resourceGroup: inp.resourceGroup,
      scmUrl: `https://${inp.appName}.scm.azurewebsites.net`,
    };
    s = step(job, 'Deploy (Kudu zipdeploy)');
    try {
      const zipBuffer = fs.readFileSync(zipPath);
      await kudu.zipDeploy(inst, zipBuffer);
      s.log('Zip aceito (HTTP 202). Aguardando build/extract...');
      await kudu.waitForDeployment(inst, { onTick: (m) => s.log(m) });
      s.log('Deployment concluído com sucesso (status 4).');
      s.done();
    } catch (err) { s.fail(err); throw err; }

    // ---- 7. Health check ----
    const url = `https://${inp.appName}.azurewebsites.net`;
    s = step(job, 'Health check (cold start pode demorar)');
    try {
      let healthy = false;
      for (let i = 0; i < 20; i++) {
        try {
          const { status, json } = await requestJson(`${url}/api/health`, { timeout: 20000 });
          if (status === 200 && json && json.status === 'ok') { healthy = true; break; }
          s.log(`tentativa ${i + 1}: HTTP ${status}`);
        } catch (err) {
          s.log(`tentativa ${i + 1}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 10000));
      }
      if (!healthy) throw new Error(`/api/health não respondeu ok. Verifique os logs em ${inst.scmUrl}`);
      s.log(`${url}/api/health → ok`);
      s.done();
    } catch (err) { s.fail(err); throw err; }

    // ---- 8. Registrar no painel ----
    s = step(job, 'Registrar instância no Mission Control');
    const created = registry.add({
      company: inp.company,
      appName: inp.appName,
      resourceGroup: inp.resourceGroup,
      dbUrl: inp.dbUrl,
      notes: inp.notes || `Provisionada pelo Mission Control em ${new Date().toLocaleDateString('pt-BR')}`,
    });
    s.log(`Instância "${inp.company}" registrada.`);
    s.done();

    job.result = {
      instanceId: created.id,
      url,
      adminEmail: inp.adminEmail,
    };
    job.status = 'done';
    emit(job);
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    emit(job);
  }
}

// Copia o app para C:\dtmp\mc_stage e zipa com Python (zipfile normaliza os
// separadores). Mesma lista de arquivos do playbook de deploy, exceto api/.env:
// a instância nova usa App Settings, e o .env local aponta pro banco da base.
const DEPLOY_ITEMS = [
  'api/package.json',
  'api/package-lock.json',
  'api/src',
  'api/node_modules',
  'css',
  'js',
  'img',
  'index.html',
  'testlab.html',
  'package.json',
  'package-lock.json',
];

async function buildZip(s) {
  const stageDir = path.join(STAGE_ROOT, 'mc_stage');
  const zipPath = path.join(STAGE_ROOT, 'mc_deploy.zip');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  for (const item of DEPLOY_ITEMS) {
    const src = path.join(REPO_ROOT, item);
    if (!fs.existsSync(src)) {
      s.log(`(aviso) ${item} não existe — pulado`);
      continue;
    }
    const dest = path.join(stageDir, item);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    s.log(`copiado: ${item}`);
  }

  const pyScript = path.join(STAGE_ROOT, 'mc_zip.py');
  fs.writeFileSync(pyScript, [
    'import os, sys, zipfile',
    'stage, out = sys.argv[1], sys.argv[2]',
    "zf = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)",
    'count = 0',
    'for root, dirs, files in os.walk(stage):',
    '    for f in files:',
    '        full = os.path.join(root, f)',
    "        arc = os.path.relpath(full, stage).replace('\\\\', '/')",
    '        zf.write(full, arc)',
    '        count += 1',
    'zf.close()',
    'print(count)',
  ].join('\n'), 'utf8');

  const count = await new Promise((resolve, reject) => {
    execFile('python', [pyScript, stageDir, zipPath],
      { timeout: 600000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`python zip falhou: ${(stderr || err.message).slice(0, 300)}`));
        resolve(stdout.trim());
      });
  });
  s.log(`${count} arquivos zipados`);
  return zipPath;
}

module.exports = { createJob, getJob, snapshot };
