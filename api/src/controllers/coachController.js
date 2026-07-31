'use strict';
// ================================================
// Proxy do Live Coach: a dica é gerada AQUI, no backend, com a chave da
// OpenAI do servidor (ai_settings, via knowledgeService.getOpenAI). O
// navegador nunca mais vê a chave — ele só manda o prompt e recebe o JSON.
// De quebra, cada chamada é MEDIDA por usuário (ai_usage) para faturar por
// tenant e vigiar a margem (o custo da OpenAI é variável).
// ================================================
const db = require('../db/pool');
const knowledge = require('../services/knowledgeService');

// Só modelos aprovados podem ser pedidos pelo cliente — evita alguém apontar
// a SUA chave para um modelo caro. maxTokens e prompt têm teto (anti-abuso).
const ALLOWED_MODELS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']);
const MAX_PROMPT_CHARS = 60000;   // prompt do coach = método + conversa + briefing
const MAX_OUTPUT_TOKENS = 900;    // teto do JSON da dica (folga sem exagero)

async function complete(req, res) {
  const body = req.body || {};
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt obrigatório' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: 'prompt muito grande' });
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'gpt-4o-mini';
  const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 320, 1), MAX_OUTPUT_TOKENS);
  const temperature = Math.min(Math.max(Number(body.temperature != null ? body.temperature : 0.6), 0), 1.5);
  const source = String(body.source || 'coach').slice(0, 32);

  try {
    const openai = await knowledge.getOpenAI();
    // maxRetries 0 + timeout curto: o coach prefere falhar rápido (o cliente
    // degrada para "sem dica") a segurar uma dica atrasada = dica errada.
    const completion = await openai.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
      },
      { timeout: 9000, maxRetries: 0 }
    );

    const content = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : null;
    const usage = completion.usage || {};

    // Medição por tenant — nunca bloqueia a resposta se o insert falhar.
    const managerId = req.user.role === 'manager' ? req.user.id : (req.user.manager_id || null);
    db.query(
      `INSERT INTO ai_usage (user_id, manager_id, model, source, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, managerId, model, source, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0]
    ).catch((e) => console.error('[AI_USAGE]', e.message));

    return res.json({ content, usage });
  } catch (err) {
    console.error('[COACH COMPLETE]', err && err.message);
    return res.status(502).json({ error: 'Falha ao gerar a dica' });
  }
}

module.exports = { complete };
