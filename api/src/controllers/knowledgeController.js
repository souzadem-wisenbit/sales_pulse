'use strict';
// Documentos de metodologia do coach (gestor sobe; vendedor consome via retrieve)
const db = require('../db/pool');
const knowledge = require('../services/knowledgeService');

// Gestor só enxerga/gerencia docs do próprio escopo + a base global do Júnior
async function listDocs(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT d.id, d.coach_id, d.manager_id, d.filename, d.mime, d.status, d.error,
             d.pages, d.chars, d.chunk_count, d.created_at, u.name AS coach_name
      FROM coach_documents d
      LEFT JOIN users u ON u.id::text = d.coach_id
      WHERE d.manager_id IS NULL OR d.manager_id = $1
      ORDER BY d.manager_id NULLS FIRST, d.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('[KNOWLEDGE LIST]', err);
    res.status(500).json({ error: 'Erro ao listar documentos' });
  }
}

async function canCoachBelongToManager(reqUser, coachId) {
  if (coachId === 'junior') return true;
  if (reqUser.role === 'superadmin') return true;
  const { rows } = await db.query('SELECT manager_id FROM users WHERE id = $1', [coachId]);
  return rows.length > 0 && rows[0].manager_id === reqUser.id;
}

async function uploadDoc(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const coachId = req.body.coachId || 'junior';
    if (!(await canCoachBelongToManager(req.user, coachId))) {
      return res.status(403).json({ error: 'Coach inválido' });
    }
    if (!knowledge.isSupported(req.file.originalname, req.file.mimetype)) {
      return res.status(400).json({ error: 'Formato não suportado. Envie PDF, imagem (PNG/JPG/WebP) ou texto (.txt/.md/.csv).' });
    }

    const id = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    await db.query(
      'INSERT INTO coach_documents (id, coach_id, manager_id, filename, mime) VALUES ($1, $2, $3, $4, $5)',
      [id, coachId, req.user.id, String(req.file.originalname).slice(0, 255), req.file.mimetype]
    );

    // Processamento (extração + embeddings) roda em background; a UI
    // acompanha pelo status do documento (processing → ready | error).
    const buffer = req.file.buffer;
    setImmediate(() => {
      knowledge.processDocument(id, buffer).catch(() => {});
    });

    res.status(201).json({ id, status: 'processing' });
  } catch (err) {
    console.error('[KNOWLEDGE UPLOAD]', err);
    res.status(500).json({ error: 'Erro ao enviar documento' });
  }
}

async function deleteDoc(req, res) {
  try {
    const { rows } = await db.query('SELECT manager_id FROM coach_documents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Documento não encontrado' });
    const ownerId = rows[0].manager_id;
    // Base global (manager_id NULL) só o superadmin remove; docs de gestor, só o dono
    const allowed = ownerId === null ? req.user.role === 'superadmin' : ownerId === req.user.id;
    if (!allowed) return res.status(403).json({ error: 'Acesso negado' });
    await db.query('DELETE FROM coach_documents WHERE id = $1', [req.params.id]); // chunks caem por CASCADE
    res.json({ success: true });
  } catch (err) {
    console.error('[KNOWLEDGE DELETE]', err);
    res.status(500).json({ error: 'Erro ao excluir documento' });
  }
}

// Chamado pelo Live Coach a cada dica: devolve os trechos da metodologia
// mais próximos do momento atual da conversa. Escopo SEMPRE resolvido no
// servidor a partir do usuário autenticado — vendedor não escolhe coach.
async function retrieveChunks(req, res) {
  try {
    const query = String(req.body.query || '').trim();
    if (query.length < 8) return res.json({ chunks: [] });

    const { rows } = await db.query('SELECT coach_id, manager_id, role FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    const me = rows[0];

    const coachId = me.coach_id || 'junior';
    // Vendedor: docs do gestor dele. Gestor/superadmin (testando o coach): os próprios.
    const managerId = me.role === 'seller' ? me.manager_id : req.user.id;

    const chunks = await knowledge.retrieve({ coachId, managerId, query, k: Number(req.body.k) || 4 });
    res.json({ chunks });
  } catch (err) {
    console.error('[KNOWLEDGE RETRIEVE]', err);
    res.status(500).json({ error: 'Erro na busca de conhecimento' });
  }
}

module.exports = { listDocs, uploadDoc, deleteDoc, retrieveChunks };
