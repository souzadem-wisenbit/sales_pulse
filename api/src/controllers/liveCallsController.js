'use strict';
const db = require('../db/pool');

function isManager(user) {
  return ['manager', 'superadmin'].includes(user.role);
}

// ── Live Calls ──

async function listLiveCalls(req, res) {
  try {
    const base = `
      SELECT c.id, c.user_id, c.started_at, c.ended_at, c.summary, c.briefing,
             c.channel, c.contact_name,
             jsonb_array_length(c.transcript) AS segments,
             jsonb_array_length(c.tips) AS tip_count,
             u.name AS user_name
      FROM live_calls c LEFT JOIN users u ON u.id = c.user_id`;
    let rows;
    if (req.user.role === 'superadmin') {
      ({ rows } = await db.query(`${base} ORDER BY c.started_at DESC LIMIT 200`));
    } else if (req.user.role === 'manager') {
      // Gestor vê apenas chamadas dos SEUS vendedores (e as dele próprio)
      ({ rows } = await db.query(`${base} WHERE u.manager_id = $1 OR c.user_id = $1 ORDER BY c.started_at DESC LIMIT 200`, [req.user.id]));
    } else {
      ({ rows } = await db.query(`${base} WHERE c.user_id = $1 ORDER BY c.started_at DESC LIMIT 200`, [req.user.id]));
    }
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
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const briefing = req.body?.briefing || {};
    // 'whatsapp' = conversa de texto do WhatsApp Coach; 'audio' = chamada real
    const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'audio';
    const contactName = (req.body?.contactName || null) && String(req.body.contactName).slice(0, 120);
    await db.query(
      'INSERT INTO live_calls (id, user_id, briefing, channel, contact_name) VALUES ($1, $2, $3, $4, $5)',
      [id, req.user.id, JSON.stringify(briefing), channel, contactName]
    );
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
    // Gestor vê apenas perfis dos SEUS vendedores; superadmin vê todos
    const base = `
      SELECT p.user_id, p.profile, p.calls_analyzed, p.trainings_analyzed, p.updated_at, u.name, u.email, u.coach_id
      FROM seller_profiles p JOIN users u ON u.id = p.user_id`;
    const { rows } = req.user.role === 'superadmin'
      ? await db.query(`${base} ORDER BY p.updated_at DESC`)
      : await db.query(`${base} WHERE u.manager_id = $1 ORDER BY p.updated_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('[LIVE_PROFILES LIST]', err);
    res.status(500).json({ error: 'Erro ao listar perfis' });
  }
}

// Verifica se o gestor é dono do vendedor (superadmin sempre pode)
async function canAccessSeller(reqUser, sellerId) {
  if (reqUser.role === 'superadmin') return true;
  if (reqUser.id === sellerId) return true;
  if (reqUser.role !== 'manager') return false;
  const { rows } = await db.query('SELECT manager_id FROM users WHERE id = $1', [sellerId]);
  return rows.length > 0 && rows[0].manager_id === reqUser.id;
}

async function getProfile(req, res) {
  try {
    const { userId } = req.params;
    if (!(await canAccessSeller(req.user, userId))) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const { rows } = await db.query('SELECT * FROM seller_profiles WHERE user_id = $1', [userId]);
    const result = rows[0] || { user_id: userId, profile: {}, calls_analyzed: 0 };

    // Resolve o coach atribuído ao vendedor (usado para personalizar as dicas).
    // Sem atribuição, o coach padrão da ferramenta é o Júnior Smarzaro.
    const { rows: urows } = await db.query('SELECT coach_id FROM users WHERE id = $1', [userId]);
    const coachId = urows[0]?.coach_id || null;
    if (coachId === 'junior' || !coachId) {
      result.coach = { id: 'junior', name: 'Júnior Smarzaro', special: true };
    } else if (coachId) {
      const { rows: crows } = await db.query(`
        SELECT u.name, p.profile FROM users u
        LEFT JOIN seller_profiles p ON p.user_id = u.id
        WHERE u.id = $1`, [coachId]);
      if (crows.length > 0) {
        result.coach = { id: coachId, name: crows[0].name, profile: crows[0].profile || {} };
      }
    }
    res.json(result);
  } catch (err) {
    console.error('[LIVE_PROFILES GET]', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
}

// Atribui um coach a um vendedor: null (padrão) | 'junior' | UUID de outro vendedor
async function assignCoach(req, res) {
  try {
    const { userId } = req.params;
    if (req.user.role === 'seller') return res.status(403).json({ error: 'Apenas gestores atribuem coach' });
    if (!(await canAccessSeller(req.user, userId))) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const coachId = req.body.coachId || null;
    if (coachId && coachId !== 'junior') {
      // Coach baseado em outro vendedor: precisa ser acessível a este gestor
      if (!(await canAccessSeller(req.user, coachId))) {
        return res.status(403).json({ error: 'Coach inválido' });
      }
    }
    await db.query('UPDATE users SET coach_id = $1 WHERE id = $2', [coachId, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[LIVE_PROFILES COACH]', err);
    res.status(500).json({ error: 'Erro ao atribuir coach' });
  }
}

async function upsertProfile(req, res) {
  try {
    const { userId } = req.params;
    if (!isManager(req.user) && req.user.id !== userId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const profile = req.body.profile || {};
    // Evento de aprendizado: chamada real ('live') ou treinamento ('training').
    // Alimenta o histórico cumulativo (limitado aos 40 mais recentes).
    const event = req.body.event || null;
    const source = event?.source === 'training' ? 'training' : 'live';

    const { rows } = await db.query('SELECT history, calls_analyzed, trainings_analyzed FROM seller_profiles WHERE user_id = $1', [userId]);
    const existing = rows[0] || { history: [], calls_analyzed: 0, trainings_analyzed: 0 };
    const history = Array.isArray(existing.history) ? existing.history : [];
    if (event) history.push({ ...event, t: event.t || new Date().toISOString() });
    const cappedHistory = history.slice(-40);
    const calls = (existing.calls_analyzed || 0) + (event && source === 'live' ? 1 : 0);
    const trainings = (existing.trainings_analyzed || 0) + (event && source === 'training' ? 1 : 0);

    await db.query(`
      INSERT INTO seller_profiles (user_id, profile, history, calls_analyzed, trainings_analyzed, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE
        SET profile = $2, history = $3, calls_analyzed = $4, trainings_analyzed = $5, updated_at = CURRENT_TIMESTAMP
    `, [userId, JSON.stringify(profile), JSON.stringify(cappedHistory), calls, trainings]);
    res.json({ success: true });
  } catch (err) {
    console.error('[LIVE_PROFILES UPSERT]', err);
    res.status(500).json({ error: 'Erro ao salvar perfil' });
  }
}

module.exports = { listLiveCalls, getLiveCall, createLiveCall, updateLiveCall, listProfiles, getProfile, upsertProfile, assignCoach };
