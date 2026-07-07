'use strict';
// Carrega api/.env por caminho explícito para funcionar de qualquer diretório
// (ex: `node api/src/server.js` da raiz). No Azure, as App Settings prevalecem.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
// SSL sempre que o banco não for local (Supabase/Azure exigem; localhost não usa)
const isLocalDb = /localhost|127\.0\.0\.1/.test(connectionString || '');

const pool = new Pool({
  connectionString,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[DB] Erro inesperado no pool do Postgres', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
