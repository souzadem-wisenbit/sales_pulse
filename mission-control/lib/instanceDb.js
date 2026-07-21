'use strict';
// Acesso direto ao Postgres (Supabase) de cada instância. Um pool por instância,
// criado sob demanda. SSL sem verificação — mesmo comportamento do app.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pools = new Map(); // instanceId -> Pool

function getPool(inst) {
  if (!inst.dbUrl) throw new Error(`Instância "${inst.company}" não tem DATABASE_URL configurada.`);
  if (!pools.has(inst.id)) {
    const pool = new Pool({
      connectionString: inst.dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (err) => console.error(`[DB ${inst.appName}]`, err.message));
    pools.set(inst.id, pool);
  }
  return pools.get(inst.id);
}

async function closePool(instanceId) {
  const pool = pools.get(instanceId);
  if (pool) {
    pools.delete(instanceId);
    await pool.end().catch(() => {});
  }
}

function q(inst, text, params) {
  return getPool(inst).query(text, params);
}

// Traduz erros comuns de conexão em orientação acionável (mostrada na UI).
function dbErrorHint(err) {
  const m = String((err && err.message) || '');
  if (/tenant\/user .* not found|Tenant or user not found/i.test(m)) {
    return 'O projeto Supabase deste banco está PAUSADO ou foi excluído — no plano free, o Supabase pausa após ~1 semana sem uso. Entre em https://supabase.com/dashboard, abra o projeto e clique em "Restore project". Depois use "Testar banco" na aba Config.';
  }
  if (/getaddrinfo ENOTFOUND db\./.test(m)) {
    return 'Esse host é a conexão DIRETA do Supabase (db.xxxx.supabase.co), que é IPv6-only e não funciona desta rede. Troque pela connection string do pooler (aws-1-….pooler.supabase.com:5432, Session mode).';
  }
  if (/getaddrinfo ENOTFOUND|EAI_AGAIN/.test(m)) {
    return 'O host do banco não resolveu no DNS — confira a connection string ou a sua internet.';
  }
  if (/password authentication failed/i.test(m)) {
    return 'A senha da connection string está incorreta.';
  }
  if (/timeout/i.test(m)) {
    return 'O banco não respondeu a tempo — pode estar iniciando, pausado ou bloqueado por firewall.';
  }
  return null;
}

async function testConnection(dbUrl) {
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 12000,
  });
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS users FROM users');
    return { ok: true, users: rows[0].users };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ===== Visão geral =====

const ONLINE_WINDOW = "interval '5 minutes'";

// Última atividade por usuário = maior entre login, última msg enviada no chat
// e última chamada Live Coach. É a base de "quem está online".
const LAST_ACTIVITY_CTE = `
  WITH msg AS (
    SELECT s.user_id, MAX(m.created_at) AS t
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'user'
    GROUP BY s.user_id
  ),
  lc AS (
    SELECT user_id, MAX(GREATEST(started_at, COALESCE(ended_at, started_at), created_at)) AS t
    FROM live_calls
    GROUP BY user_id
  ),
  activity AS (
    SELECT u.id, u.name, u.email, u.role, u.status, u.avatar_emoji, u.last_login_at,
      GREATEST(
        COALESCE(u.last_login_at, 'epoch'::timestamptz),
        COALESCE(msg.t, 'epoch'::timestamptz),
        COALESCE(lc.t, 'epoch'::timestamptz)
      ) AS last_activity,
      EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.user_id = u.id AND s.status = 'in_progress'
          AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id
                      AND m.created_at > NOW() - interval '10 minutes')
      ) AS in_training,
      EXISTS (
        SELECT 1 FROM live_calls c
        WHERE c.user_id = u.id AND c.ended_at IS NULL
          AND c.started_at > NOW() - interval '6 hours'
      ) AS in_live_call
    FROM users u
    LEFT JOIN msg ON msg.user_id = u.id
    LEFT JOIN lc ON lc.user_id = u.id
  )
`;

