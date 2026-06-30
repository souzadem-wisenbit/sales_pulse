'use strict';
const db = require('../db/pool');

async function getSync(req, res) {
  try {
    const { rows } = await db.query('SELECT frontend_state FROM ai_settings LIMIT 1');
    if (rows.length === 0) {
      return res.json({ state: '{}' });
    }
    return res.json({ state: rows[0].frontend_state });
  } catch (err) {
    console.error('[SYNC GET]', err);
    return res.status(500).json({ error: 'Erro ao buscar estado da aplicação.' });
  }
}

async function postSync(req, res) {
  try {
    const { state } = req.body;
    if (!state) return res.status(400).json({ error: 'Nenhum estado fornecido.' });

    // Assuming exactly one row in ai_settings as seeded
    await db.query(`
      UPDATE ai_settings 
      SET frontend_state = $1
    `, [state]);

    return res.json({ success: true });
  } catch (err) {
    console.error('[SYNC POST]', err);
    return res.status(500).json({ error: 'Erro ao salvar estado da aplicação.' });
  }
}

module.exports = {
  getSync,
  postSync
};
