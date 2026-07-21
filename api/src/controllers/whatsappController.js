'use strict';
// WhatsApp Coach — endpoints da modalidade escrita do Live Coach.
// Cada vendedor só enxerga a própria sessão: tudo é chaveado por req.user.id,
// nunca por um id vindo do corpo/URL.
const wa = require('../services/whatsappService');

async function connectWhatsapp(req, res) {
  try {
    const state = await wa.connect(req.user.id);
    res.json(state);
  } catch (err) {
    console.error('[WA CONNECT]', err);
    res.status(500).json({ error: 'Erro ao conectar ao WhatsApp' });
  }
}

function getStatus(req, res) {
  try {
    res.json(wa.status(req.user.id));
  } catch (err) {
    console.error('[WA STATUS]', err);
    res.status(500).json({ error: 'Erro ao consultar o WhatsApp' });
  }
}

function getEvents(req, res) {
  try {
    res.json(wa.events(req.user.id, req.query.since));
  } catch (err) {
    console.error('[WA EVENTS]', err);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
}

async function disconnectWhatsapp(req, res) {
  try {
    res.json(await wa.disconnect(req.user.id));
  } catch (err) {
    console.error('[WA DISCONNECT]', err);
    res.status(500).json({ error: 'Erro ao desconectar' });
  }
}

async function getBriefing(req, res) {
  try {
    res.json(await wa.getBriefing(req.user.id));
  } catch (err) {
    console.error('[WA BRIEFING GET]', err);
    res.status(500).json({ error: 'Erro ao buscar o briefing' });
  }
}

async function putBriefing(req, res) {
  try {
    res.json(await wa.saveBriefing(req.user.id, req.body || {}));
  } catch (err) {
    console.error('[WA BRIEFING PUT]', err);
    res.status(500).json({ error: 'Erro ao salvar o briefing' });
  }
}

module.exports = { connectWhatsapp, getStatus, getEvents, disconnectWhatsapp, getBriefing, putBriefing };