async function overview(inst) {
  const [counts, act, feed] = await Promise.all([
    q(inst, `
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users_total,
        (SELECT COUNT(*)::int FROM users WHERE role = 'seller') AS sellers,
        (SELECT COUNT(*)::int FROM users WHERE role = 'manager') AS managers,
        (SELECT COUNT(*)::int FROM users WHERE status <> 'active') AS users_inactive,
        (SELECT COUNT(*)::int FROM sessions) AS sessions_total,
        (SELECT COUNT(*)::int FROM sessions WHERE created_at >= date_trunc('day', NOW())) AS sessions_today,
        (SELECT COUNT(*)::int FROM sessions WHERE status = 'in_progress') AS sessions_open,
        (SELECT COUNT(*)::int FROM messages WHERE created_at >= date_trunc('day', NOW())) AS messages_today,
        (SELECT COUNT(*)::int FROM messages) AS messages_total,
        (SELECT COUNT(*)::int FROM live_calls) AS live_calls_total,
        (SELECT COUNT(*)::int FROM live_calls WHERE ended_at IS NULL AND started_at > NOW() - interval '6 hours') AS live_calls_active,
        (SELECT COUNT(*)::int FROM clients) AS clients_total,
        (SELECT COUNT(*)::int FROM scenarios) AS scenarios_total
    `),
    q(inst, `${LAST_ACTIVITY_CTE}
      SELECT * FROM activity ORDER BY last_activity DESC
    `),
    activityFeed(inst, 40),
  ]);

  const users = act.rows.map((u) => ({
    ...u,
    online: new Date(u.last_activity) > new Date(Date.now() - 5 * 60 * 1000),
  }));

  return {
    counts: counts.rows[0],
    online: users.filter((u) => u.online),
    users,
    feed,
  };
}

