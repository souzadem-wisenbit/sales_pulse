'use strict';
const db = require('../db/pool');

async function listProducts(req, res) {
  try {
    const { rows } = await db.query('SELECT * FROM products ORDER BY created_at DESC');
    const formatted = rows.map(r => ({
      ...r,
      clientesAtribuidos: r.clientes_atribuidos,
      vendedoresAtribuidos: r.vendedores_atribuidos
    }));
    return res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
}

async function createProduct(req, res) {
  try {
    const data = req.body;
    const id = data.id || 'prod_' + Date.now();
    await db.query(`
      INSERT INTO products (
        id, name, price, description, benefits, objections, clientes_atribuidos, vendedores_atribuidos
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
    `, [
      id, data.name, data.price, data.description, 
      JSON.stringify(data.benefits || []), JSON.stringify(data.objections || []),
      JSON.stringify(data.clientesAtribuidos || []), JSON.stringify(data.vendedoresAtribuidos || [])
    ]);
    res.status(201).json({ ...data, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
}

async function updateProduct(req, res) {
  try {
    const { id } = req.params;
    const data = req.body;
    await db.query(`
      UPDATE products SET
        name = $1, price = $2, description = $3, benefits = $4, objections = $5,
        clientes_atribuidos = $6, vendedores_atribuidos = $7, updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
    `, [
      data.name, data.price, data.description, 
      JSON.stringify(data.benefits || []), JSON.stringify(data.objections || []),
      JSON.stringify(data.clientesAtribuidos || []), JSON.stringify(data.vendedoresAtribuidos || []),
      id
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
}

async function deleteProduct(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM products WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir produto' });
  }
}

module.exports = { listProducts, createProduct, updateProduct, deleteProduct };
