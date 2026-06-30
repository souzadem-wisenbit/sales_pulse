'use strict';
const db = require('../db/pool');

async function listClients(req, res) {
  try {
    const { rows } = await db.query('SELECT * FROM clients ORDER BY created_at DESC');
    
    const formatted = rows.map(r => ({
      ...r,
      nivelErros: r.nivel_erros,
      nivelGirias: r.nivel_girias,
      sotaqueRegiao: r.sotaque_regiao,
      velocidadeResposta: r.velocidade_resposta,
      nivelTecnico: r.nivel_tecnico,
      usaAbreviacoes: r.usa_abreviacoes,
      usaMaiusculas: r.usa_maiusculas,
      usaEmojis: r.usa_emojis,
      fazPerguntas: r.faz_perguntas,
      priceSensitivity: r.price_sensitivity,
      productKnowledge: r.product_knowledge,
      negotiationWill: r.negotiation_will,
      trickFrequency: r.trick_frequency,
      trickTypes: r.trick_types,
      vendedoresAtribuidos: r.vendedores_atribuidos,
      hiddenAgenda: r.hidden_agenda,
      marketSegment: r.market_segment,
      hostileMode: r.hostile_mode,
      hostileCompetitors: r.hostile_competitors,
      sessionConstraints: r.session_constraints,
      customBehavior: r.custom_behavior
    }));
    return res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
}

async function createClient(req, res) {
  try {
    const data = req.body;
    const id = data.id || 'cli_' + Date.now();
    await db.query(`
      INSERT INTO clients (
        id, name, emoji, difficulty, description, humanidade, formalidade,
        nivel_erros, nivel_girias, emotividade, objetividade, sotaque_regiao,
        velocidade_resposta, nivel_tecnico, usa_abreviacoes, usa_maiusculas,
        usa_emojis, faz_perguntas, skepticism, urgency, price_sensitivity,
        product_knowledge, negotiation_will, trick_frequency, trick_types,
        vendedores_atribuidos, archetype, hidden_agenda, market_segment,
        hostile_mode, hostile_competitors, session_constraints, custom_behavior
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33
      )
    `, [
      id, data.name, data.emoji, data.difficulty, data.description, data.humanidade, data.formalidade,
      data.nivelErros, data.nivelGirias, data.emotividade, data.objetividade, data.sotaqueRegiao,
      data.velocidadeResposta, data.nivelTecnico, data.usaAbreviacoes, data.usaMaiusculas,
      data.usaEmojis, data.fazPerguntas, data.skepticism, data.urgency, data.priceSensitivity,
      data.productKnowledge, data.negotiationWill, data.trickFrequency, JSON.stringify(data.trickTypes || []),
      JSON.stringify(data.vendedoresAtribuidos || []), data.archetype, data.hiddenAgenda, data.marketSegment,
      data.hostileMode, JSON.stringify(data.hostileCompetitors || []), JSON.stringify(data.sessionConstraints || {}), data.customBehavior
    ]);
    res.status(201).json({ ...data, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar cliente' });
  }
}

async function updateClient(req, res) {
  try {
    const { id } = req.params;
    const data = req.body;
    // For simplicity, we just do a full update
    await db.query(`
      UPDATE clients SET
        name = $1, emoji = $2, difficulty = $3, description = $4, humanidade = $5, formalidade = $6,
        nivel_erros = $7, nivel_girias = $8, emotividade = $9, objetividade = $10, sotaque_regiao = $11,
        velocidade_resposta = $12, nivel_tecnico = $13, usa_abreviacoes = $14, usa_maiusculas = $15,
        usa_emojis = $16, faz_perguntas = $17, skepticism = $18, urgency = $19, price_sensitivity = $20,
        product_knowledge = $21, negotiation_will = $22, trick_frequency = $23, trick_types = $24,
        vendedores_atribuidos = $25, archetype = $26, hidden_agenda = $27, market_segment = $28,
        hostile_mode = $29, hostile_competitors = $30, session_constraints = $31, custom_behavior = $32,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $33
    `, [
      data.name, data.emoji, data.difficulty, data.description, data.humanidade, data.formalidade,
      data.nivelErros, data.nivelGirias, data.emotividade, data.objetividade, data.sotaqueRegiao,
      data.velocidadeResposta, data.nivelTecnico, data.usaAbreviacoes, data.usaMaiusculas,
      data.usaEmojis, data.fazPerguntas, data.skepticism, data.urgency, data.priceSensitivity,
      data.productKnowledge, data.negotiationWill, data.trickFrequency, JSON.stringify(data.trickTypes || []),
      JSON.stringify(data.vendedoresAtribuidos || []), data.archetype, data.hiddenAgenda, data.marketSegment,
      data.hostileMode, JSON.stringify(data.hostileCompetitors || []), JSON.stringify(data.sessionConstraints || {}), data.customBehavior,
      id
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao atualizar cliente' });
  }
}

async function deleteClient(req, res) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM clients WHERE id = $1', [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao excluir cliente' });
  }
}

module.exports = { listClients, createClient, updateClient, deleteClient };
