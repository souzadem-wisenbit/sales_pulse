'use strict';
const db = require('../db/pool');

// Converte a linha do banco para o formato camelCase que o frontend usa.
// IMPORTANTE: o POST também responde com este formato — o frontend insere a
// resposta direto no cache e re-renderiza; sem status/createdAt a sessão nova
// ficava invisível na tela até um refresh completo.
function formatRow(r) {
  return {
    ...r,
    sellerId: r.seller_id,
    clientId: r.client_id,
    showRealtime: r.show_realtime,
    showReport: r.show_report,
    salesApproach: r.sales_approach || 'active',
    sessionMode: r.session_mode || 'text',
    productIds: r.product_ids || [],
    scheduledAt: r.scheduled_at,
    doneAt: r.done_at,
    startedAt: r.started_at,
    createdAt: r.created_at,
    dueAt: r.due_at || null,
    notes: r.notes || '',
    responseTimeSec: r.response_time_sec || 0,
    messages: r.state?.messages || [],
    conviction: r.state?.conviction || 0,
    tricks: r.state?.tricks || 0,
    criteriaScores: r.state?.criteriaScores || null
  };
}

async function listScheduledSessions(req, res) {
  try {
    // Isolamento: gestor vê só sessões dos seus vendedores; vendedor só as suas
    let query = 'SELECT * FROM scheduled_sessions ORDER BY created_at DESC';
    let params = [];
    if (req.user.role === 'manager') {
      query = `SELECT s.* FROM scheduled_sessions s
               JOIN users u ON u.id = s.seller_id
               WHERE u.manager_id = $1 ORDER BY s.created_at DESC`;
      params = [req.user.id];
    } else if (req.user.role === 'seller') {
      query = 'SELECT * FROM scheduled_sessions WHERE seller_id = $1 ORDER BY created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await db.query(query, params);
    return res.json(rows.map(formatRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar sessoes agendadas' });
  }
}

async function createScheduledSession(req, res) {
  try {
    const data = req.body;
    const id = data.id || 'sched_' + Date.now();
    const { rows } = await db.query(`
      INSERT INTO scheduled_sessions (
        id, seller_id, client_id, status, show_realtime, show_report, sales_approach, product_ids, session_mode,
        due_at, notes, response_time_sec
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) RETURNING *
    `, [
      id, data.sellerId, data.clientId, data.status || 'pending',
      data.showRealtime ?? true, data.showReport ?? true, data.salesApproach || 'active',
      JSON.stringify(data.productIds || []),
      data.sessionMode === 'voice' ? 'voice' : 'text',
      data.dueAt || null, data.notes || null, data.responseTimeSec || 0
    ]);
    res.status(201).json(formatRow(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar sessao agendada' });
  }
}

async function updateScheduledSession(req, res) {
  try {
    const { id } = req.params;
    const data = req.body;
    
    // Allow partial updates
    const fields = [];
    const values = [];
    let counter = 1;
    
    if (data.status !== undefined) { fields.push(`status = $${counter++}`); values.push(data.status); }
    if (data.doneAt !== undefined) { fields.push(`done_at = $${counter++}`); values.push(data.doneAt); }
    if (data.startedAt !== undefined) { fields.push(`started_at = $${counter++}`); values.push(data.startedAt); }
    if (data.showRealtime !== undefined) { fields.push(`show_realtime = $${counter++}`); values.push(data.showRealtime); }
    if (data.showReport !== undefined) { fields.push(`show_report = $${counter++}`); values.push(data.showReport); }
    if (data.productIds !== undefined) { fields.push(`product_ids = $${counter++}`); values.push(JSON.stringify(data.productIds)); }
    
    // Save state containing messages, conviction, etc.
    if (data.messages || data.conviction !== undefined) {
      const stateObj = {
        messages: data.messages,
        conviction: data.conviction,
        tricks: data.tricks,
        criteriaScores: data.criteriaScores
      };
      fields.push(`state = $${counter++}`); values.push(stateObj);
    }

    if (fields.length === 0) return res.json({ success: true });
    
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    await db.query(`
      UPDATE scheduled_sessions SET
        ${fields.join(', ')}
      WHERE id = $${counter}
    `, values);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar sessao agendada' });
  }
}

async function deleteScheduledSession(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM scheduled_sessions WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir sessao agendada' });
  }
}

module.exports = { listScheduledSessions, createScheduledSession, updateScheduledSession, deleteScheduledSession };
