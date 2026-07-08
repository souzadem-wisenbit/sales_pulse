'use strict';
const db = require('../db/pool');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function getOpenAIClient() {
  const { rows } = await db.query('SELECT openai_key FROM ai_settings LIMIT 1');
  if (rows.length === 0 || !rows[0].openai_key) {
    throw new Error('Chave da OpenAI não configurada no painel.');
  }
  return new OpenAI({ apiKey: rows[0].openai_key });
}

async function startSession(req, res) {
  const { user_id, config, system_prompt } = req.body;
  
  try {
    const openai = await getOpenAIClient();

    // Cria a sessão no banco
    const { rows: sessionRows } = await db.query(`
      INSERT INTO sessions (user_id, status)
      VALUES ($1, 'in_progress')
      RETURNING id
    `, [user_id]);
    
    const sessionId = sessionRows[0].id;

    // Chama OpenAI para a primeira mensagem
    const response = await openai.chat.completions.create({
      model: config.preferred_model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: system_prompt }],
      temperature: 0.7,
    });

    const assistantMsg = response.choices[0].message.content;

    // Salva a primeira mensagem
    await db.query(`
      INSERT INTO messages (session_id, role, content)
      VALUES ($1, 'assistant', $2)
    `, [sessionId, assistantMsg]);

    return res.json({
      session_id: sessionId,
      opening_message: { role: 'assistant', content: assistantMsg },
      conviction: 10
    });

  } catch (err) {
    console.error('[SESSIONS START]', err);
    return res.status(500).json({ error: err.message || 'Erro ao iniciar sessão.' });
  }
}

async function sendMessage(req, res) {
  const { id } = req.params; // session id
  const { messages, system_prompt, config } = req.body;

  try {
    const openai = await getOpenAIClient();
    
    // Salva a mensagem do usuário
    const userMsg = messages[messages.length - 1];
    await db.query(`
      INSERT INTO messages (session_id, role, content)
      VALUES ($1, 'user', $2)
    `, [id, userMsg.content]);

    // Prepara payload pro OpenAI
    const payload = [
      { role: 'system', content: system_prompt },
      ...messages
    ];

    const response = await openai.chat.completions.create({
      model: config.preferred_model || 'gpt-4o-mini',
      messages: payload,
      temperature: 0.7,
    });

    const assistantMsg = response.choices[0].message.content;

    // Salva resposta
    await db.query(`
      INSERT INTO messages (session_id, role, content)
      VALUES ($1, 'assistant', $2)
    `, [id, assistantMsg]);

    return res.json({
      message: { role: 'assistant', content: assistantMsg },
      conviction: 10,
      is_trick: false,
      trick_type: null,
      is_dealbreaker: false,
      agenda_revealed: false
    });

  } catch (err) {
    console.error('[SESSIONS MSG]', err);
    return res.status(500).json({ error: err.message || 'Erro ao enviar mensagem.' });
  }
}

async function listSessions(req, res) {
  try {
    // Isolamento: gestor vê só sessões (pontuações) dos seus vendedores
    let query = 'SELECT * FROM sessions ORDER BY created_at DESC';
    let params = [];
    if (req.user.role === 'manager') {
      query = `SELECT s.* FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE u.manager_id = $1 ORDER BY s.created_at DESC`;
      params = [req.user.id];
    } else if (req.user.role === 'seller') {
      query = 'SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await db.query(query, params);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao listar sessões.' });
  }
}

async function endSession(req, res) {
  const { id } = req.params;
  const { score, status } = req.body;
  try {
    await db.query('UPDATE sessions SET status = $1, score = $2, ended_at = NOW() WHERE id = $3', [status || 'completed', score || 0, id]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao encerrar.' });
  }
}

async function evaluateSession(req, res) {
  const { id } = req.params;
  return res.json({ success: true, feedback: 'Avaliação recebida.' });
}

async function getCoachTip(req, res) {
  return res.json({ tip: 'Dica do treinador.' });
}

async function transcribeAudio(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum áudio enviado.' });
    }
    const openai = await getOpenAIClient();
    
    // Save buffer to a temp file
    const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.webm`);
    fs.writeFileSync(tempFilePath, req.file.buffer);

    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
      language: 'pt',
    });

    // Cleanup temp file
    fs.unlinkSync(tempFilePath);

    return res.json({ text: response.text });
  } catch (err) {
    console.error('[SESSIONS TRANSCRIBE]', err);
    return res.status(500).json({ error: err.message || 'Erro ao transcrever áudio.' });
  }
}

module.exports = { startSession, sendMessage, listSessions, endSession, evaluateSession, getCoachTip, transcribeAudio };