async function activityFeed(inst, limit = 40) {
  const { rows } = await q(inst, `
    SELECT * FROM (
      SELECT 'login' AS type, u.id AS user_id, u.name, u.avatar_emoji,
             u.last_login_at AS t, NULL AS detail, NULL AS ref_id
      FROM users u WHERE u.last_login_at IS NOT NULL
      UNION ALL
      SELECT 'session_start', s.user_id, u.name, u.avatar_emoji, s.created_at,
             sc.name, s.id::text
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN scenarios sc ON sc.id = s.scenario_id
      UNION ALL
      SELECT 'session_end', s.user_id, u.name, u.avatar_emoji, s.end_time,
             'convicção final ' || s.conviction_final, s.id::text
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.end_time IS NOT NULL
      UNION ALL
      SELECT 'live_call_start', c.user_id, u.name, u.avatar_emoji, c.started_at,
             NULL, c.id
      FROM live_calls c LEFT JOIN users u ON u.id = c.user_id
      UNION ALL
      SELECT 'live_call_end', c.user_id, u.name, u.avatar_emoji, c.ended_at,
             c.summary, c.id
      FROM live_calls c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.ended_at IS NOT NULL
    ) ev
    WHERE t IS NOT NULL
    ORDER BY t DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

// ===== Usuários =====

async function listUsers(inst) {
  const { rows } = await q(inst, `
    SELECT u.id, u.name, u.email, u.role, u.status, u.avatar_emoji,
           u.manager_id, m.name AS manager_name, u.created_at, u.last_login_at,
           (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id) AS sessions_count,
           (SELECT COUNT(*)::int FROM live_calls c WHERE c.user_id = u.id) AS live_calls_count
    FROM users u
    LEFT JOIN users m ON m.id = u.manager_id
    ORDER BY u.role, u.name
  `);
  return rows;
}

async function createUser(inst, { name, email, password, role, avatar_emoji, manager_id }) {
  const { rows: existing } = await q(inst, 'SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) throw new Error('E-mail já cadastrado nessa instância.');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q(inst, `
    INSERT INTO users (name, email, password_hash, role, avatar_emoji, manager_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, name, email, role, status, avatar_emoji, manager_id
  `, [name, email, hash, role || 'seller', avatar_emoji || '👤', manager_id || null]);
  return rows[0];
}

async function updateUser(inst, userId, patch) {
  const sets = [];
  const params = [];
  const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.email !== undefined) push('email', patch.email);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.role !== undefined) push('role', patch.role);
  if (patch.avatar_emoji !== undefined) push('avatar_emoji', patch.avatar_emoji);
  if (patch.manager_id !== undefined) push('manager_id', patch.manager_id || null);
  if (patch.password) {
    if (patch.password.length < 6) throw new Error('Senha precisa de pelo menos 6 caracteres.');
    push('password_hash', await bcrypt.hash(patch.password, 10));
  }
  if (sets.length === 0) throw new Error('Nada para atualizar.');

  params.push(userId);
  const { rows } = await q(inst, `
    UPDATE users SET ${sets.join(', ')}
    WHERE id = $${params.length}
    RETURNING id, name, email, role, status, avatar_emoji, manager_id
  `, params);
  if (rows.length === 0) throw new Error('Usuário não encontrado.');
  return rows[0];
}

async function deleteUser(inst, userId) {
  const { rowCount } = await q(inst, 'DELETE FROM users WHERE id = $1', [userId]);
  if (rowCount === 0) throw new Error('Usuário não encontrado.');
}

// ===== Conversas (sessões de treinamento) =====

async function listSessions(inst, { userId, limit = 100, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (userId) {
    params.push(userId);
    where = `WHERE s.user_id = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await q(inst, `
    SELECT s.id, s.user_id, s.status, s.conviction_final, s.duration_seconds,
           s.created_at, s.end_time,
           u.name AS user_name, u.avatar_emoji,
           sc.name AS scenario_name,
           (SELECT COUNT(*)::int FROM messages m WHERE m.session_id = s.id) AS msg_count,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id) AS last_msg_at
    FROM sessions s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN scenarios sc ON sc.id = s.scenario_id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return rows;
}

async function getSession(inst, sessionId) {
  const [head, msgs] = await Promise.all([
    q(inst, `
      SELECT s.*, u.name AS user_name, u.email AS user_email, u.avatar_emoji,
             sc.name AS scenario_name
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN scenarios sc ON sc.id = s.scenario_id
      WHERE s.id = $1
    `, [sessionId]),
    q(inst, `
      SELECT id, role, content, is_trick, trick_type, created_at
      FROM messages WHERE session_id = $1 ORDER BY created_at ASC
    `, [sessionId]),
  ]);
  if (head.rows.length === 0) throw new Error('Sessão não encontrada.');
  return { session: head.rows[0], messages: msgs.rows };
}

// ===== Live Coach =====

async function listLiveCalls(inst, { userId, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (userId) {
    params.push(userId);
    where = `WHERE c.user_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await q(inst, `
    SELECT c.id, c.user_id, c.started_at, c.ended_at, c.summary,
           u.name AS user_name, u.avatar_emoji,
           jsonb_array_length(COALESCE(c.transcript, '[]'::jsonb)) AS transcript_len,
           jsonb_array_length(COALESCE(c.tips, '[]'::jsonb)) AS tips_len
    FROM live_calls c
    LEFT JOIN users u ON u.id = c.user_id
    ${where}
    ORDER BY c.started_at DESC
    LIMIT $${params.length}
  `, params);
  return rows;
}

async function getLiveCall(inst, callId) {
  const { rows } = await q(inst, `
    SELECT c.*, u.name AS user_name, u.email AS user_email, u.avatar_emoji
    FROM live_calls c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = $1
  `, [callId]);
  if (rows.length === 0) throw new Error('Chamada não encontrada.');
  return rows[0];
}

// ===== CRUD genérico por whitelist de colunas =====
// Colunas jsonb precisam de JSON.stringify (node-pg mandaria array JS como
// array Postgres, que não é o que essas colunas guardam).

function buildValues(patch, allowed, jsonbCols) {
  const cols = [];
  const vals = [];
  for (const col of allowed) {
    if (patch[col] === undefined) continue;
    cols.push(col);
    vals.push(jsonbCols.includes(col) ? JSON.stringify(patch[col]) : patch[col]);
  }
  return { cols, vals };
}

async function genericInsert(inst, table, id, patch, allowed, jsonbCols) {
  const { cols, vals } = buildValues(patch, allowed, jsonbCols);
  const allCols = ['id', ...cols];
  const placeholders = allCols.map((_, i) => `$${i + 1}`);
  const { rows } = await q(inst, `
    INSERT INTO ${table} (${allCols.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, [id, ...vals]);
  return rows[0];
}

async function genericUpdate(inst, table, id, patch, allowed, jsonbCols) {
  const { cols, vals } = buildValues(patch, allowed, jsonbCols);
  if (cols.length === 0) throw new Error('Nada para atualizar.');
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  sets.push('updated_at = NOW()');
  vals.push(id);
  const { rows } = await q(inst, `
    UPDATE ${table} SET ${sets.join(', ')}
    WHERE id = $${vals.length}
    RETURNING *
  `, vals);
  if (rows.length === 0) throw new Error('Registro não encontrado.');
  return rows[0];
}

async function genericDelete(inst, table, id) {
  const { rowCount } = await q(inst, `DELETE FROM ${table} WHERE id = $1`, [id]);
  if (rowCount === 0) throw new Error('Registro não encontrado.');
}

// ===== Clientes (personas de treinamento) =====

const CLIENT_COLS = [
  'name', 'emoji', 'difficulty', 'description', 'humanidade', 'formalidade',
  'nivel_erros', 'nivel_girias', 'emotividade', 'objetividade', 'sotaque_regiao',
  'velocidade_resposta', 'nivel_tecnico', 'usa_abreviacoes', 'usa_maiusculas',
  'usa_emojis', 'faz_perguntas', 'skepticism', 'urgency', 'price_sensitivity',
  'product_knowledge', 'negotiation_will', 'trick_frequency', 'trick_types',
  'vendedores_atribuidos', 'archetype', 'hidden_agenda', 'market_segment',
  'hostile_mode', 'hostile_competitors', 'session_constraints', 'custom_behavior',
  'manager_id',
];
const CLIENT_JSONB = ['trick_types', 'vendedores_atribuidos', 'hostile_competitors', 'session_constraints'];

async function listClients(inst) {
  const { rows } = await q(inst, `
    SELECT c.*, m.name AS manager_name,
      (SELECT COUNT(*)::int FROM scheduled_sessions ss WHERE ss.client_id = c.id) AS scheduled_count
    FROM clients c LEFT JOIN users m ON m.id = c.manager_id
    ORDER BY c.created_at DESC
  `);
  return rows;
}
const createClient = (inst, patch) =>
  genericInsert(inst, 'clients', 'cli_' + Date.now(), patch, CLIENT_COLS, CLIENT_JSONB);
const updateClient = (inst, id, patch) =>
  genericUpdate(inst, 'clients', id, patch, CLIENT_COLS, CLIENT_JSONB);
const deleteClient = (inst, id) => genericDelete(inst, 'clients', id);

// ===== Produtos =====

const PRODUCT_COLS = ['name', 'price', 'description', 'benefits', 'objections',
  'clientes_atribuidos', 'vendedores_atribuidos', 'manager_id'];
const PRODUCT_JSONB = ['benefits', 'objections', 'clientes_atribuidos', 'vendedores_atribuidos'];

async function listProducts(inst) {
  const { rows } = await q(inst, `
    SELECT p.*, m.name AS manager_name
    FROM products p LEFT JOIN users m ON m.id = p.manager_id
    ORDER BY p.created_at DESC
  `);
  return rows;
}
const createProduct = (inst, patch) =>
  genericInsert(inst, 'products', 'prod_' + Date.now(), patch, PRODUCT_COLS, PRODUCT_JSONB);
const updateProduct = (inst, id, patch) =>
  genericUpdate(inst, 'products', id, patch, PRODUCT_COLS, PRODUCT_JSONB);
const deleteProduct = (inst, id) => genericDelete(inst, 'products', id);

// ===== Sessões agendadas =====

const SCHED_COLS = ['seller_id', 'client_id', 'status', 'show_realtime', 'show_report',
  'scheduled_at', 'done_at', 'sales_approach', 'product_ids', 'session_mode'];
const SCHED_JSONB = ['product_ids'];

async function listScheduled(inst) {
  const { rows } = await q(inst, `
    SELECT ss.*, u.name AS seller_name, u.avatar_emoji, c.name AS client_name, c.emoji AS client_emoji
    FROM scheduled_sessions ss
    LEFT JOIN users u ON u.id = ss.seller_id
    LEFT JOIN clients c ON c.id = ss.client_id
    ORDER BY ss.scheduled_at DESC
  `);
  return rows;
}
const createScheduled = (inst, patch) =>
  genericInsert(inst, 'scheduled_sessions', 'sched_' + Date.now(), patch, SCHED_COLS, SCHED_JSONB);
const updateScheduled = (inst, id, patch) =>
  genericUpdate(inst, 'scheduled_sessions', id, patch, SCHED_COLS, SCHED_JSONB);
const deleteScheduled = (inst, id) => genericDelete(inst, 'scheduled_sessions', id);

// ===== Exclusão de sessão de treinamento (mensagens caem em cascata) =====

async function deleteSession(inst, sessionId) {
  const { rowCount } = await q(inst, 'DELETE FROM sessions WHERE id = $1', [sessionId]);
  if (rowCount === 0) throw new Error('Sessão não encontrada.');
}

// ===== Config da instância (ai_settings) =====

async function aiSettings(inst) {
  const { rows } = await q(inst, 'SELECT openai_key, preferred_model, monthly_token_limit FROM ai_settings LIMIT 1');
  if (rows.length === 0) return { configured: false };
  const key = rows[0].openai_key || '';
  return {
    configured: !!key,
    keyMasked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    preferred_model: rows[0].preferred_model,
    monthly_token_limit: rows[0].monthly_token_limit,
  };
}

module.exports = {
  getPool, closePool, q, testConnection, dbErrorHint,
  overview, activityFeed,
  listUsers, createUser, updateUser, deleteUser,
  listSessions, getSession, deleteSession,
  listLiveCalls, getLiveCall,
  listClients, createClient, updateClient, deleteClient,
  listProducts, createProduct, updateProduct, deleteProduct,
  listScheduled, createScheduled, updateScheduled, deleteScheduled,
  aiSettings,
};
