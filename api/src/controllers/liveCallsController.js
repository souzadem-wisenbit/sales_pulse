'use strict';
const db = require('../db/pool');

function isManager(user) {
  return ['manager', 'superadmin'].includes(user.role);
}

// ── Live Calls ──

async function listLiveCalls(req, res) {
  try {
    const base = `
      SELECT c.id, c.user_id, c.started_at, c.ended_at, c.summary,
             jsonb_array_length(c.transcript) AS segments,
             jsonb_array_length(c.tips) AS tip_count,
             u.name AS user_name
      FROM live_calls c LEFT JOIN users u ON u.id = c.user_id`;
    const { rows } = isManager(req.user)
      ? await db.query(`${base} ORDER BY c.started_at DESC LIMIT 200`)
      : await db.query(`${base} WHERE c.user_id = $1 ORDER BY c.started_at DESC LIMIT 200`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('[LIVE_CALLS LIST]', err);
    res.status(500).json({ error: 'Erro ao listar chamadas' });
  }
}

async function getLiveCall(req, res) {
  try {
    const { rows } = await db.query('SELECT * FROM live_calls WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Chamada não encontrada' });
    const call = rows[0];
    if (!isManager(req.user) && call.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    res.json(call);
  } catch (err) {
    console.error('[LIVE_CALLS GET]', err);
    res.status(500).json({ error: 'Erro ao buscar chamada' });
  }
}

async function createLiveCall(req, res) {
  try {
    const id = 'call_' + Date.now();
    await db.query('INSERT INTO live_calls (id, user_id) VALUES ($1, $2)', [id, req.user.id]);
    res.status(201).json({ id });
  } catch (err) {
    console.error('[LIVE_CALLS CREATE]', err);
    res.status(500).json({ error: 'Erro ao criar chamada' });
  }
}

async function updateLiveCall(req, res) {
  try {
    const { id } = req.params;
    const { rows } = await db.query('SELECT user_id FROM live_calls WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Chamada não encontrada' });
    if (!isManager(req.user) && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const data = req.body;
    const fields = [];
    const values = [];
    let c = 1;
    if (data.transcript !== undefined) { fields.push(`transcript = $${c++}`); values.push(JSON.stringify(data.transcript)); }
    if (data.tips !== undefined) { fields.push(`tips = $${c++}`); values.push(JSON.stringify(data.tips)); }
    if (data.summary !== undefined) { fields.push(`summary = $${c++}`); values.push(data.summary); }
    if (data.endedAt !== undefined) { fields.push(`ended_at = $${c++}`); values.push(data.endedAt); }
    if (fields.length === 0) return res.json({ success: true });

    values.push(id);
    await db.query(`UPDATE live_calls SET ${fields.join(', ')} WHERE id = $${c}`, values);
    res.json({ success: true });
  } catch (err) {
    console.error('[LIVE_CALLS UPDATE]', err);
    res.status(500).json({ error: 'Erro ao atualizar chamada' });
  }
}

// ── Seller Profiles (perfil aprendido pela IA) ──

async function listProfiles(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT p.user_id, p.profile, p.calls_analyzed, p.updated_at, u.name, u.email
      FROM seller_profiles p JOIN users u ON u.id = p.user_id
      ORDER BY p.updated_at DESC`);
    res.json(rows);
  } catch (err) {
    console.error('[LIVE_PROFILES LIST]', err);
    res.status(500).json({ error: 'Erro ao listar perfis' });
  }
}

async function getProfile(req, res) {
  try {
    const { userId } = req.params;
    if (!isManager(req.user) && req.user.id !== userId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const { rows } = await db.query('SELECT * FROM seller_profiles WHERE user_id = $1', [userId]);
    res.json(rows[0] || { user_id: userId, profile: {}, calls_analyzed: 0 });
  } catch (err) {
    console.error('[LIVE_PROFILES GET]', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
}

async function upsertProfile(req, res) {
  try {
    const { userId } = req.params;
    if (!isManager(req.user) && req.user.id !== userId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const profile = req.body.profile || {};
    await db.query(`
      INSERT INTO seller_profiles (user_id, profile, calls_analyzed, updated_at)
      VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE
        SET profile = $2,
            calls_analyzed = seller_profiles.calls_analyzed + 1,
            updated_at = CURRENT_TIMESTAMP
    `, [userId, JSON.stringify(profile)]);
    res.json({ success: true });
  } catch (err) {
    console.error('[LIVE_PROFILES UPSERT]', err);
    res.status(500).json({ error: 'Erro ao salvar perfil' });
  }
}

module.exports = { listLiveCalls, getLiveCall, createLiveCall, updateLiveCall, listProfiles, getProfile, upsertProfile };
