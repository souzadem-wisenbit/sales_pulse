'use strict';
const db = require('../db/pool');

async function listScenarios(req, res) {
  try {
    const { rows } = await db.query('SELECT * FROM scenarios ORDER BY created_at DESC');
    return res.json(rows);
  } catch (err) {
    console.error('[SCENARIOS]', err);
    return res.status(500).json({ error: 'Erro ao listar cenários.' });
  }
}

async function createScenario(req, res) {
  const { name, industry, description, difficulty, passing_score, max_minutes, config } = req.body;
  try {
    const { rows } = await db.query(`
      INSERT INTO scenarios (name, industry, description, difficulty, passing_score, max_minutes, config)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [name, industry, description, difficulty, passing_score, max_minutes, config]);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[SCENARIOS]', err);
    return res.status(500).json({ error: 'Erro ao criar cenário.' });
  }
}

async function updateScenario(req, res) {
  const { id } = req.params;
  const { name, industry, description, difficulty, passing_score, max_minutes, config, is_active } = req.body;
  
  try {
    const { rows } = await db.query(`
      UPDATE scenarios 
      SET name = COALESCE($1, name),
          industry = COALESCE($2, industry),
          description = COALESCE($3, description),
          difficulty = COALESCE($4, difficulty),
          passing_score = COALESCE($5, passing_score),
          max_minutes = COALESCE($6, max_minutes),
          config = COALESCE($7, config),
          is_active = COALESCE($8, is_active),
          updated_at = NOW()
      WHERE id = $9
      RETURNING *
    `, [name, industry, description, difficulty, passing_score, max_minutes, config, is_active, id]);
    
    if (rows.length === 0) return res.status(404).json({ error: 'Cenário não encontrado.' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[SCENARIOS]', err);
    return res.status(500).json({ error: 'Erro ao atualizar cenário.' });
  }
}

module.exports = { listScenarios, createScenario, updateScenario };
