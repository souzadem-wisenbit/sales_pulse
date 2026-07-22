// ================================================
// SALESPULSE — WhatsApp Coach
// Segunda modalidade do Live Coach: em vez de ouvir uma chamada, o coach
// acompanha as conversas de WhatsApp do vendedor e escreve a resposta pronta.
//
// Mesmo cérebro da modalidade de áudio (js/coachcore.js): mesmo coach
// atribuído pelo gestor, mesmo briefing, mesma classificação da fala do
// cliente e mesmas regras invioláveis. Muda só o meio — em vez de um script
// para FALAR, uma mensagem para COPIAR e COLAR.
//
// Arquitetura:
//  - O servidor (api/src/services/whatsappService.js) mantém o socket do
//    WhatsApp Web e entrega as mensagens NOVAS por polling (/api/whatsapp/events).
//  - Aqui no navegador ficam as conversas, o coach e a tela.
//  - SOMENTE LEITURA: o SalesPulse nunca envia nada pelo WhatsApp do vendedor.
//    A sugestão é copiada por ele. Quem fala com o cliente é sempre o humano.
//  - Cada conversa vira uma linha em live_calls (channel='whatsapp'), então o
//    histórico do gestor mostra as duas modalidades lado a lado.
// ================================================

const WhatsAppCoach = (() => {

  const POLL_MS = 2000;             // frequência de busca de mensagens novas
  const COACH_DEBOUNCE_MS = 1400;   // espera o cliente TERMINAR a rajada de mensagens
  const SAVE_INTERVAL_MS = 15000;   // persistência das conversas no backend
  const CONTEXT_MSGS = 14;          // mensagens enviadas ao coach como contexto
  const MAX_TIPS_KEPT = 40;

  let open_ = false;                // overlay aberto
  let polling = false;
  let pollTimer = null;
  let saveTimer = null;
  let seq = 0;                      // último evento consumido do servidor
  let status = 'idle';              // idle|connecting|qr|connected|logged_out|error
  let statusError = null;
  let qrImage = null;
  let phone = null;

  const chats = new Map();          // jid -> conversa
  let activeJid = null;

  let globalBrief = null;           // briefing padrão (vale para toda conversa nova)
  let availableProducts = [];
  let selectedProductIds = new Set();
  let editingOverrideJid = null;    // conversa cujo briefing está sendo ajustado

  let coach = null;                 // coach atribuído pelo gestor
  let profile = null;               // perfil aprendido do vendedor
  let knowledge = null;             // busca de metodologia (RAG), compartilha o cérebro do modo áudio
  let coachCore = null;             // identidade destilada da metodologia (tom + regras de ouro)
  let coachPlays = [];              // catálogo de jogadas — toda dica escolhe uma por número
  let tipSoundOn = true;
  let audioCtx = null;

  const esc = (s) => CoachCore.esc(s);
  const tempColor = (t) => CoachCore.tempColor(t);
  const STAGE_LABELS = CoachCore.STAGE_LABELS;

  function getApiKey() {
    return Storage.getConfig().openaiKey || (Storage.getSettings() || {}).openaiKey || null;
  }

  function fmtTime(t) {
    return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function agoLabel(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 5) return 'agora';
    if (s < 60) return `há ${s}s`;
    if (s < 3600) return `há ${Math.floor(s / 60)}min`;
    return `há ${Math.floor(s / 3600)}h`;
  }

  // ══════════════════════════════════════
  // ESTILOS
  // ══════════════════════════════════════
  function styles() {
    return `
      <style>
        #wacoach-overlay { position: fixed; inset: 0; z-index: 99991; background: #07070f; overflow-y: auto; color: #e8e8f0; font-family: inherit; }
        .wa-wrap { max-width: 1780px; margin: 0 auto; padding: 1.25rem 1.75rem; }
        .wa-wrap.wa-live { height: 100vh; display: flex; flex-direction: column; padding: 1rem 1.4rem; max-width: none; }
        .wa-header { display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; margin-bottom: 1.1rem; flex-shrink: 0; }
        .wa-title { font-size: 1.25rem; font-weight: 800; }
        .wa-dot { width: 10px; height: 10px; border-radius: 50%; background: #25d366; display: inline-block; margin-right: 7px; animation: waPulse 1.6s infinite; }
        @keyframes waPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .wa-card { background: rgba(14,14,26,0.85); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.2rem; }
        .wa-card + .wa-card { margin-top: 1.1rem; }
        .wa-card-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #5a5a7a; margin-bottom: 0.85rem; }
        .wa-ask-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0.7rem 1rem; margin-bottom: 0.9rem; border-radius: 12px; border: 1px solid rgba(37,211,102,0.45); background: linear-gradient(135deg, rgba(37,211,102,0.2), rgba(0,212,170,0.14)); color: #e8e8f0; font-weight: 800; font-size: 0.9rem; cursor: pointer; transition: transform 0.12s ease, box-shadow 0.18s ease, filter 0.18s ease; }
        .wa-ask-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(37,211,102,0.25); filter: brightness(1.08); }
        .wa-ask-btn:disabled { opacity: 0.75; cursor: progress; }
        .wa-ask-spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25); border-top-color: #25d366; display: inline-block; animation: waSpin 0.7s linear infinite; }
        @keyframes waSpin { to { transform: rotate(360deg); } }
        .wa-muted { color: #5a5a7a; font-size: 0.8rem; }
        .wa-chip { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 0.72rem; font-weight: 600; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); margin: 2px; }
        .wa-btn { display: inline-flex; align-items: center; gap: 8px; padding: 0.7rem 1.4rem; border-radius: 100px; border: none; cursor: pointer; font-weight: 700; font-size: 0.9rem; font-family: inherit; }
        .wa-btn-primary { background: linear-gradient(135deg, #25d366, #00a884); color: #04140b; }
        .wa-btn-danger { background: rgba(255,71,87,0.15); border: 1px solid rgba(255,71,87,0.4); color: #ff4757; }
        .wa-btn-ghost { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #9494b8; }
        .wa-btn-block { width: 100%; justify-content: center; }
        .wa-btn-sm { padding: 0.35rem 0.9rem; font-size: 0.75rem; }
        .wa-label { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #8a8aad; margin: 1rem 0 0.5rem; }
        .wa-label:first-of-type { margin-top: 0; }
        .wa-input, .wa-select, .wa-textarea { width: 100%; background: rgba(255,255,255,0.045); border: 1.5px solid rgba(255,255,255,0.12); color: #e8e8f0; border-radius: 12px; padding: 0.7rem 0.9rem; font-size: 0.88rem; font-family: inherit; }
        .wa-input:focus, .wa-select:focus, .wa-textarea:focus { outline: none; border-color: rgba(37,211,102,0.6); }
        .wa-textarea { min-height: 92px; resize: vertical; line-height: 1.5; }
        .wa-select { background: #1b1b22; color: #e8e8f0; }
        .wa-select option { background: #1b1b22; color: #e8e8f0; }
        .wa-pchips { display: flex; flex-wrap: wrap; gap: 8px; }
        .wa-pchip { padding: 8px 14px; border-radius: 100px; border: 1.5px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #b9b9d0; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.18s; user-select: none; }
        .wa-pchip:hover { border-color: rgba(37,211,102,0.5); }
        .wa-pchip.sel { border-color: #25d366; background: linear-gradient(135deg, rgba(37,211,102,0.18), rgba(37,211,102,0.06)); color: #7dead0; }
        .wa-pchip.sel::before { content: '✓ '; }
        .wa-brief-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 100px; font-size: 0.73rem; font-weight: 600; background: rgba(37,211,102,0.1); border: 1px solid rgba(37,211,102,0.3); color: #7dead0; margin: 2px; }

        /* ── Dashboard ao vivo: 3 colunas, 100vh, cada painel rola por dentro ── */
        .wa-grid { display: grid; grid-template-columns: 270px minmax(0,1fr) minmax(370px, 430px); gap: 1rem; flex: 1; min-height: 0; }
        @media (max-width: 1280px) { .wa-grid { grid-template-columns: 230px minmax(0,1fr) minmax(330px, 380px); } }
        @media (max-width: 1000px) { .wa-wrap.wa-live { height: auto; } .wa-grid { grid-template-columns: 1fr; } }
        .wa-col { display: flex; flex-direction: column; min-height: 0; }
        .wa-col .wa-card { display: flex; flex-direction: column; min-height: 0; }
        .wa-scroll { overflow-y: auto; min-height: 0; flex: 1; }
        .wa-col-right { gap: 1rem; overflow-y: auto; padding-right: 3px; }
        .wa-col-right > .wa-card { flex-shrink: 0; }
        .wa-col-right > .wa-card + .wa-card { margin-top: 0; }

        /* ── Lista de conversas ── */
        .wa-conv { display: flex; gap: 10px; align-items: center; padding: 9px 10px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; margin-bottom: 4px; }
        .wa-conv:hover { background: rgba(255,255,255,0.04); }
        .wa-conv.active { background: rgba(37,211,102,0.10); border-color: rgba(37,211,102,0.35); }
        .wa-avatar { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, #25d366, #00a884); color: #04140b; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.85rem; flex-shrink: 0; }
        .wa-conv-info { min-width: 0; flex: 1; }
        .wa-conv-name { font-size: 0.85rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wa-conv-last { font-size: 0.72rem; color: #6f6f92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .wa-badge { background: #25d366; color: #04140b; font-size: 0.65rem; font-weight: 800; border-radius: 100px; padding: 1px 7px; flex-shrink: 0; }
        .wa-badge.tip { background: #ffd25c; }

        /* ── Mensagens ── */
        .wa-msgs { display: flex; flex-direction: column; gap: 7px; }
        .wa-msg { padding: 8px 12px; border-radius: 10px; font-size: 0.86rem; line-height: 1.45; max-width: 86%; word-break: break-word; }
        /* pre-wrap SÓ no texto: no balão inteiro, a indentação do template
           virava espaço em branco visível e empurrava a mensagem. */
        .wa-msg-text { white-space: pre-wrap; }
        .wa-msg.seller { background: rgba(37,211,102,0.14); border: 1px solid rgba(37,211,102,0.28); align-self: flex-end; }
        .wa-msg.client { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); align-self: flex-start; }
        .wa-msg-who { font-size: 0.66rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; display: flex; gap: 8px; align-items: baseline; }
        .wa-msg.seller .wa-msg-who { color: #7dead0; }
        .wa-msg.client .wa-msg-who { color: #a8a2ff; }
        .wa-msg-time { font-size: 0.62rem; color: #5a5a7a; font-weight: 500; letter-spacing: 0; }

        /* ── Cartão da sugestão ── */
        .wa-hero { border-radius: 14px; padding: 14px 16px; border: 1.5px solid; margin-bottom: 12px; animation: waHeroIn 0.4s cubic-bezier(0.2,0.9,0.3,1.15); }
        @keyframes waHeroIn { from { transform: translateY(-10px) scale(0.97); opacity: 0; } to { transform: none; opacity: 1; } }
        .wa-hero.urgent { background: linear-gradient(140deg, rgba(255,71,87,0.18), rgba(255,71,87,0.04)); border-color: rgba(255,71,87,0.65); box-shadow: 0 0 26px rgba(255,71,87,0.28); }
        .wa-hero.normal { background: linear-gradient(140deg, rgba(37,211,102,0.16), rgba(37,211,102,0.04)); border-color: rgba(37,211,102,0.6); box-shadow: 0 0 26px rgba(37,211,102,0.22); }
        .wa-hero.good { background: linear-gradient(140deg, rgba(46,213,115,0.16), rgba(46,213,115,0.04)); border-color: rgba(46,213,115,0.6); box-shadow: 0 0 26px rgba(46,213,115,0.22); }
        .wa-hero.stale { box-shadow: none; opacity: 0.7; }
        .wa-hero-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 11px; }
        .wa-hero-label { display: inline-flex; align-items: center; gap: 5px; font-size: 0.62rem; font-weight: 800; letter-spacing: 1.5px; padding: 3px 10px; border-radius: 100px; }
        .wa-hero.urgent .wa-hero-label { background: #ff4757; color: #fff; animation: waPulse 0.9s infinite; }
        .wa-hero.normal .wa-hero-label { background: #25d366; color: #04140b; }
        .wa-hero.good .wa-hero-label { background: #2ed573; color: #04140b; }
        .wa-tech-chip { font-size: 0.6rem; font-weight: 700; letter-spacing: 0.6px; padding: 3px 10px; border-radius: 100px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #c9c9dd; text-transform: uppercase; }
        /* A mensagem pronta é o herói: é ela que vai ser copiada */
        .wa-say { padding: 14px 16px; border-radius: 12px; background: rgba(7,7,15,0.62); border: 1px solid rgba(255,255,255,0.16); }
        .wa-say-label { font-size: 0.62rem; font-weight: 800; letter-spacing: 1.4px; color: #9a9abf; margin-bottom: 9px; }
        .wa-say-text { font-size: 1.05rem; line-height: 1.6; color: #fff; font-weight: 500; white-space: pre-wrap; word-break: break-word; }
        .wa-say-actions { display: flex; gap: 8px; margin-top: 12px; }
        .wa-copy-btn { flex: 1; justify-content: center; background: linear-gradient(135deg, #25d366, #00a884); color: #04140b; border: none; border-radius: 100px; padding: 0.7rem 1rem; font-weight: 800; font-size: 0.88rem; cursor: pointer; font-family: inherit; }
        .wa-copy-btn.done { background: rgba(46,213,115,0.2); color: #7dead0; border: 1px solid rgba(46,213,115,0.5); }
        .wa-hero-why { margin-top: 11px; font-size: 0.82rem; line-height: 1.45; color: #b9b9d0; display: flex; gap: 8px; }
        .wa-hero-fresh { margin-top: 10px; display: flex; justify-content: space-between; font-size: 0.7rem; color: #9494b8; }
        .wa-hist { display: flex; gap: 8px; align-items: baseline; padding: 7px 10px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); margin-bottom: 5px; font-size: 0.78rem; color: #9a9ab5; line-height: 1.35; }
        .wa-hist-time { margin-left: auto; font-size: 0.65rem; color: #5a5a7a; white-space: nowrap; }
        .wa-hist-divider { font-size: 0.62rem; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: #44445e; margin: 10px 0 6px; }
        .wa-stage-row { display: flex; align-items: center; gap: 10px; margin-bottom: 0.7rem; flex-wrap: wrap; }
        .wa-temp-track { flex: 1; min-width: 100px; height: 8px; border-radius: 100px; background: rgba(255,255,255,0.07); overflow: hidden; }
        .wa-temp-fill { height: 100%; border-radius: 100px; transition: width 0.6s ease, background 0.6s ease; }
        .wa-setup-step { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.88rem; color: #b9b9d0; }
        .wa-setup-step:last-child { border-bottom: none; }
        .wa-step-num { width: 26px; height: 26px; border-radius: 50%; background: rgba(37,211,102,0.18); color: #7dead0; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.8rem; flex-shrink: 0; }
        .wa-qr-box { background: #fff; padding: 14px; border-radius: 16px; display: inline-block; line-height: 0; }
        .wa-qr-box img { width: 280px; height: 280px; display: block; }
        .wa-warn { background: rgba(255,165,2,0.10); border: 1px solid rgba(255,165,2,0.35); border-radius: 10px; padding: 10px 12px; font-size: 0.8rem; line-height: 1.5; color: #ffd28a; }
        .wa-spinner { width: 34px; height: 34px; border: 3px solid rgba(37,211,102,0.2); border-top-color: #25d366; border-radius: 50%; animation: waSpin 0.8s linear infinite; margin: 0 auto; }
        @keyframes waSpin { to { transform: rotate(360deg); } }
      </style>
    `;
  }

  function overlayEl() {
    let el = document.getElementById('wacoach-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'wacoach-overlay';
    document.body.appendChild(el);
    return el;
  }

  // ══════════════════════════════════════
  // ABERTURA + BRIEFING PADRÃO
  // ══════════════════════════════════════
  async function open() {
    const overlay = overlayEl();
    open_ = true;
    overlay.style.display = 'block';

    if (!getApiKey()) {
      overlay.innerHTML = `${styles()}
        <div class="wa-wrap" style="display:flex;align-items:center;justify-content:center;min-height:100vh">
          <div class="wa-card" style="max-width:440px;text-align:center">
            <div style="font-size:2.5rem;margin-bottom:0.75rem">🔑</div>
            <h3 style="margin-bottom:0.5rem">Chave de IA não configurada</h3>
            <p class="wa-muted" style="margin-bottom:1.25rem">O gestor precisa configurar a chave da OpenAI em Configurações para o coach funcionar.</p>
            <button class="wa-btn wa-btn-ghost" onclick="WhatsAppCoach.close()">← Voltar</button>
          </div>
        </div>`;
      return;
    }

    overlay.innerHTML = `${styles()}
      <div class="wa-wrap" style="display:flex;align-items:center;justify-content:center;min-height:60vh">
        <div class="wa-muted">Carregando...</div>
      </div>`;

    try { availableProducts = (await API.listProducts()) || []; } catch (e) { availableProducts = []; }
    try {
      const p = await API.getLiveProfile(Auth.getUser().id);
      coach = p?.coach || null;
      profile = (p && p.profile && Object.keys(p.profile).length > 0) ? p.profile : null;
    } catch (e) { coach = null; profile = null; }
    knowledge = CoachCore.createKnowledgeFetcher();
    CoachCore.warmup(getApiKey());
    coachCore = null;
    coachPlays = [];
    CoachCore.fetchCore().then(r => {
      coachCore = r.core;
      coachPlays = r.plays;
      console.log(`[WhatsAppCoach] núcleo carregado: ${(r.core || '').length} chars, ${r.plays.length} jogadas`);
    });
    try {
      const saved = await API.waGetBriefing();
      globalBrief = (saved && (saved.products || saved.extraProduct)) ? saved : null;
    } catch (e) { globalBrief = null; }

    // Sessão já conectada de antes (o socket vive no servidor): pula o QR
    let st = null;
    try { st = await API.waStatus(); } catch (e) { st = null; }
    if (st && st.status === 'connected' && globalBrief) {
      applyStatus(st);
      startLive();
      return;
    }

    selectedProductIds = new Set((globalBrief?.products || []).map(p => String(p.id)));
    renderSetup();
  }

  function coachChip() {
    if (coach && coach.id === 'junior') {
      return `<div class="wa-chip" style="display:inline-flex;align-items:center;gap:7px;padding-left:4px;border-color:rgba(255,200,50,0.6);background:linear-gradient(135deg, rgba(255,200,50,0.18), rgba(255,160,0,0.08));color:#ffd76a;font-weight:800">
        <img src="img/junior.jpg" style="width:20px;height:20px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,200,50,0.8)" alt="">⭐ Coach: Júnior Smarzaro</div>`;
    }
    if (coach && coach.name) {
      return `<div class="wa-chip" style="border-color:rgba(0,212,170,0.4);color:#7dead0">🧬 Coach: Estilo de ${esc(coach.name)}</div>`;
    }
    return `<div class="wa-chip">🤖 Coach Padrão</div>`;
  }

  function briefFormHtml(brief, idPrefix) {
    const sel = new Set((brief?.products || []).map(p => String(p.id)));
    return `
      <label class="wa-label">1 · O que você vai vender? *</label>
      ${availableProducts.length > 0 ? `
        <div class="wa-pchips">
          ${availableProducts.map(p => `
            <span class="wa-pchip${sel.has(String(p.id)) ? ' sel' : ''}" data-id="${p.id}" onclick="WhatsAppCoach.toggleProduct(this)">${esc(p.name)}${p.price ? ` · ${esc(p.price)}` : ''}</span>
          `).join('')}
        </div>
        <input class="wa-input" id="${idPrefix}-extra" placeholder="Outro produto/serviço não cadastrado (opcional)" style="margin-top:10px" value="${esc(brief?.extraProduct || '')}">
      ` : `
        <div class="wa-muted" style="margin-bottom:8px">Você não tem produtos cadastrados — descreva abaixo o que vai vender.</div>
        <input class="wa-input" id="${idPrefix}-extra" placeholder="Ex: Consultoria de marketing digital, plano trimestral R$ 4.500" value="${esc(brief?.extraProduct || '')}">
      `}

      <label class="wa-label">2 · Ramo do cliente</label>
      <select class="wa-select" id="${idPrefix}-industry">
        ${CoachCore.INDUSTRIES.map(([v, l]) => `<option value="${v}"${brief?.industry === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>

      <label class="wa-label">3 · Contexto (linguagem natural, opcional)</label>
      <textarea class="wa-textarea" id="${idPrefix}-directives" placeholder="Ex: Leads que vieram do anúncio do Instagram, ainda frios. Objetivo: agendar uma call de 15 min. Não dar desconto por mensagem.">${esc(brief?.directives || '')}</textarea>
    `;
  }

  function renderSetup() {
    const overlay = overlayEl();
    overlay.innerHTML = `${styles()}
      <div class="wa-wrap">
        <div class="wa-header">
          <button class="wa-btn wa-btn-ghost" onclick="WhatsAppCoach.close()">← Voltar</button>
          <div class="wa-title">💬 WhatsApp Coach — Vendas por mensagem</div>
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(380px,460px);gap:1.25rem" class="wa-setup-grid">
          <div class="wa-card">
            <div class="wa-card-title">🎯 Briefing padrão — vale para toda conversa nova</div>
            ${briefFormHtml(globalBrief, 'wa-brief')}
            <div class="wa-muted" style="margin-top:8px">Depois, dentro de qualquer conversa, você pode ajustar o briefing só daquele contato (produto diferente, outro ramo, outro objetivo).</div>
          </div>
          <div>
            <div class="wa-card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1rem">
              <div style="font-size:3rem">💬</div>
              ${coachChip()}
              <p class="wa-muted">O coach lê as conversas que chegarem a partir de agora e escreve a resposta pronta para você copiar e colar.</p>
              <button class="wa-btn wa-btn-primary" onclick="WhatsAppCoach.connect()" id="wa-connect-btn">📷 Conectar WhatsApp (QR Code)</button>
              <div class="wa-muted" id="wa-connect-status"></div>
            </div>
            <div class="wa-card">
              <div class="wa-card-title">Como funciona</div>
              <div class="wa-setup-step"><div class="wa-step-num">1</div><div>Preencha o <strong>briefing padrão</strong> ao lado e clique em conectar.</div></div>
              <div class="wa-setup-step"><div class="wa-step-num">2</div><div>No celular: <strong>WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho</strong> e aponte para o QR.</div></div>
              <div class="wa-setup-step"><div class="wa-step-num">3</div><div>As conversas que <strong>chegarem a partir dali</strong> aparecem aqui. Histórico antigo não é puxado.</div></div>
              <div class="wa-setup-step"><div class="wa-step-num">4</div><div>A cada mensagem do cliente, o coach escreve a resposta. Clique em <strong>Copiar</strong> e cole no WhatsApp.</div></div>
              <div class="wa-setup-step"><div class="wa-step-num">5</div><div>🔒 O SalesPulse <strong>nunca envia</strong> mensagem por você — quem responde o cliente é sempre você.</div></div>
            </div>
          </div>
        </div>
      </div>`;
    selectedProductIds = new Set((globalBrief?.products || []).map(p => String(p.id)));
  }

  function toggleProduct(el) {
    const id = String(el.dataset.id);
    if (selectedProductIds.has(id)) { selectedProductIds.delete(id); el.classList.remove('sel'); }
    else { selectedProductIds.add(id); el.classList.add('sel'); }
  }

  function collectBrief(idPrefix) {
    const products = availableProducts.filter(p => selectedProductIds.has(String(p.id)));
    const extra = (document.getElementById(`${idPrefix}-extra`)?.value || '').trim();
    if (products.length === 0 && !extra) return null;
    const sel = document.getElementById(`${idPrefix}-industry`);
    return {
      products: products.map(p => ({
        id: p.id, name: p.name, price: p.price || '',
        description: p.description || '', benefits: p.benefits || [],
      })),
      extraProduct: extra || null,
      industry: sel?.value || 'geral',
      industryLabel: sel?.options[sel.selectedIndex]?.text || 'Geral',
      directives: (document.getElementById(`${idPrefix}-directives`)?.value || '').trim() || null,
    };
  }

  // ══════════════════════════════════════
  // CONEXÃO — QR Code
  // ══════════════════════════════════════
  async function connect() {
    const statusEl = document.getElementById('wa-connect-status');
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

    const b = collectBrief('wa-brief');
    if (!b) { setStatus('⚠️ Selecione ao menos um produto (ou descreva o que vai vender).'); return; }
    globalBrief = b;
    try { await API.waSaveBriefing(globalBrief); } catch (e) {}

    const btn = document.getElementById('wa-connect-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    setStatus('Abrindo canal com o WhatsApp...');

    try {
      const st = await API.waConnect();
      applyStatus(st);
      renderConnect();
      pollConnect();
    } catch (e) {
      setStatus('Erro ao conectar: ' + (e?.message || e));
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
  }

  function applyStatus(st) {
    if (!st) return;
    status = st.status || 'idle';
    statusError = st.error || null;
    if (st.qr) qrImage = st.qr;
    if (st.status === 'connected') qrImage = null;
    if (st.phone) phone = st.phone;
    if (typeof st.seq === 'number' && st.seq > seq && !polling) seq = st.seq;
  }

  function renderConnect() {
    const overlay = overlayEl();
    const body = status === 'qr' && qrImage
      ? `<div class="wa-qr-box"><img src="${qrImage}" alt="QR Code do WhatsApp"></div>
         <div style="margin-top:1rem;font-weight:700">Escaneie com o WhatsApp do seu celular</div>
         <div class="wa-muted" style="margin-top:6px;line-height:1.6">WhatsApp → <strong>Configurações</strong> → <strong>Aparelhos conectados</strong><br>→ <strong>Conectar um aparelho</strong> → aponte a câmera</div>`
      : status === 'connected'
        ? `<div style="font-size:3rem">✅</div><div style="font-weight:700;margin-top:8px">Conectado${phone ? ` — ${esc(phone)}` : ''}</div>`
        : status === 'logged_out'
          ? `<div style="font-size:3rem">🔌</div><div style="font-weight:700;margin-top:8px">Sessão encerrada no celular</div><div class="wa-muted" style="margin-top:6px">Conecte novamente para gerar um QR novo.</div>`
          : status === 'error'
            ? `<div style="font-size:3rem">⚠️</div><div style="font-weight:700;margin-top:8px">Não foi possível conectar</div><div class="wa-muted" style="margin-top:6px">${esc(statusError || '')}</div>`
            : `<div class="wa-spinner"></div><div class="wa-muted" style="margin-top:14px">Gerando o QR Code...</div>`;

    overlay.innerHTML = `${styles()}
      <div class="wa-wrap">
        <div class="wa-header">
          <button class="wa-btn wa-btn-ghost" onclick="WhatsAppCoach.close()">← Voltar</button>
          <div class="wa-title">💬 WhatsApp Coach — Conectar</div>
          ${coachChip()}
        </div>
        <div style="display:flex;justify-content:center">
          <div class="wa-card" style="max-width:560px;width:100%;text-align:center;padding:2rem">
            ${body}
            ${(status === 'logged_out' || status === 'error') ? `
              <button class="wa-btn wa-btn-primary" style="margin-top:1.25rem" onclick="WhatsAppCoach.retryConnect()">🔄 Tentar de novo</button>` : ''}
            <div class="wa-warn" style="margin-top:1.5rem;text-align:left">
              🔒 O SalesPulse só <strong>lê</strong> as conversas para sugerir respostas — nunca envia mensagem em seu nome.
              Só entram conversas <strong>individuais</strong> que começarem a partir de agora (grupos e histórico antigo ficam de fora).
            </div>
          </div>
        </div>
      </div>`;
  }

  async function retryConnect() {
    status = 'connecting';
    qrImage = null;
    renderConnect();
    try {
      applyStatus(await API.waConnect());
      renderConnect();
      pollConnect();
    } catch (e) {
      status = 'error'; statusError = e?.message || String(e); renderConnect();
    }
  }

  // Espera o vendedor escanear: enquanto não conecta, só atualiza o QR
  function pollConnect() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    const tick = async () => {
      if (!open_ || polling) return;
      try {
        const st = await API.waStatus();
        const before = status;
        const beforeQr = qrImage;
        applyStatus(st);
        if (status === 'connected') { startLive(); return; }
        if (status !== before || qrImage !== beforeQr) renderConnect();
      } catch (e) { /* rede: tenta de novo no próximo tick */ }
      if (open_ && !polling) pollTimer = setTimeout(tick, 1500);
    };
    pollTimer = setTimeout(tick, 1200);
  }

  // ══════════════════════════════════════
  // CONVERSAS
  // ══════════════════════════════════════
  function newChat(evt) {
    return {
      jid: evt.jid,
      name: evt.name || evt.phone || 'Contato',
      phone: evt.phone || '',
      messages: [],
      tips: [],            // mais recente primeiro
      stage: null,
      temp: null,
      brief: null,         // null = usa o briefing padrão
      callId: null,
      creating: false,
      coachBusy: false,
      coachTimer: null,
      lastCoachedCount: 0,
      unread: 0,
      hasNewTip: false,
      lastAt: evt.t || Date.now(),
      dirty: false,
    };
  }

  function activeChat() {
    return activeJid ? chats.get(activeJid) : null;
  }

  function briefFor(chat) {
    return (chat && chat.brief) || globalBrief;
  }

  function startLive() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    polling = true;
    renderLive();
    poll();
    if (!saveTimer) saveTimer = setInterval(persistAll, SAVE_INTERVAL_MS);
    try { Notification.requestPermission(); } catch (e) {}
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    }
  }

  async function poll() {
    if (!polling || !open_) return;
    try {
      const res = await API.waEvents(seq);
      if (res) {
        if (res.status && res.status !== status) {
          status = res.status;
          renderStatusBar();
          if (status === 'logged_out' || status === 'error') { handleLost(); return; }
        }
        if (Array.isArray(res.events) && res.events.length) {
          if (typeof res.seq === 'number') seq = res.seq;
          res.events.forEach(applyEvent);
        }
      }
    } catch (e) { /* rede: próximo tick */ }
    if (polling && open_) pollTimer = setTimeout(poll, POLL_MS);
  }

  function handleLost() {
    polling = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    renderConnect();
  }

  function applyEvent(e) {
    let chat = chats.get(e.jid);
    if (!chat) {
      chat = newChat(e);
      chats.set(e.jid, chat);
      if (!activeJid) activeJid = e.jid;
    }
    if (e.name && e.name !== chat.name && !/^\+\d/.test(e.name)) chat.name = e.name;
    chat.messages.push({ t: e.t, speaker: e.speaker, text: e.text });
    chat.lastAt = e.t;
    chat.dirty = true;

    if (e.speaker === 'client') {
      if (chat.jid !== activeJid) chat.unread += 1;
      scheduleCoach(chat);
    } else {
      // O vendedor já respondeu por conta própria: a dica em preparo perdeu
      // o timing — cancela para não sugerir resposta a algo já respondido.
      if (chat.coachTimer) { clearTimeout(chat.coachTimer); chat.coachTimer = null; }
    }

    renderChatList();
    if (chat.jid === activeJid) renderMessages();
  }

  // Cliente costuma mandar 2-3 mensagens seguidas: espera a rajada terminar
  // antes de acionar o coach (equivale ao "cliente parou de falar" do áudio).
  function scheduleCoach(chat) {
    // A busca de metodologia roda DURANTE o debounce: quando a dica dispara,
    // o bloco certo já está em cache — latência de busca = zero. Falha aqui
    // jamais pode impedir o agendamento da dica.
    try { if (knowledge) knowledge.refresh(chatKnowledgeQuery(chat)); } catch (e) {}
    if (chat.coachTimer) clearTimeout(chat.coachTimer);
    chat.coachTimer = setTimeout(() => {
      chat.coachTimer = null;
      requestCoach(chat);
    }, COACH_DEBOUNCE_MS);
  }

  function chatKnowledgeQuery(chat) {
    const stageWord = chat.stage && STAGE_LABELS[chat.stage] ? STAGE_LABELS[chat.stage].label : '';
    return (chat.messages.slice(-4).map(m => m.text).join(' ').slice(-450) + ' ' + stageWord).trim();
  }

  // ══════════════════════════════════════
  // COACH — mesma cabeça do modo áudio, meio diferente
  // ══════════════════════════════════════
  // Sugestão sob demanda: o vendedor pediu a resposta agora (travou na
  // conversa). Ignora "nada novo desde a última dica", rotação e filtro de
  // similaridade — devolver nada seria a pior resposta possível.
  async function requestManualTip() {
    const chat = activeChat();
    if (!chat || chat.manualPending) return;
    chat.manualPending = true;
    renderCoach();
    try {
      await requestCoach(chat, true);
    } finally {
      chat.manualPending = false;
      renderCoach();
    }
  }

  async function requestCoach(chat, force) {
    if (!polling && !force) return;
    if (chat.coachBusy) {
      if (!force) return;
      const t0 = Date.now();
      while (chat.coachBusy && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 120));
      if (chat.coachBusy) return;
    }
    if (!force && chat.messages.length <= chat.lastCoachedCount) return;
    const brief = briefFor(chat);
    if (!brief) return;

    chat.coachBusy = true;
    const sinceCount = chat.messages.length;

    try {
      const now = Date.now();
      const recent = chat.messages.slice(-CONTEXT_MSGS)
        .map(m => `[${agoLabel(m.t)}] ${m.speaker === 'seller' ? 'VENDEDOR' : 'CLIENTE'}: ${m.text}`)
        .join('\n');

      const profileBlock = profile
        ? `\nPERFIL CONHECIDO DO VENDEDOR (aprendido em chamadas anteriores — personalize a dica com base nele):\n${JSON.stringify(profile)}\n`
        : '';

      const tipHistoryBlock = chat.tips.length
        ? `\nDICAS QUE VOCÊ JÁ DEU NESTA CONVERSA (mais recente primeiro — NÃO as repita):\n${chat.tips.slice(0, 6)
            .map(t => `- [${fmtTime(t.t)} · ${t.technique || 'sem técnica'} · ${t.priority}] ${t.tip}${t.say ? ` | say: "${String(t.say).slice(0, 90)}"` : ''}`)
            .join('\n')}\n`
        : '';

      // Metodologia do coach: bloco já buscado durante o debounce (zero
      // espera). Falha aqui degrada para "sem metodologia", nunca "sem dica".
      let methodologyBlock = '';
      try {
        methodologyBlock = knowledge ? knowledge.getCached() : '';
        if (knowledge) knowledge.refresh(chatKnowledgeQuery(chat));
      } catch (e) { methodologyBlock = ''; }

      // Bloco estático primeiro (persona + playbook + formato) e dinâmico por
      // último: ativa o cache de prompt da OpenAI e derruba a latência.
      const prompt = `${CoachCore.persona(coach)}, acompanhando em silêncio uma conversa de vendas REAL por WhatsApp. O VENDEDOR é seu aluno; você escreve a MENSAGEM PRONTA que ele deve enviar AGORA. Quando o cliente escreve, capte o subtexto (resposta seca ou monossilábica = desinteresse ou pressa; "vou ver", "depois te falo" = objeção não dita; pergunta sobre preço/prazo/contrato = sinal de compra; áudio/vídeo enviado = quer atenção e detalhe; tema que volta = objeção real disfarçada) e escreva a resposta perfeita, espelhando as palavras dele.
${CoachCore.coreBlock(coachCore)}${CoachCore.playsMenu(coachPlays)}
${CoachCore.playbook('whatsapp')}

FORMATO DO "say" (é a mensagem que o vendedor vai COPIAR e COLAR no WhatsApp — precisa servir sem edição):
- Escreva o TEXTO EXATO a ser enviado. Nada de instrução ("diga que...", "pergunte se..."), nada de colchetes, nada de reticências de preenchimento.
- Texto puro: SEM **asteriscos**, sem markdown, sem aspas envolvendo a mensagem, sem assinatura.
- Quebra de linha só se a mensagem realmente pedir (ex: 2-3 itens curtos). Prefira um parágrafo só.
- Nunca escreva "(PAUSA)" nem instruções de entonação: aqui ninguém fala, se escreve.

REGRA DE OURO DO OUTPUT: tip e say andam JUNTOS. Ou você retorna os dois preenchidos (o diagnóstico E a mensagem pronta), ou retorna tip=null e say=null (silêncio). NUNCA retorne um tip sem say — dica sem a mensagem pronta é inútil e será descartada pelo sistema.

Retorne SÓ JSON (nunca escreva meta-texto, instruções ou a palavra "null" dentro dos textos):
{
 "play": <NÚMERO da jogada do catálogo que esta dica executa — obrigatório quando houver dica>,
 "tip": "diagnóstico interno em até 10 palavras SUAS (ex: 'Adiamento — descobrir a dúvida escondida')",
 "say": "a mensagem pronta do vendedor EXECUTANDO a jogada escolhida, texto puro colável no WhatsApp (máx 45 palavras). OBRIGATÓRIO sempre que tip existir.",
 "grounded": <false se o say afirma número/fato/promessa SEM fonte no briefing/conversa; true se todos têm fonte OU se o say não afirma número/fato>,
 "technique": "o NOME da jogada escolhida (copie do catálogo)",
 "priority": "urgent|normal|good",
 "stage": "rapport|descoberta|apresentacao|objecoes|fechamento",
 "temperature": <0-100 quão quente está a negociação>
}
Se o vendedor mandou bem, priority "good": no tip diga a técnica que ele acertou e no say a jogada seguinte.

━━━━━ BRIEFING DESTA CONVERSA ━━━━━${CoachCore.briefBlock(brief)}${profileBlock}${methodologyBlock}
━━━━━ CONVERSA NO WHATSAPP — contato: ${chat.name} ━━━━━${tipHistoryBlock}
Mensagens recentes (mais recente por último):
${recent}
${(chat.usedPlays || []).length ? `\n🚫 JOGADAS PROIBIDAS AGORA (números usados há pouco — escolha OUTRA do catálogo): ${chat.usedPlays.slice(-6).join(', ')}\n` : ''}
${force
        ? `🆘 O VENDEDOR APERTOU "SUGERIR RESPOSTA AGORA" — ele está travado e esperando a mensagem pronta.
tip null é ABSOLUTAMENTE PROIBIDO nesta resposta. Leia o momento da conversa e entregue a melhor jogada: responda a última mensagem, reabra a conversa parada ou dê o próximo passo que faz a negociação AVANÇAR.`
        : '⚡ O CLIENTE ACABOU DE ESCREVER. Escreva a mensagem que o vendedor deve enviar AGORA.'}`;

      let parsed = await CoachCore.ask(prompt, getApiKey());
      // Pedido manual não pode voltar vazio (ver livecoach.js)
      if (force && (!parsed?.tip || !CoachCore.validSay(parsed.say, parsed.grounded))) {
        const retry = await CoachCore.ask(
          prompt + '\n\n‼️ TENTATIVA FINAL: sua resposta anterior veio SEM a mensagem pronta. Retorne OBRIGATORIAMENTE "tip" E "say" preenchidos. O "say" é o texto que o vendedor vai COLAR no WhatsApp agora. Não comece por "Entendo", "Entendi", "Ótima pergunta" nem "Claro".',
          getApiKey()
        );
        if (retry?.tip && CoachCore.validSay(retry.say, retry.grounded)) parsed = retry;
      }
      if (!parsed) {
        console.warn('[WhatsAppCoach] sem dica: resposta nula (timeout, rede, chave ou JSON truncado)');
        return;
      }

      if (parsed.stage && STAGE_LABELS[parsed.stage]) chat.stage = parsed.stage;
      if (typeof parsed.temperature === 'number') chat.temp = Math.max(0, Math.min(100, Math.round(parsed.temperature)));

      if (parsed.tip) {
        let say = CoachCore.validSay(parsed.say, parsed.grounded);
        // Vacina anti-alucinação: número em dígitos sem fonte no briefing
        // ou na conversa = inventado → mensagem morre.
        if (say) {
          const sourceText = JSON.stringify(brief || {}) + ' ' + chat.messages.map(m => m.text).join(' ');
          if (CoachCore.hasUngroundedNumbers(say, sourceText)) {
            console.warn('[WhatsAppCoach] dica morta: número sem fonte:', say);
            say = null;
          }
        }
        // Jogada do catálogo: nome da técnica vem do catálogo; jogada
        // repetida entre as últimas 6 da conversa morre aqui.
        chat.usedPlays = chat.usedPlays || [];
        const { play, banned } = CoachCore.resolvePlay(parsed, coachPlays, chat.usedPlays);
        if (say && banned && parsed.priority !== 'urgent' && !force) {
          console.warn('[WhatsAppCoach] dica descartada: jogada repetida —', play.n, play.name);
          say = null;
        }
        // Sem mensagem pronta não há dica. E se a conversa andou muito
        // enquanto gerava, o assunto mudou — descarta (exceto urgente).
        const grewBy = chat.messages.length - sinceCount;
        if (say && (force || grewBy < 3 || parsed.priority === 'urgent')) {
          const prio = parsed.priority || 'normal';
          const tip = {
            t: Date.now(),
            tip: parsed.tip,
            say,
            technique: play ? play.name : (parsed.technique || null),
            priority: prio,
            icon: prio === 'urgent' ? '🔥' : prio === 'good' ? '✅' : '💬',
            onDemand: !!force,
          };
          if (force) {
            if (play) chat.usedPlays.push(play.n);
            addTip(chat, tip); // pedido explícito entra sem filtro
          } else if (CoachCore.repeatsTechnique(tip, chat.tips)) {
            console.log('[WhatsAppCoach] dica descartada: técnica repetida —', tip.technique);
          } else if (!CoachCore.tooSimilar(tip, chat.tips)) {
            if (play) chat.usedPlays.push(play.n);
            addTip(chat, tip);
          }
        } else if (force) {
          UI.toast?.('Não consegui uma sugestão segura agora — tente de novo em instantes.', 'warning');
        }
      }
      chat.lastCoachedCount = sinceCount;
    } catch (e) {
      console.warn('[WhatsAppCoach] coach fail', e?.message);
    } finally {
      chat.coachBusy = false;
    }
  }

  function addTip(chat, tip) {
    chat.tips.unshift(tip);
    if (chat.tips.length > MAX_TIPS_KEPT) chat.tips.length = MAX_TIPS_KEPT;
    chat.dirty = true;
    if (chat.jid !== activeJid) chat.hasNewTip = true;
    renderChatList();
    if (chat.jid === activeJid) renderCoach();
    playChime(tip.priority);
    try {
      if (document.hidden && Notification.permission === 'granted') {
        new Notification(`💬 ${chat.name}`, { body: tip.say.slice(0, 180), tag: 'wacoach-' + chat.jid });
      }
    } catch (e) {}
  }

  let lastChimeAt = 0;
  function playChime(priority) {
    if (!tipSoundOn || !audioCtx) return;
    const now = Date.now();
    if (priority === 'normal' && now - lastChimeAt < 20000) return;
    lastChimeAt = now;
    try {
      const t0 = audioCtx.currentTime;
      const freqs = priority === 'urgent' ? [740, 988] : priority === 'good' ? [660, 880] : [587, 784];
      freqs.forEach((f, i) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.09);
        g.gain.linearRampToValueAtTime(0.05, t0 + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.11);
        osc.connect(g); g.connect(audioCtx.destination);
        osc.start(t0 + i * 0.09);
        osc.stop(t0 + i * 0.09 + 0.12);
      });
    } catch (e) {}
  }

  function toggleSound() {
    tipSoundOn = !tipSoundOn;
    const btn = document.getElementById('wa-sound-btn');
    if (btn) btn.textContent = tipSoundOn ? '🔔' : '🔕';
  }

  // ══════════════════════════════════════
  // PERSISTÊNCIA — cada conversa vira uma linha em live_calls
  // ══════════════════════════════════════
  async function persistAll() {
    for (const chat of chats.values()) {
      if (!chat.dirty || chat.messages.length === 0) continue;
      try {
        if (!chat.callId) {
          if (chat.creating) continue;
          chat.creating = true;
          const created = await API.createLiveCall(briefFor(chat) || {}, { channel: 'whatsapp', contactName: chat.name });
          chat.callId = created?.id || null;
          chat.creating = false;
          if (!chat.callId) continue;
        }
        chat.dirty = false;
        await API.updateLiveCall(chat.callId, {
          transcript: chat.messages.map(m => ({ t: m.t, speaker: m.speaker, text: m.text })),
          tips: chat.tips,
        });
      } catch (e) {
        chat.creating = false;
        chat.dirty = true; // tenta de novo no próximo ciclo
      }
    }
  }

  // ══════════════════════════════════════
  // RENDER — dashboard ao vivo
  // ══════════════════════════════════════
  function renderLive() {
    const overlay = overlayEl();
    overlay.innerHTML = `${styles()}
      <div class="wa-wrap wa-live">
        <div class="wa-header" id="wa-statusbar">${statusBarHtml()}</div>
        <div class="wa-grid">
          <div class="wa-col">
            <div class="wa-card" style="flex:1;padding:0.9rem">
              <div class="wa-card-title">📇 Conversas <span class="wa-muted" style="text-transform:none;letter-spacing:0">(desde a conexão)</span></div>
              <div class="wa-scroll" id="wa-chatlist"></div>
            </div>
          </div>
          <div class="wa-col">
            <div class="wa-card" style="flex:1;padding:0.9rem 1.1rem">
              <div id="wa-conv-head"></div>
              <div class="wa-scroll" id="wa-messages"><div class="wa-msgs"></div></div>
            </div>
          </div>
          <div class="wa-col wa-col-right" id="wa-right"></div>
        </div>
      </div>`;
    renderChatList();
    renderMessages();
    renderCoach();
  }

  function statusBarHtml() {
    const connected = status === 'connected';
    return `
      <div class="wa-title">${connected ? '<span class="wa-dot"></span>' : ''}💬 WhatsApp Coach</div>
      <div class="wa-chip" style="${connected ? 'border-color:rgba(37,211,102,0.45);color:#7dead0' : ''}">${connected ? `✅ Conectado${phone ? ` · ${esc(phone)}` : ''}` : '⏳ ' + esc(status)}</div>
      ${coachChip()}
      <div class="wa-chip">${chats.size} conversa${chats.size === 1 ? '' : 's'}</div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <button class="wa-btn wa-btn-ghost wa-btn-sm" id="wa-sound-btn" onclick="WhatsAppCoach.toggleSound()" title="Som de dica">${tipSoundOn ? '🔔' : '🔕'}</button>
        <button class="wa-btn wa-btn-ghost wa-btn-sm" onclick="WhatsAppCoach.close()">← Sair</button>
        <button class="wa-btn wa-btn-danger wa-btn-sm" onclick="WhatsAppCoach.disconnect()">⏻ Desconectar WhatsApp</button>
      </div>`;
  }

  function renderStatusBar() {
    const el = document.getElementById('wa-statusbar');
    if (el) el.innerHTML = statusBarHtml();
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function renderChatList() {
    const el = document.getElementById('wa-chatlist');
    if (!el) return;
    const list = [...chats.values()].sort((a, b) => b.lastAt - a.lastAt);
    renderStatusBar(); // o contador de conversas do topo vive lá
    if (!list.length) {
      el.innerHTML = `<div class="wa-muted" style="line-height:1.6;padding:8px 2px">Aguardando as primeiras mensagens...<br><br>Assim que alguém escrever para você (ou você escrever para alguém), a conversa aparece aqui.</div>`;
      return;
    }
    el.innerHTML = list.map(c => {
      const last = c.messages[c.messages.length - 1];
      return `
        <div class="wa-conv${c.jid === activeJid ? ' active' : ''}" onclick="WhatsAppCoach.selectChat('${esc(c.jid)}')">
          <div class="wa-avatar">${esc(initials(c.name))}</div>
          <div class="wa-conv-info">
            <div class="wa-conv-name">${esc(c.name)}</div>
            <div class="wa-conv-last">${last ? esc((last.speaker === 'seller' ? 'Você: ' : '') + last.text).slice(0, 60) : ''}</div>
          </div>
          ${c.hasNewTip ? '<span class="wa-badge tip">💡</span>' : ''}
          ${c.unread ? `<span class="wa-badge">${c.unread}</span>` : ''}
        </div>`;
    }).join('');
  }

  function selectChat(jid) {
    const chat = chats.get(jid);
    if (!chat) return;
    activeJid = jid;
    chat.unread = 0;
    chat.hasNewTip = false;
    editingOverrideJid = null;
    renderChatList();
    renderMessages();
    renderCoach();
  }

  function renderMessages() {
    const head = document.getElementById('wa-conv-head');
    const box = document.getElementById('wa-messages');
    if (!head || !box) return;
    const chat = activeChat();
    if (!chat) {
      head.innerHTML = `<div class="wa-card-title">💬 Conversa</div>`;
      box.innerHTML = `<div class="wa-muted">Selecione uma conversa à esquerda.</div>`;
      return;
    }
    head.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:0.8rem;flex-wrap:wrap">
        <div class="wa-avatar">${esc(initials(chat.name))}</div>
        <div>
          <div style="font-weight:800;font-size:0.95rem">${esc(chat.name)}</div>
          <div class="wa-muted">${esc(chat.phone)} · ${chat.messages.length} mensagens</div>
        </div>
        <button class="wa-btn wa-btn-ghost wa-btn-sm" style="margin-left:auto" onclick="WhatsAppCoach.editOverride()">
          ${chat.brief ? '✏️ Briefing próprio' : '🎯 Ajustar briefing'}
        </button>
      </div>`;
    box.innerHTML = `<div class="wa-msgs">${chat.messages.map(m =>
      `<div class="wa-msg ${m.speaker}">` +
        `<div class="wa-msg-who">${m.speaker === 'seller' ? '🟢 Você' : '👤 ' + esc(chat.name)}<span class="wa-msg-time">${fmtTime(m.t)}</span></div>` +
        `<div class="wa-msg-text">${esc(m.text)}</div>` +
      `</div>`).join('')}</div>`;
    box.scrollTop = box.scrollHeight;
  }

  const HERO_LABELS = { urgent: '⚡ RESPONDA AGORA', normal: '💬 RESPONDA ASSIM', good: '✅ MANDOU BEM' };

  function renderCoach() {
    const el = document.getElementById('wa-right');
    if (!el) return;
    const chat = activeChat();

    if (editingOverrideJid && chat && editingOverrideJid === chat.jid) {
      el.innerHTML = `
        <div class="wa-card">
          <div class="wa-card-title">🎯 Briefing de "${esc(chat.name)}"</div>
          <div class="wa-muted" style="margin-bottom:0.9rem">Vale só para esta conversa. Sem ajuste, ela usa o briefing padrão.</div>
          ${briefFormHtml(briefFor(chat), 'wa-ovr')}
          <div style="display:flex;gap:8px;margin-top:1.1rem">
            <button class="wa-btn wa-btn-primary" style="flex:1;justify-content:center" onclick="WhatsAppCoach.saveOverride()">Salvar</button>
            <button class="wa-btn wa-btn-ghost" onclick="WhatsAppCoach.cancelOverride()">Cancelar</button>
          </div>
          ${chat.brief ? `<button class="wa-btn wa-btn-ghost wa-btn-block" style="margin-top:8px" onclick="WhatsAppCoach.clearOverride()">↺ Voltar ao briefing padrão</button>` : ''}
        </div>`;
      selectedProductIds = new Set((briefFor(chat)?.products || []).map(p => String(p.id)));
      return;
    }

    const tips = chat ? chat.tips : [];
    const hero = tips[0] || null;
    const history = tips.slice(1, 7);
    const stale = hero && (Date.now() - hero.t) > 120000;

    el.innerHTML = `
      <div class="wa-card">
        <div class="wa-card-title">💡 Resposta sugerida</div>
        ${chat ? `<button class="wa-ask-btn" id="wa-ask-btn" onclick="WhatsAppCoach.askTip()" ${chat.manualPending ? 'disabled' : ''}>${chat.manualPending ? '<span class="wa-ask-spin"></span> Pensando na melhor jogada...' : '💡 Sugerir resposta agora'}</button>` : ''}
        ${!chat ? '<div class="wa-muted">Selecione uma conversa para ver as sugestões.</div>'
          : !hero ? '<div class="wa-muted">Assim que o cliente escrever, a resposta pronta aparece aqui — ou peça uma agora no botão acima.</div>'
          : `
          <div class="wa-hero ${hero.priority}${stale ? ' stale' : ''}">
            <div class="wa-hero-top">
              <span class="wa-hero-label">${hero.onDemand ? '💡 VOCÊ PEDIU' : (HERO_LABELS[hero.priority] || HERO_LABELS.normal)}</span>
              ${hero.technique ? `<span class="wa-tech-chip">📐 ${esc(hero.technique)}</span>` : ''}
            </div>
            <div class="wa-say">
              <div class="wa-say-label">📋 COPIE E COLE NO WHATSAPP</div>
              <div class="wa-say-text" id="wa-say-text">${esc(hero.say)}</div>
              <div class="wa-say-actions">
                <button class="wa-copy-btn" id="wa-copy-btn" onclick="WhatsAppCoach.copySay()">📋 Copiar mensagem</button>
              </div>
            </div>
            <div class="wa-hero-why"><span>${hero.icon || '💬'}</span><span>${esc(hero.tip)}</span></div>
            <div class="wa-hero-fresh"><span>${agoLabel(hero.t)}</span><span>${fmtTime(hero.t)}</span></div>
          </div>
          ${history.length ? `<div class="wa-hist-divider">Anteriores</div>` : ''}
          ${history.map((t, i) => `
            <div class="wa-hist" style="opacity:${Math.max(0.35, 0.85 - i * 0.12)}">
              <span>${t.icon || '💬'}</span>
              <span>${esc(t.tip)}${t.technique ? ` <em style="color:#6b6b8f;font-style:normal">· ${esc(t.technique)}</em>` : ''}</span>
              <span class="wa-hist-time">${fmtTime(t.t)}</span>
            </div>`).join('')}`}
      </div>

      <div class="wa-card">
        <div class="wa-card-title">🌡 Termômetro da negociação</div>
        ${chat && (chat.stage || chat.temp !== null) ? `
          ${chat.stage && STAGE_LABELS[chat.stage] ? `<div class="wa-stage-row"><span class="wa-chip" style="border-color:rgba(37,211,102,0.4);background:rgba(37,211,102,0.12)">${STAGE_LABELS[chat.stage].icon} Estágio: <strong>&nbsp;${STAGE_LABELS[chat.stage].label}</strong></span></div>` : ''}
          ${chat.temp !== null ? `
            <div class="wa-stage-row">
              <span style="font-size:0.82rem">🌡</span>
              <div class="wa-temp-track"><div class="wa-temp-fill" style="width:${chat.temp}%;background:${tempColor(chat.temp)}"></div></div>
              <strong style="color:${tempColor(chat.temp)};font-size:0.9rem">${chat.temp}%</strong>
            </div>
            <div class="wa-muted">${chat.temp >= 70 ? 'Negociação quente — considere avançar para o fechamento.' : chat.temp >= 40 ? 'Interesse moderado — continue explorando a dor e gerando valor.' : 'Cliente frio — foque em rapport e descoberta antes de vender.'}</div>` : ''}
        ` : '<div class="wa-muted">Analisando as primeiras mensagens...</div>'}
      </div>

      ${(() => { const b = briefFor(chat); return b ? `
      <div class="wa-card" style="padding:0.9rem 1.1rem">
        <div class="wa-card-title" style="margin-bottom:0.5rem">🎯 Briefing ativo ${chat && chat.brief ? '<span style="color:#ffd25c">(só desta conversa)</span>' : '(padrão)'}</div>
        ${(b.products || []).map(p => `<span class="wa-brief-chip">📦 ${esc(p.name)}</span>`).join('')}
        ${b.extraProduct ? `<span class="wa-brief-chip">📦 ${esc(b.extraProduct)}</span>` : ''}
        <span class="wa-brief-chip" style="border-color:rgba(108,99,255,0.35);background:rgba(108,99,255,0.1);color:#c3beff">${esc(b.industryLabel || 'Geral')}</span>
        ${b.directives ? `<div class="wa-muted" style="margin-top:6px;line-height:1.45">📋 ${esc(b.directives.slice(0, 160))}${b.directives.length > 160 ? '…' : ''}</div>` : ''}
      </div>` : ''; })()}

      <div class="wa-card" style="padding:0.9rem 1.1rem">
        <div class="wa-warn">🔒 Somente leitura: o SalesPulse nunca envia mensagem por você. Copie a sugestão e cole no seu WhatsApp.</div>
      </div>`;
  }

  async function copySay() {
    const chat = activeChat();
    const tip = chat && chat.tips[0];
    if (!tip) return;
    const btn = document.getElementById('wa-copy-btn');
    try {
      await navigator.clipboard.writeText(tip.say);
    } catch (e) {
      // clipboard bloqueado (http, permissão): seleciona o texto para Ctrl+C
      const el = document.getElementById('wa-say-text');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
      }
      if (btn) { btn.textContent = '⌨️ Selecionado — use Ctrl+C'; btn.classList.add('done'); }
      return;
    }
    if (btn) {
      btn.textContent = '✅ Copiado! Cole no WhatsApp';
      btn.classList.add('done');
      setTimeout(() => {
        const b2 = document.getElementById('wa-copy-btn');
        if (b2) { b2.textContent = '📋 Copiar mensagem'; b2.classList.remove('done'); }
      }, 2500);
    }
  }

  // ── Briefing por conversa ──
  function editOverride() {
    const chat = activeChat();
    if (!chat) return;
    editingOverrideJid = chat.jid;
    renderCoach();
  }

  function saveOverride() {
    const chat = activeChat();
    if (!chat) return;
    const b = collectBrief('wa-ovr');
    if (!b) { try { UI.toast('Selecione ao menos um produto (ou descreva o que vai vender).', 'warning'); } catch (e) {} return; }
    chat.brief = b;
    editingOverrideJid = null;
    renderCoach();
    try { UI.toast(`Briefing de ${chat.name} atualizado.`, 'success'); } catch (e) {}
  }

  function clearOverride() {
    const chat = activeChat();
    if (!chat) return;
    chat.brief = null;
    editingOverrideJid = null;
    renderCoach();
  }

  function cancelOverride() {
    editingOverrideJid = null;
    renderCoach();
  }

  // ══════════════════════════════════════
  // ENCERRAMENTO
  // ══════════════════════════════════════
  async function disconnect() {
    if (!confirm('Desconectar o WhatsApp? O SalesPulse deixa de acompanhar as conversas e você precisará escanear o QR de novo.')) return;
    polling = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    await persistAll();
    try { await API.waDisconnect(); } catch (e) {}
    status = 'idle';
    qrImage = null;
    phone = null;
    chats.clear();
    activeJid = null;
    seq = 0;
    renderSetup();
  }

  function close() {
    // A sessão do WhatsApp continua viva no servidor de propósito: sair da
    // tela não deve derrubar a conexão que o vendedor acabou de escanear.
    polling = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
    persistAll();
    open_ = false;
    const overlay = document.getElementById('wacoach-overlay');
    if (overlay) overlay.style.display = 'none';
    // Volta para a escolha de modalidade, de onde este modo foi aberto
    try { LiveCoach.renderModeChooser(); } catch (e) {}
  }

  return {
    open, close, connect, retryConnect, disconnect,
    toggleProduct, selectChat, copySay, toggleSound,
    editOverride, saveOverride, clearOverride, cancelOverride,
    askTip: requestManualTip,
  };
})();

window.WhatsAppCoach = WhatsAppCoach;
