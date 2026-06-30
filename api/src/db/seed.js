'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./pool');

async function runMigrations() {
  console.log('Executando migrations...');
  const sqlPath = path.join(__dirname, 'migrations', '001_initial_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await db.query(sql);
  console.log('Migrations concluídas!');
}

async function seedData() {
  console.log('Inserindo dados padrão...');
  
  // Verifica se o manager padrão já existe
  const { rows } = await db.query('SELECT id FROM users WHERE email = $1', ['admin@salespulse.com.br']);
  if (rows.length === 0) {
    const passwordHash = await bcrypt.hash('mudar123', 10);
    await db.query(`
      INSERT INTO users (name, email, password_hash, role, status)
      VALUES ($1, $2, $3, 'manager', 'active')
    `, ['Gestor Inicial', 'admin@salespulse.com.br', passwordHash]);
    console.log('Gestor criado: admin@salespulse.com.br / mudar123');
  } else {
    console.log('Gestor inicial já existe.');
  }

  // Verifica ai_settings
  const { rows: aiRows } = await db.query('SELECT id FROM ai_settings');
  if (aiRows.length === 0) {
    await db.query(`INSERT INTO ai_settings (preferred_model) VALUES ('gpt-4o-mini')`);
    console.log('Configurações de IA criadas.');
  }

  console.log('Seed completo!');
}

async function main() {
  try {
    await runMigrations();
    await seedData();
  } catch (err) {
    console.error('Erro no seed:', err);
  } finally {
    process.exit(0);
  }
}

main();
