'use strict';
const db = require('../db/pool');

async function listProducts(req, res) {
  try {
    // Isolamento por gestor: gestor vê só os próprios produtos; vendedor vê
    // os produtos do seu gestor + os referenciados em suas sessões agendadas;
    // superadmin vê tudo.
    let query = 'SELECT * FROM products ORDER BY created_at DESC';
    let params = [];
    if (req.user.role === 'manager') {
      query = 'SELECT * FROM products WHERE manager_id = $1 ORDER BY created_at DESC';
      params = [req.user.id];
    } else if (req.user.role === 'seller') {
      query = `SELECT * FROM products p
               WHERE p.manager_id IS NOT DISTINCT FROM (SELECT manager_id FROM users WHERE id = $1)
                  OR p.id IN (
                    SELECT jsonb_array_elements_text(product_ids)
                    FROM scheduled_sessions WHERE seller_id = $1
                  )
               ORDER BY p.created_at DESC`;
      params = [req.user.id];
    }
    const { rows } = await db.query(query, params);
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
    // Produto pertence ao gestor que o criou (superadmin cria sem dono = global)
    const managerId = req.user.role === 'manager' ? req.user.id : null;
    await db.query(`
      INSERT INTO products (
        id, name, price, description, benefits, objections, clientes_atribuidos, vendedores_atribuidos, manager_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )
    `, [
      id, data.name, data.price, data.description,
      JSON.stringify(data.benefits || []), JSON.stringify(data.objections || []),
      JSON.stringify(data.clientesAtribuidos || []), JSON.stringify(data.vendedoresAtribuidos || []),
      managerId
    ]);
    res.status(201).json({ ...data, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
}

async function assertProductOwner(req, res, id) {
  if (req.user.role !== 'manager') return true;
  const { rows } = await db.query('SELECT manager_id FROM products WHERE id = $1', [id]);
  if (rows.length === 0) { res.status(404).json({ error: 'Produto não encontrado' }); return false; }
  if (rows[0].manager_id !== req.user.id) { res.status(403).json({ error: 'Acesso negado' }); return false; }
  return true;
}

async function updateProduct(req, res) {
  try {
    const { id } = req.params;
    if (!(await assertProductOwner(req, res, id))) return;
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
    if (!(await assertProductOwner(req, res, id))) return;
    await db.query('DELETE FROM products WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir produto' });
  }
}

module.exports = { listProducts, createProduct, updateProduct, deleteProduct };
