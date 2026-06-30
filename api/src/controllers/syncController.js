'use strict';
const db = require('../db/pool');

async function getSync(req, res) {
  try {
    const { rows } = await db.query('SELECT openai_key, preferred_model FROM ai_settings LIMIT 1');
    if (rows.length === 0) {
      return res.json({ openaiKey: null, openaiModel: 'gpt-4o-mini' });
    }
    return res.json({ openaiKey: rows[0].openai_key, openaiModel: rows[0].preferred_model });
  } catch (err) {
    console.error('[SYNC GET]', err);
    return res.status(500).json({ error: 'Erro ao buscar configurações de IA.' });
  }
}

async function postSync(req, res) {
  try {
    const { openaiKey, openaiModel } = req.body;

    const fields = [];
    const values = [];
    let counter = 1;
    if (openaiKey !== undefined) { fields.push(`openai_key = $${counter++}`); values.push(openaiKey); }
    if (openaiModel !== undefined) { fields.push(`preferred_model = $${counter++}`); values.push(openaiModel); }
    if (fields.length === 0) return res.json({ success: true });

    // Assuming exactly one row in ai_settings as seeded
    await db.query(`UPDATE ai_settings SET ${fields.join(', ')}`, values);

    return res.json({ success: true });
  } catch (err) {
    console.error('[SYNC POST]', err);
    return res.status(500).json({ error: 'Erro ao salvar configurações de IA.' });
  }
}

module.exports = {
  getSync,
  postSync
};
