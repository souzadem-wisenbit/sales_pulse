'use strict';
const db = require('../db/pool');
const bcrypt = require('bcryptjs');

async function listUsers(req, res) {
  try {
    let query = `
      SELECT id, name, email, role, status, avatar_emoji, manager_id, coach_id, created_at, last_login_at
      FROM users
    `;
    const params = [];
    if (req.user.role === 'manager') {
      query += ` WHERE role = 'seller' AND manager_id = $1 `;
      params.push(req.user.id);
    } else if (req.user.role === 'seller') {
      // Vendedor só enxerga o próprio registro
      query += ` WHERE id = $1 `;
      params.push(req.user.id);
    }
    query += ` ORDER BY name ASC`;
    const { rows } = await db.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('[USERS]', err);
    return res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
}

async function createUser(req, res) {
  const { name, email, password, role, avatar_emoji, manager_id } = req.body;

  if ((role === 'manager' || role === 'superadmin') && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas super administradores podem criar gestores.' });
  }

  // Se for manager criando seller, força o manager_id para ser o dele mesmo
  let finalManagerId = manager_id;
  if (req.user.role === 'manager' && role === 'seller') {
    finalManagerId = req.user.id;
  }

  try {
    const { rows: existing } = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await db.query(`
      INSERT INTO users (name, email, password_hash, role, avatar_emoji, manager_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, email, role, status, avatar_emoji, manager_id
    `, [name, email, hash, role, avatar_emoji, finalManagerId || null]);

    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[USERS]', err);
    return res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
}

async function updateUser(req, res) {
  const { id } = req.params;
  const { name, email, password, avatar_emoji, status, manager_id } = req.body;

  try {
    let passwordClause = '';
    const params = [name, email, avatar_emoji, status, manager_id || null];

    if (password && password.length >= 6) {
      const hash = await bcrypt.hash(password, 10);
      passwordClause = ', password_hash = $6';
      params.push(hash);
    }

    const idParam = `$${params.length + 1}`;
    params.push(id);

    const { rows } = await db.query(`
      UPDATE users 
      SET name = COALESCE($1, name), 
          email = COALESCE($2, email),
          avatar_emoji = COALESCE($3, avatar_emoji),
          status = COALESCE($4, status),
          manager_id = COALESCE($5, manager_id)
          ${passwordClause}
      WHERE id = ${idParam}
      RETURNING id, name, email, role, status, avatar_emoji, manager_id
    `, params);

    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    return res.json(rows[0]);
  } catch (err) {
    console.error('[USERS]', err);
    return res.status(500).json({ error: 'Erro ao atualizar usuário.' });
  }
}

async function deleteUser(req, res) {
  const { id } = req.params;
  
  if (req.user.id === id) {
    return res.status(400).json({ error: 'Você não pode deletar a si mesmo.' });
  }

  try {
    const { rowCount } = await db.query('DELETE FROM users WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.status(204).send();
  } catch (err) {
    console.error('[USERS]', err);
    return res.status(500).json({ error: 'Erro ao deletar usuário.' });
  }
}

module.exports = { listUsers, createUser, updateUser, deleteUser };
