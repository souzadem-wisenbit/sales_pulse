// ================================================
// SALESPULSE — Seller Chat Interface (v2 — Advanced)
// ================================================

const Seller = (() => {

  let messages        = [];
  let config          = {};
  let conviction      = 0;
  let sessionStartAt  = null;
  let timerInterval   = null;
  let durationSeconds = 0;
  let isWaiting       = false;
  let sessionEnded    = false;
  let criteriaScores  = { rapport: 0, discovery: 0, value: 0, objections: 0, closing: 0, professionalism: 0 };
  let tricks          = 0;
  let coachMsgCount   = 0; // counter to trigger coach every 2-3 msgs
  let agendaHinted    = false;
  let agendaRevealed  = false;
  let xrayMsgCount    = 0;
  let xrayShown       = false;
  let interruptionTimer = null;

  // ══════════════════════════════════════
  // INIT
  // ══════════════════════════════════════
  function buildConfigForSession(session, user) {
    const globalConfig = Storage.getConfig();
    const allClients = Storage.getClients ? Storage.getClients() : [];
    const clientId = session.clientId || session.client_id;
    const client = allClients.find(c => String(c.id) === String(clientId));
    if (!client) return null;

    const allProducts = Storage.getProducts ? Storage.getProducts() : [];
    const clientProds = allProducts.filter(p => (p.clientesAtribuidos||[]).map(String).includes(String(client.id)));
    const sellerProds = allProducts.filter(p => (p.vendedoresAtribuidos||[]).map(String).includes(String(user.id)));
    let intersectedProducts = clientProds.filter(cp => sellerProds.some(sp => String(sp.id) === String(cp.id)));
    if (intersectedProducts.length === 0) intersectedProducts = clientProds;
    if (intersectedProducts.length === 0) intersectedProducts = sellerProds;
    const firstProd = intersectedProducts[0];

    const pendingSessions = (typeof Storage.getScheduledSessionsForSeller === 'function') ? Storage.getScheduledSessionsForSeller(user.id) : [];

    return {
      productName:        firstProd ? firstProd.name        : '',
      productPrice:       firstProd ? firstProd.price       : '',
      productDescription: firstProd ? firstProd.description : '',
      productBenefits:    firstProd ? (firstProd.benefits || []) : [],
      productObjections:  firstProd ? (firstProd.objections || []) : [],
      products:           intersectedProducts,
      openaiKey:          globalConfig.openaiKey,
      openaiModel:        globalConfig.openaiModel,
      hintsEnabled:       globalConfig.hintsEnabled,
      maxMinutes:         globalConfig.maxMinutes,
      passingScore:       globalConfig.passingScore,
      weights:            globalConfig.weights,
      customerName:       client.name,
      customerRole:       client.role,
      customerCompany:    client.company,
      customerEmoji:      client.emoji || '👤',
      customerStyle:      client.customerStyle || 'formal',
      scenarioIndustry:   client.industry || '',
      difficulty:         client.difficulty || 'medium',
      skepticism:         client.skepticism ?? globalConfig.skepticism,
      urgency:            client.urgency ?? globalConfig.urgency,
      priceSensitivity:   client.priceSensitivity ?? globalConfig.priceSensitivity,
      productKnowledge:   client.productKnowledge ?? globalConfig.productKnowledge,
      negotiationWill:    client.negotiationWill ?? globalConfig.negotiationWill,
      trickFrequency:     client.trickFrequency ?? globalConfig.trickFrequency,
      trickTypes:         client.trickTypes?.length ? client.trickTypes : globalConfig.trickTypes,
      buyingTriggers:     client.buyingTriggers?.length ? client.buyingTriggers : globalConfig.buyingTriggers,
      dealbreakers:       client.dealbreakers?.length ? client.dealbreakers : globalConfig.dealbreakers,
      humanidade:         client.humanidade,
      formalidade:        client.formalidade,
      nivelErros:         client.nivelErros,
      nivelGirias:        client.nivelGirias,
      sotaqueRegiao:      client.sotaqueRegiao,
      velocidadeResposta: client.velocidadeResposta,
      emotividade:        client.emotividade,
      nivelTecnico:       client.nivelTecnico,
      objetividade:       client.objetividade,
      usaAbreviacoes:     client.usaAbreviacoes,
      usaMaiusculas:      client.usaMaiusculas,
      usaEmojis:          client.usaEmojis,
      fazPerguntas:       client.fazPerguntas,
      archetype:          client.archetype || null,
      hiddenAgenda:       client.hiddenAgenda || null,
      marketSegment:      client.marketSegment || 'generico',
      hostileMode:        client.hostileMode || false,
      hostileCompetitors: client.hostileCompetitors || [],
      sessionConstraints: client.sessionConstraints || {},
      customBehavior:     client.customBehavior || '',
      _drawnClientId:     client.id,
      _totalAssigned:     pendingSessions.length,
      _pendingSessionId:  session.id,
      _showRealtime:      session.showRealtime ?? true,
      _showReport:        session.showReport ?? true,
    };
  }

  function init() {
    const user = Auth.getUser();
    if (!user || user.role !== 'seller') {
      Auth.logout();
      return;
    }

    const settings = Storage.getSettings ? Storage.getSettings() : {};
    const globalConfig = Storage.getConfig();
    if (!globalConfig.openaiKey && !settings.openaiKey) {
      renderNoApiError();
      return;
    }

    const pendingSessions = (typeof Storage.getScheduledSessionsForSeller === 'function')
      ? Storage.getScheduledSessionsForSeller(user.id)
      : [];

    showDashboard(user, pendingSessions.length);
  }

  function renderNoApiError() {
    const page = document.getElementById('page-seller');
    if (page) page.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:var(--sp-6)">
        <div class="card text-center" style="max-width:480px;padding:var(--sp-10)">
          <div style="font-size:3rem;margin-bottom:var(--sp-4)">🔑</div>
          <h3 style="margin-bottom:var(--sp-3)">API Key não configurada</h3>
          <p style="margin-bottom:var(--sp-6)">O gestor precisa configurar a chave de API OpenAI em <strong>Configurações</strong> para que o treinamento funcione.</p>
          <button class="btn btn-ghost" onclick="Auth.logout()">← Sair da Conta</button>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════
  // SELLER DASHBOARD (HUB)
  // ══════════════════════════════════════
  function showDashboard(user, totalAssigned) {
    const page = document.getElementById('page-seller');
    if (!page) return;

    const allSessions = Storage.getSessionsBySeller(user.id);
    const avgScore = allSessions.length > 0 
      ? Math.round(allSessions.reduce((s, ss) => s + (ss.result?.total || 0), 0) / allSessions.length)
      : 0;
    const bestScore = allSessions.length > 0
      ? Math.max(...allSessions.map(ss => ss.result?.total || 0))
      : 0;
    const lastSession = allSessions[allSessions.length - 1];
    const lastScore = lastSession?.result?.total || null;
    const scoreTrend = (lastScore !== null && avgScore > 0)
      ? (lastScore >= avgScore ? '↗ acima da média' : '↘ abaixo da média')
      : '';

    const recentSessions = allSessions.slice(-3).reverse();

    page.innerHTML = `
      <style>
        .seller-dashboard { min-height: 100vh; background: #07070f; position: relative; overflow: hidden; }

        .seller-bg-orb { position: absolute; border-radius: 50%; filter: blur(80px); pointer-events: none; z-index: 0; }

        .seller-hero {
          display: flex; justify-content: space-between; align-items: center;
          padding: 2rem 2.5rem; flex-wrap: wrap; gap: 1rem;
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        @media (max-width: 600px) {
          .seller-hero {
            flex-direction: column;
            text-align: center;
            padding: 1.5rem;
          }
          .seller-hero-left { justify-content: center; flex-direction: column; gap: 0.5rem; }
          .seller-hero-right { justify-content: center; width: 100%; }
        }

        .seller-hero-left { display: flex; align-items: center; gap: 1.25rem; }

        .seller-avatar-ring {
          width: 62px; height: 62px; border-radius: 50%;
          background: linear-gradient(135deg, #6c63ff, #00d4aa);
          display: flex; align-items: center; justify-content: center;
          font-size: 1.6rem; font-weight: 800; color: white;
          box-shadow: 0 0 30px rgba(108,99,255,0.5);
          animation: avatarPulse 3s ease infinite;
        }

        @keyframes avatarPulse {
          0%, 100% { box-shadow: 0 0 20px rgba(108,99,255,0.4); }
          50% { box-shadow: 0 0 40px rgba(108,99,255,0.7), 0 0 60px rgba(0,212,170,0.2); }
        }

        .seller-welcome-name { font-size: 1.5rem; font-weight: 800; color: #e8e8f0; margin: 0 0 2px; }
        .seller-welcome-sub { font-size: 0.85rem; color: #5a5a7a; }

        .seller-stats-strip {
          position: relative; z-index: 1;
          display: grid; grid-template-columns: repeat(3, 1fr);
          gap: 1px; background: rgba(255,255,255,0.04);
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .stat-pill {
          background: rgba(7,7,15,0.9);
          padding: 1.5rem 2rem;
          display: flex; align-items: center; gap: 1rem;
          transition: background 0.25s;
          cursor: default;
        }

        .stat-pill:hover { background: rgba(108,99,255,0.05); }

        .stat-icon {
          width: 48px; height: 48px; border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          font-size: 1.4rem; flex-shrink: 0;
        }

        .stat-icon.purple { background: rgba(108,99,255,0.15); box-shadow: 0 0 20px rgba(108,99,255,0.2); }
        .stat-icon.teal   { background: rgba(0,212,170,0.15);  box-shadow: 0 0 20px rgba(0,212,170,0.2); }
        .stat-icon.gold   { background: rgba(255,165,2,0.12);  box-shadow: 0 0 20px rgba(255,165,2,0.15); }

        .stat-number { font-size: 2rem; font-weight: 900; color: #e8e8f0; line-height: 1; }
        .stat-label  { font-size: 0.72rem; font-weight: 700; color: #5a5a7a; text-transform: uppercase; letter-spacing: 1px; margin-top: 3px; }
        .stat-trend  { font-size: 0.7rem; color: var(--success); margin-top: 2px; }

        .seller-body {
          position: relative; z-index: 1;
          display: grid; grid-template-columns: 1fr 360px;
          gap: 2rem; padding: 2rem 2.5rem;
          max-width: 1100px; margin: 0 auto;
        }
        @media (max-width: 900px) {
          .seller-body {
            grid-template-columns: 1fr;
            padding: 1rem;
            gap: 1rem;
          }
          .seller-stats-strip {
            display: flex;
            flex-direction: column;
            gap: 1px;
          }
          .stat-pill { padding: 1rem; }
          .start-card { padding: 1.5rem; }
        }

        .start-card {
          background: rgba(14,14,26,0.8);
          border: 1px solid rgba(108,99,255,0.15);
          border-radius: 24px;
          padding: 3rem;
          display: flex; flex-direction: column; align-items: center;
          justify-content: center; text-align: center;
          position: relative; overflow: hidden;
          backdrop-filter: blur(20px);
        }

        .start-card::before {
          content: '';
          position: absolute; inset: 0;
          background: radial-gradient(ellipse 70% 60% at 50% 0%, rgba(108,99,255,0.12) 0%, transparent 70%);
          pointer-events: none;
        }

        .start-animation {
          width: 90px; height: 90px;
          border-radius: 50%;
          background: linear-gradient(135deg, rgba(108,99,255,0.3), rgba(0,212,170,0.3));
          display: flex; align-items: center; justify-content: center;
          font-size: 2.5rem;
          margin-bottom: 1.5rem;
          animation: startPulse 2.5s ease infinite;
          box-shadow: 0 0 0 0 rgba(108,99,255,0.4);
        }

        @keyframes startPulse {
          0% { box-shadow: 0 0 0 0 rgba(108,99,255,0.5); transform: scale(1); }
          50% { box-shadow: 0 0 0 20px rgba(108,99,255,0); transform: scale(1.05); }
          100% { box-shadow: 0 0 0 0 rgba(108,99,255,0); transform: scale(1); }
        }

        .start-title { font-size: 1.5rem; font-weight: 800; color: #e8e8f0; margin-bottom: 0.75rem; }
        .start-sub { font-size: 0.9rem; color: #9494b8; line-height: 1.6; max-width: 320px; margin-bottom: 2rem; }

        .btn-start-training {
          display: inline-flex; align-items: center; gap: 10px;
          padding: 1rem 2.5rem;
          background: linear-gradient(135deg, #6c63ff 0%, #00d4aa 100%);
          border: none; border-radius: 100px;
          font-size: 1.05rem; font-weight: 700; color: white;
          cursor: pointer;
          box-shadow: 0 8px 40px rgba(108,99,255,0.5);
          transition: all 0.25s;
          animation: btnGlow 3s ease infinite;
        }

        @keyframes btnGlow {
          0%, 100% { box-shadow: 0 8px 30px rgba(108,99,255,0.4); }
          50% { box-shadow: 0 12px 50px rgba(108,99,255,0.7), 0 0 20px rgba(0,212,170,0.3); }
        }

        .btn-start-training:hover { transform: translateY(-3px) scale(1.02); filter: brightness(1.1); }

        .right-panel { display: flex; flex-direction: column; gap: 1.25rem; height: 100%; }

        .info-card {
          background: rgba(14,14,26,0.8);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 16px;
          padding: 1.5rem;
          backdrop-filter: blur(20px);
        }

        .info-card--expand {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        .info-card-title {
          font-size: 0.72rem; font-weight: 700;
          text-transform: uppercase; letter-spacing: 1.5px;
          color: #5a5a7a; margin-bottom: 1rem;
          display: flex; align-items: center; gap: 8px;
        }

        .session-history-item {
          display: flex; align-items: center; gap: 12px;
          padding: 0.75rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .session-history-item:last-child { border-bottom: none; }

        .session-score-badge {
          width: 44px; height: 44px; border-radius: 12px;
          display: flex; align-items: center; justify-content: center;
          font-size: 0.9rem; font-weight: 800; flex-shrink: 0;
        }

        .session-score-high  { background: rgba(46,213,115,0.15); color: var(--success); }
        .session-score-mid   { background: rgba(255,165,2,0.12);   color: var(--warning); }
        .session-score-low   { background: rgba(255,71,87,0.12);   color: var(--danger); }

        .session-history-name { font-size: 0.85rem; font-weight: 600; color: #e8e8f0; }
        .session-history-meta { font-size: 0.72rem; color: #5a5a7a; margin-top: 2px; }

        .empty-history { text-align: center; padding: 1.5rem 0; color: #5a5a7a; font-size: 0.82rem; }
      </style>

      <div class="seller-dashboard">
        <!-- BG Orbs -->
        <div class="seller-bg-orb" style="width:500px;height:500px;background:rgba(108,99,255,0.08);top:-150px;left:-100px;"></div>
        <div class="seller-bg-orb" style="width:400px;height:400px;background:rgba(0,212,170,0.06);bottom:-100px;right:-80px;"></div>

        <!-- Hero -->
        <div class="seller-hero">
          <div class="seller-hero-left">
            <div class="seller-avatar-ring">${escHtml(user.name[0])}</div>
            <div>
              <h1 class="seller-welcome-name">Olá, ${escHtml(user.name.split(' ')[0])} 👋</h1>
              <p class="seller-welcome-sub">Pronto para evoluir? Seu próximo treino está esperando.</p>
            </div>
          </div>
          <button onclick="Auth.logout()" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#9494b8;padding:10px 20px;border-radius:10px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,71,87,0.1)';this.style.color='#ff4757'" onmouseout="this.style.background='rgba(255,255,255,0.04)';this.style.color='#9494b8'">
            🚪 Sair
          </button>
        </div>

        <!-- Stats Strip -->
        <div class="seller-stats-strip">
          <div class="stat-pill">
            <div class="stat-icon purple">🚀</div>
            <div>
              <div class="stat-number">${allSessions.length}</div>
              <div class="stat-label">Treinamentos</div>
            </div>
          </div>
          <div class="stat-pill">
            <div class="stat-icon teal">📈</div>
            <div>
              <div class="stat-number">${avgScore || '—'}</div>
              <div class="stat-label">Pontuação Média</div>
              ${scoreTrend ? `<div class="stat-trend">${scoreTrend}</div>` : ''}
            </div>
          </div>
          <div class="stat-pill">
            <div class="stat-icon gold">👔</div>
            <div>
              <div class="stat-number">${totalAssigned}</div>
              <div class="stat-label">Clientes Atribuídos</div>
            </div>
          </div>
        </div>

        <!-- Body -->
        <div class="seller-body">

          <!-- Main Start Card -->
          <div class="start-card">
            <h2 class="start-title" style="margin-bottom: 1rem;">Suas Sessões</h2>
            ${(typeof Storage.getScheduledSessionsForSeller === 'function' ? Storage.getScheduledSessionsForSeller(user.id) : []).length > 0 ? 
              (typeof Storage.getScheduledSessionsForSeller === 'function' ? Storage.getScheduledSessionsForSeller(user.id) : []).map(ss => {
                const allClients = typeof Storage.getClients === 'function' ? Storage.getClients() : [];
                const ssClientId = ss.clientId || ss.client_id;
                const client = allClients.find(c => String(c.id) === String(ssClientId));
                const cName = client ? client.name : 'Cliente Desconhecido';
                const isInProgress = !!ss.startedAt;
                return `
                  <div class="pending-session-card" style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.1); text-align: left;">
                    <div>
                      <div style="font-weight: 600; color: #fff; font-size: 1.1rem;">${cName}</div>
                      <div style="font-size: 0.85rem; color: ${isInProgress ? 'var(--warning)' : 'var(--accent-light)'}; margin-top: 4px;">
                        ${isInProgress ? '⏳ Em andamento...' : '📅 Sessão Agendada'}
                      </div>
                    </div>
                    <button class="btn btn-sm ${isInProgress ? 'btn-warning' : 'btn-primary'}" onclick="Seller.startTraining('${ssClientId}', '${ss.id}')" style="padding: 8px 16px;">
                      ${isInProgress ? 'Continuar' : 'Iniciar'}
                    </button>
                  </div>
                `;
              }).join('')
            : `
              <div class="start-animation" style="background: rgba(255,255,255,0.05); box-shadow: none; animation: none;">🔒</div>
              <h2 class="start-title">Nenhuma Sessão Atribuída</h2>
              <p class="start-sub">Você não possui sessões atribuídas no momento. Fale com seu gestor para liberar novas simulações.</p>
            `}
          </div>

          <!-- Right Panel -->
          <div class="right-panel">

            <!-- Histórico Recente -->
            <div class="info-card">
              <div class="info-card-title">📋 Histórico Recente</div>
              ${recentSessions.length > 0 ? recentSessions.map(ss => {
                const score = ss.result?.total || 0;
                const cls = score >= 70 ? 'session-score-high' : score >= 40 ? 'session-score-mid' : 'session-score-low';
                const dateStr = ss.endedAt ? new Date(ss.endedAt).toLocaleDateString('pt-BR', { day:'2-digit', month:'short' }) : '—';
                return `
                  <div class="session-history-item">
                    <div class="session-score-badge ${cls}">${score}</div>
                    <div>
                      <div class="session-history-name">${escHtml(ss.clientName || 'Cliente')}</div>
                      <div class="session-history-meta">${dateStr} · ${ss.result?.passed ? '✅ Aprovado' : '❌ Reprovado'}</div>
                    </div>
                  </div>
                `;
              }).join('') : `<div class="empty-history">Nenhum treino ainda.<br>Comece agora! 🎯</div>`}
            </div>

            <!-- Dica Rápida -->
            <div class="info-card info-card--expand" style="border-color:rgba(108,99,255,0.2);background:linear-gradient(135deg, rgba(108,99,255,0.06), rgba(14,14,26,0.9));">
              <div class="info-card-title" style="color:var(--accent-light); margin-bottom: 0.75rem;">💡 Dica do Coach</div>
              <p style="font-size:0.85rem;color:#9494b8;line-height:1.6;margin:0;">
                ${bestScore > 0 ? `Sua melhor pontuação foi <strong style="color:#e8e8f0; margin-left: 4px;">${bestScore} pts</strong>. Tente superá-la focando em fazer mais perguntas de diagnóstico no início.` : `Dica: sempre comece a sessão fazendo perguntas para entender a dor do cliente antes de apresentar o produto.`}
              </p>
            </div>

          </div>
        </div>
      </div>
    `;
  }

  // Called when user clicks "Iniciar Novo Treinamento" ou clica na notificação
  function startTraining(clientId = null, sessionId = null) {
    const user = Auth.getUser();
    
    if (!sessionId || !clientId) {
      alert('Sessão inválida.');
      return;
    }

    const allSessions = typeof Storage.getScheduledSessionsForSeller === 'function' ? Storage.getScheduledSessionsForSeller(user.id) : [];
    const sessionToStart = allSessions.find(s => String(s.id) === String(sessionId));
    
    if (!sessionToStart) {
      alert('Você não tem treinamentos agendados disponíveis no momento.');
      return;
    }

    config = buildConfigForSession(sessionToStart, user);
    if (!config) {
      alert('Erro ao carregar o cliente para esta sessão.');
      return;
    }

    resetSession(); // Reseta primeiro, depois restaura os valores
    
    // Restaurar estado da sessão persistida
    if (sessionToStart.startedAt) {
      // Se a sessão já havia começado
      messages = sessionToStart.messages || [];
      conviction = sessionToStart.conviction || 0;
      tricks = sessionToStart.tricks || 0;
      criteriaScores = sessionToStart.criteriaScores || { rapport: 0, discovery: 0, value: 0, objections: 0, closing: 0, professionalism: 0 };
    }

    const targetClient = { 
      id: config._drawnClientId, 
      name: config.customerName, 
      role: config.customerRole, 
      company: config.customerCompany, 
      emoji: config.customerEmoji, 
      difficulty: config.difficulty 
    };

    renderChatLayout(user, targetClient, config._totalAssigned);
    startSession(sessionToStart);
  }

  function resetSession() {
    messages        = [];
    conviction      = 0;
    tricks          = 0;
    sessionEnded    = false;
    isWaiting       = false;
    durationSeconds = 0;
    coachMsgCount   = 0;
    agendaHinted    = false;
    agendaRevealed  = false;
    xrayMsgCount    = 0;
    xrayShown       = false;
    interruptionCount = 0;
    criteriaScores  = { rapport: 0, discovery: 0, value: 0, objections: 0, closing: 0, professionalism: 0 };
    if (interruptionTimer) { clearInterval(interruptionTimer); interruptionTimer = null; }
  }

  // ══════════════════════════════════════
  // RENDER LAYOUT
  // ══════════════════════════════════════
  function renderChatLayout(user, drawnClient, totalAssigned) {
    const page = document.getElementById('page-seller');
    if (!page) return;

    const drawnBadge = '';

    // Hostile mode banner
    const hostileBanner = config.hostileMode
      ? `<div class="hostile-banner">🔥 MODO MERCADO HOSTIL ATIVO — Prepare-se para pressão máxima</div>`
      : '';

    // Archetype badge
    const archetypeIcons = {
      desconfiado:'🕵️', pragmatico:'⚡', ansioso:'😰', tecnico:'🔬',
      sarcastico:'😏', apressado:'💨', detalhista:'🔎', emocional:'❤️',
      sonhador:'✨', autoritario:'👔', humilde:'🙏', comparador:'⚖️'
    };
    const archetypeBadge = config.archetype
      ? `<span class="badge badge-muted" style="font-size:0.7rem">${archetypeIcons[config.archetype]||'🎭'} ${config.archetype}</span>`
      : '';

    // Constraints indicator
    const sc = config.sessionConstraints || {};
    const constraintParts = [];
    if (sc.extremeHaste) constraintParts.push('⚡ Pressa extrema');
    if (sc.shortSession) constraintParts.push('⏱ Sessão curta');
    if (sc.interruptions) constraintParts.push('🔔 Com interrupções');
    if (sc.longResistance) constraintParts.push('🧱 Resistência longa');
    const constraintBadge = constraintParts.length > 0
      ? `<div class="constraint-badges">${constraintParts.map(c => `<span class="constraint-tag">${c}</span>`).join('')}</div>`
      : '';

    // Hidden agenda indicator (mystery box)
    const agendaIndicator = config.hiddenAgenda
      ? `<div class="chat-sidebar-section" id="agenda-section">
           <div class="chat-sidebar-title">🎭 Agenda do Cliente</div>
           <div class="agenda-mystery" id="agenda-mystery">
             <div class="agenda-mystery-icon">🔒</div>
             <div class="agenda-mystery-text">Motivação oculta<br><span style="font-size:0.7rem;color:var(--text-muted)">Faça perguntas de diagnóstico para descobrir</span></div>
           </div>
         </div>`
      : '';

    // Render UI overlay
    page.innerHTML = `
      ${hostileBanner}
      <div class="chat-layout">
        <!-- Main chat -->
        <div class="chat-main">
          <!-- Chat header -->
          <div class="chat-header">
            <button class="btn btn-ghost btn-sm" onclick="Seller._forceExit()" style="flex-shrink:0" title="Sair sem salvar">← Sair</button>
            <div class="chat-header-customer">
              <div class="customer-avatar" id="customer-avatar">${config.customerEmoji || '👨‍💼'}</div>
              <div>
                <div class="customer-name">${escHtml(config.customerName)} ${archetypeBadge}</div>
                <div class="customer-role">${escHtml(config.customerRole)} — ${escHtml(config.customerCompany)}</div>
              </div>
              <div class="customer-status" id="customer-status">
                <span class="glow-dot"></span>
                <span id="status-text">Conectando...</span>
              </div>
            </div>

            <!-- Mobile Info Button -->
            <button class="btn btn-ghost btn-icon mobile-only" onclick="document.getElementById('chat-sidebar').classList.add('open'); document.getElementById('chat-sidebar-backdrop').classList.add('active');" style="margin-left:auto;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            </button>

            <!-- Conviction meter -->
            ${config._showRealtime !== false ? `
            <div class="conviction-container" id="conviction-container">
              <span class="conviction-label">Interesse</span>
              <div class="conviction-bar">
                <div class="conviction-fill" id="conviction-fill" style="width:0%;background:var(--danger)"></div>
              </div>
              <span class="conviction-value" id="conviction-value" style="color:var(--danger)">0%</span>
            </div>
            ` : ''}

            <!-- Timer -->
            <div class="chat-timer" id="chat-timer">
              <span class="timer-icon">⏱</span>
              <span id="timer-display">00:00</span>
            </div>

            <!-- Difficulty badge -->
            <span class="badge ${{ 'easy':'badge-success','medium':'badge-teal','hard':'badge-warning','expert':'badge-danger' }[config.difficulty]||'badge-muted'}">
              ${{ easy:'😊 Fácil', medium:'🤔 Médio', hard:'😤 Difícil', expert:'🔥 Expert' }[config.difficulty] || 'Médio'}
            </span>
          </div>

          ${constraintBadge}

          <!-- Messages -->
          <div class="chat-messages" id="chat-messages">
            <!-- Messages appear here -->
          </div>

          <!-- Coach tip overlay -->
          <div class="coach-tip-overlay" id="coach-tip-overlay" style="display:none">
            <div class="coach-tip-inner" id="coach-tip-inner"></div>
          </div>

          <!-- Input area -->
          <div class="chat-input-area" id="chat-input-area">
            ${config.hintsEnabled ? `
              <div class="chat-hints" id="chat-hints">
                ${generateHints().map(h => `<div class="hint-chip" onclick="Seller.useHint(this)">${h}</div>`).join('')}
              </div>
            ` : ''}
            <div class="chat-input-row">
              <button class="chat-mic-btn" id="chat-mic-btn" onclick="Seller.toggleMic()" title="Gravar áudio" ${sessionEnded ? 'disabled' : ''}>
                🎤
              </button>
              <textarea class="chat-textarea" id="chat-input"
                placeholder="Digite sua mensagem de vendas..."
                rows="1"
                onkeydown="Seller.handleKeydown(event)"
                oninput="Seller.autoResize(this)"
                ${sessionEnded ? 'disabled' : ''}
              ></textarea>
              <button class="chat-send-btn" id="chat-send-btn" onclick="Seller.sendUserMessage()" ${sessionEnded ? 'disabled' : ''}>
                ➤
              </button>
            </div>
            <div class="flex flex-between mt-2">
              <span class="text-muted fs-xs">Enter para enviar</span>
              <div class="flex gap-2">
                ${config._showRealtime !== false ? `<button class="btn btn-sm btn-ghost" onclick="Seller.showXray()" id="btn-xray" style="display:none">🔬 Raio-X</button>` : ''}
                <button class="btn btn-sm btn-danger" onclick="Seller.confirmEnd()">⏹ Encerrar Sessão</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Right sidebar backdrop -->
        <div class="chat-sidebar-backdrop" id="chat-sidebar-backdrop" onclick="document.getElementById('chat-sidebar').classList.remove('open'); this.classList.remove('active');"></div>

        <!-- Right sidebar -->
        <div class="chat-sidebar" id="chat-sidebar">
          <div class="mobile-only flex flex-between" style="padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border-subtle);">
            <h3 style="font-size:1rem;margin:0;">Informações</h3>
            <button class="btn btn-ghost btn-icon" onclick="document.getElementById('chat-sidebar').classList.remove('open'); document.getElementById('chat-sidebar-backdrop').classList.remove('active');">✕</button>
          </div>
          <!-- Mood -->
          ${config._showRealtime !== false ? `
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-title">😶 Humor do Cliente</div>
            <div class="mood-indicator" id="mood-indicator">
              <div class="mood-emoji" id="mood-emoji">😐</div>
              <div>
                <div class="mood-label" id="mood-label">Neutro</div>
                <div class="mood-text" id="mood-text">Aguardando interação</div>
              </div>
            </div>
          </div>
          ` : ''}

          <!-- Market segment indicator -->
          ${config.marketSegment && config.marketSegment !== 'generico' ? `
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-title">🏢 Segmento</div>
            <div class="segment-indicator segment-${config.marketSegment}">
              ${{ hospital:'🏥 Hospital', farmacia:'💊 Farmácia', industria:'🏭 Indústria', varejo:'🛒 Varejo', educacao:'📚 Educação', servicos:'💼 Serviços' }[config.marketSegment] || config.marketSegment}
            </div>
          </div>
          ` : ''}

          <!-- Hidden agenda -->
          ${agendaIndicator}

          <!-- Product info -->
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-title">📦 Produtos para Oferecer</div>
            ${(config.products && config.products.length > 0)
              ? config.products.map(p => `
                <div class="sidebar-product-item">
                  <div class="sidebar-product-name">${escHtml(p.name)}</div>
                  <div class="sidebar-product-meta">
                    <span class="sidebar-product-price">${escHtml(p.price || '—')}</span>
                    <span class="sidebar-product-category">• ${escHtml(p.category || '')}</span>
                  </div>
                  ${p.description ? `<div style="font-size:0.72rem;color:var(--text-muted);line-height:1.4">${escHtml(p.description.slice(0,80))}${p.description.length>80?'...':''}</div>` : ''}
                </div>
              `).join('')
              : `<div class="sidebar-product-item" style="opacity:0.7">
                <div style="font-size:0.75rem;color:var(--warning);font-weight:600;margin-bottom:4px;">⚠️ Nenhum produto cadastrado</div>
                <div style="font-size:0.72rem;color:var(--text-muted);line-height:1.5;">Apresente livremente o produto ou serviço que você deseja vender. O cliente reagirá ao que você apresentar.</div>
              </div>`
            }
          </div>

          <!-- Live criteria -->
          ${config._showRealtime !== false ? `
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-title">🎯 Critérios (tempo real)</div>
            ${Object.entries(criteriaScores).map(([key, val]) => {
              const info = ScoringEngine.getCriteriaLabel(key);
              return `
                <div class="criteria-item">
                  <div class="criteria-header">
                    <span class="criteria-name">${info.icon} ${info.label}</span>
                    <span class="criteria-score" id="crit-${key}">${val}</span>
                  </div>
                  <div class="criteria-bar">
                    <div class="criteria-fill" id="crit-bar-${key}" style="width:${val}%"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          ` : ''}

          ${config._showRealtime !== false ? `
          <!-- Session info compacto -->
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-title">📊 Sessão</div>
            <div style="font-size:0.75rem;display:flex;flex-direction:column;gap:4px">
              <div class="flex flex-between">
                <span class="text-muted">Msgs</span>
                <span id="msg-count" class="fw-600">0</span>
              </div>
              <div class="flex flex-between">
                <span class="text-muted">Truques</span>
                <span id="trick-count" class="fw-600 text-warning">0</span>
              </div>
              <div class="flex flex-between">
                <span class="text-muted">Nível</span>
                <span class="fw-600">${{easy:'Fácil',medium:'Médio',hard:'Difícil',expert:'Expert'}[config.difficulty]||'Médio'}</span>
              </div>
              ${config.hostileMode ? `
              <div class="flex flex-between">
                <span class="text-muted">Modo</span>
                <span class="fw-600" style="color:var(--danger)">🔥 Hostil</span>
              </div>` : ''}
            </div>
          </div>
          ` : ''}
        </div>
      </div>

      <!-- Xray Modal -->
      <div class="modal-overlay" id="xray-modal">
        <div class="modal" style="max-width:580px">
          <div class="flex flex-between" style="margin-bottom:var(--sp-5)">
            <h3>🔬 Raio-X do Seu Estilo Comercial</h3>
            <button class="btn btn-ghost btn-icon" onclick="document.getElementById('xray-modal').classList.remove('active')">✕</button>
          </div>
          <div id="xray-content"></div>
        </div>
      </div>
    `;
  }

  // ══════════════════════════════════════
  // SESSION START
  // ══════════════════════════════════════
  async function startSession(sessionToStart) {
    if (!sessionToStart.startedAt) {
      sessionToStart.startedAt = new Date().toISOString();
      try { await Storage.updateScheduledSession(sessionToStart.id, { startedAt: sessionToStart.startedAt }); } catch (e) {}
    }
    const startTime = new Date(sessionToStart.startedAt).getTime();
    
    // Calculate elapsed time from start if returning
    durationSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (durationSeconds < 0) durationSeconds = 0;

    // Timer handler
    const runTimer = () => {
      durationSeconds = Math.floor((Date.now() - startTime) / 1000) * (config.sessionConstraints?.extremeHaste ? 2 : 1);
      const m = Math.floor(durationSeconds / 60);
      const s = durationSeconds % 60;
      const el = document.getElementById('timer-display');
      if (el) el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      checkTimeLimit();
    };

    timerInterval = setInterval(runTimer, 1000);
    runTimer(); // Run once immediately

    // Start random interruptions if configured
    if (config.sessionConstraints?.interruptions) {
      scheduleInterruption();
    }

    if (messages.length > 0) {
      // Restore existing chat UI
      const chatContainer = document.getElementById('chat-messages');
      if (chatContainer) chatContainer.innerHTML = '';
      
      updateConviction(conviction);
      setStatus('Online', false);

      messages.forEach(m => {
        if (m.role === 'user') addUserMessage(m.content, false);
        else if (m.role === 'system') addSystemMessage(m.content, false);
        else addBotMessage(m.content, m.isTrick, null, false, false, false);
      });
      scrollChat();
    } else {
      // First time starting
      const initialConviction = { easy: 35, medium: 20, hard: 10, expert: 5 }[config.difficulty] || 20;
      updateConviction(initialConviction);
      setStatus('Digitando...', true);

      try {
        const response = await AIEngine.getOpeningMessage(config);
        setStatus('Online', false);
        addBotMessage(response.text, response.isTrick, response.trickType);
        if (response.conviction !== null && response.conviction !== undefined) {
          updateConviction(response.conviction);
        }
      } catch (err) {
        handleApiError(err);
      }
    }
  }

  async function saveCurrentSession() {
    if (config && config._pendingSessionId) {
      const state = {
        messages: messages.map(m => ({ role: m.role, content: m.content, isTrick: m.isTrick })),
        conviction: conviction,
        tricks: tricks,
        criteriaScores: criteriaScores
      };
      try { await Storage.updateScheduledSession(config._pendingSessionId, state); } catch(e) {}
    }
  }

  // ── Schedule random interruption ──
  let interruptionCount = 0;
  const MAX_INTERRUPTIONS = 3;

  function scheduleInterruption() {
    if (interruptionCount >= MAX_INTERRUPTIONS) return; // limit total interruptions
    const delay = (60 + Math.random() * 60) * 1000; // 60-120 seconds between interruptions
    interruptionTimer = setTimeout(async () => {
      if (sessionEnded) return;
      if (interruptionCount >= MAX_INTERRUPTIONS) return;
      const interruptions = [
        'Um segundo, me dá um minutinho...',
        'Pode esperar? Recebi uma ligação rápida.',
        'Tá, voltei. Continue.',
        'Desculpa, uma coisa aqui internamente. Pode repetir?',
      ];
      const msg = interruptions[Math.floor(Math.random() * interruptions.length)];
      messages.push({ role: 'bot', content: msg, isTrick: false, timestamp: new Date(), isInterruption: true });
      addBotMessage(msg, false, null, false, true); // isInterruption=true
      saveCurrentSession();
      interruptionCount++;
      scheduleInterruption(); // schedule next (if under cap)
    }, delay);
  }

  // ══════════════════════════════════════
  // MESSAGING & VOICE
  // ══════════════════════════════════════
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;

  async function initAudioRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        audioChunks = [];
        
        try {
          const micBtn = document.getElementById('chat-mic-btn');
          if (micBtn) {
            micBtn.classList.remove('recording');
            micBtn.innerHTML = '⏳';
          }
          
          const formData = new FormData();
          formData.append('audio', audioBlob, 'voice.webm');
          
          const result = await API.transcribeAudio(formData);
          
          const input = document.getElementById('chat-input');
          if (input && result && result.text) {
            input.value = (input.value + ' ' + result.text).trim();
            autoResize(input);
          }
        } catch (err) {
          console.error(err);
          try { UI.toast('Erro ao transcrever áudio.', 'error'); } catch(e) { alert('Erro ao transcrever áudio.'); }
        } finally {
          const micBtn = document.getElementById('chat-mic-btn');
          if (micBtn) {
            micBtn.innerHTML = '🎤';
            micBtn.title = 'Gravar áudio';
          }
        }
      };
      
      return true;
    } catch (err) {
      console.error('Erro ao acessar microfone:', err);
      try { UI.toast('Erro ao acessar microfone.', 'error'); } catch(e) { alert('Microfone não acessível.'); }
      return false;
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
  }

  async function toggleMic() {
    if (sessionEnded) return;
    
    if (!mediaRecorder) {
      const initOk = await initAudioRecording();
      if (!initOk) return;
    }
    
    if (isRecording) {
      stopRecording();
    } else {
      audioChunks = [];
      try { 
        mediaRecorder.start(); 
        isRecording = true;
        const micBtn = document.getElementById('chat-mic-btn');
        if (micBtn) {
          micBtn.classList.add('recording');
          micBtn.title = 'Parar gravação';
        }
      } catch(e) { 
        console.error(e); 
      }
    }
  }

  async function sendUserMessage() {
    if (isWaiting || sessionEnded) return;
    const input = document.getElementById('chat-input');
    const text = input?.value?.trim();
    if (!text) return;

    input.value = '';
    autoResize(input);

    const userMsg = { role: 'user', content: text, timestamp: new Date() };
    messages.push(userMsg);
    renderUserMessage(text);
    updateMsgCount();
    xrayMsgCount++;

    // Detect potential winning phrase (if conviction is currently high-ish)
    detectWinningPhrase(text);

    analyzeLiveCriteria(text);

    // Instant conviction preview
    const w = { rapport: 0.15, discovery: 0.2, value: 0.2, objections: 0.25, closing: 0.15, professionalism: 0.05 };
    const estimated = Object.keys(w).reduce((sum, k) => sum + (criteriaScores[k] || 0) * w[k], 0);
    if (estimated > conviction) updateConviction(Math.min(estimated, conviction + 8));

    // Show Raio-X button after 5 user messages
    if (xrayMsgCount >= 5 && !xrayShown) {
      const btn = document.getElementById('btn-xray');
      if (btn) { btn.style.display = ''; btn.classList.add('xray-pulse'); }
    }

    isWaiting = true;
    document.getElementById('chat-send-btn').disabled = true;

    const typingId = showTyping();
    setStatus('Digitando...', true);

    const baseDelay = { easy: 800, medium: 1200, hard: 1800, expert: 2200 }[config.difficulty] || 1200;
    const delay = baseDelay + Math.random() * 1000;
    await sleep(delay);

    try {
      const response = await AIEngine.sendMessage(messages, config);
      removeTyping(typingId);
      setStatus('Online', false);

      const botMsg = {
        role: 'bot',
        content: response.text,
        isTrick: response.isTrick,
        trickType: response.trickType,
        timestamp: new Date()
      };
      messages.push(botMsg);
      addBotMessage(response.text, response.isTrick, response.trickType, response.isDealbreaker);

      if (response.isClosed) {
        response.conviction = 100;
      }
      if (response.isNoInterest) {
        response.conviction = 0;
      }

      // Update conviction (save previous for delta analysis)
      const prevConviction = conviction;
      if (response.conviction !== null && response.conviction !== undefined) {
        updateConviction(response.conviction);
      } else {
        const estimated2 = Object.keys(w).reduce((sum, k) => sum + (criteriaScores[k] || 0) * w[k], 0);
        const blended = Math.round(conviction * 0.6 + estimated2 * 0.4);
        updateConviction(Math.max(blended, conviction));
      }

      if (response.isTrick) {
        tricks++;
        const trickEl = document.getElementById('trick-count');
        if (trickEl) {
          trickEl.textContent = tricks;
          trickEl.classList.remove('trick-flash');
          void trickEl.offsetWidth; // force reflow to restart animation
          trickEl.classList.add('trick-flash');
          setTimeout(() => trickEl.classList.remove('trick-flash'), 700);
        }
      }

      if (response.isDealbreaker) handleDealbreaker();

      if (response.isClosed) {
        addSystemMessage('🎉 Parabéns! O cliente concordou com os próximos passos/fechou negócio!');
        setTimeout(() => endSession(), 1500);
      } else if (response.isNoInterest) {
        addSystemMessage('💔 O cliente perdeu totalmente o interesse e encerrou a negociação.');
        setTimeout(() => endSession(), 1500);
      }

      // Handle off-topic detection (AI-driven)
      if (response.offTopic) {
        setTimeout(() => showCoachTip({
          tip: `⚠️ Fora do foco! ${response.offTopicReason || 'Você saiu do tema de vendas.'}. Volte para a negociação!`,
          priority: 'urgent',
          icon: '🚨'
        }), 500);
      }

      // Handle hidden agenda reveal
      if (response.agendaRevealed && !agendaRevealed) {
        agendaRevealed = true;
        handleAgendaReveal();
      }

      // Hidden agenda hint when conviction > 65
      if (config.hiddenAgenda && conviction > 65 && !agendaHinted) {
        agendaHinted = true;
        setTimeout(() => showCoachTip({
          tip: 'O cliente parece ter algo não dito... explore mais!',
          priority: 'urgent',
          icon: '🎭'
        }), 1500);
      }

      // Analyze bot response to retroalimentar criteria
      analyzeBotResponse(response, prevConviction);

      checkTimeLimit();

      // Coach every 2-3 user messages
      coachMsgCount++;
      const userMsgs = messages.filter(m => m.role === 'user');
      if (coachMsgCount >= 2 && userMsgs.length >= 2) {
        coachMsgCount = 0;
        // Fetch coach tip asynchronously (non-blocking)
        AIEngine.getCoachTip(messages, config).then(tip => {
          if (tip) showCoachTip(tip);
        }).catch(() => {}); // silently ignore errors
      }

      saveCurrentSession();

    } catch (err) {
      removeTyping(typingId);
      setStatus('Online', false);
      handleApiError(err);
    }

    isWaiting = false;
    document.getElementById('chat-send-btn').disabled = false;
    document.getElementById('chat-input')?.focus();

    if (config.hintsEnabled) rotateHints();
  }

  // ── Detect possible winning phrase ──
  function detectWinningPhrase(text) {
    if (conviction < 40 || text.length < 30) return;
    // Check if this message came right before conviction bump (heuristic)
    // We save it if conviction is already decent
    if (conviction >= 50) {
      const userMsgCount = messages.filter(m => m.role === 'user').length;
      if (userMsgCount > 1) {
        Storage.addWinningPhrase({
          phrase: text,
          convictionAtTime: conviction,
          segment: config.marketSegment || 'generico',
          clientDifficulty: config.difficulty,
          sellerName: Auth.getUser()?.name || 'Vendedor',
          sellerId: Auth.getUser()?.id,
        });
      }
    }
  }

  function renderUserMessage(text) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-message user';
    div.innerHTML = `
      <div>
        <div class="msg-bubble">${escHtml(text)}</div>
        <span class="msg-time">${formatTime(new Date())}</span>
      </div>
      <div class="msg-avatar user-av">${Auth.getUser()?.name?.[0] || '?'}</div>
    `;
    container.appendChild(div);
    scrollToBottom();
  }

  function addBotMessage(text, isTrick, trickType, isDealbreaker, isInterruption = false) {
    const container = document.getElementById('chat-messages');
    const trickLabels = {
      price:         '💰 Objeção de preço',
      competitor:    '🏆 Mencionou concorrente',
      authority:     '🤝 Falta de autoridade',
      doubt:         '🤔 Dúvida de eficácia',
      urgency:       '⏰ Urgência/indecisão',
      doubt_company: '🏢 Questiona empresa',
    };

    const div = document.createElement('div');
    div.className = `chat-message bot${isInterruption ? ' bot-interruption' : ''}`;
    div.innerHTML = `
      <div class="msg-avatar bot-av">${config.customerEmoji || '👨‍💼'}</div>
      <div>
        <div class="msg-bubble">${escHtml(text)}</div>
        ${isTrick ? `<div class="trick-badge">🃏 ${trickLabels[trickType] || 'Truque'}</div>` : ''}
        ${isDealbreaker ? `<div class="trick-badge" style="color:var(--danger);background:rgba(255,71,87,0.1);border-color:rgba(255,71,87,0.3)">💔 Dealbreaker ativado!</div>` : ''}
        ${isInterruption ? `<div class="trick-badge" style="color:var(--warning);background:rgba(255,165,2,0.1);border-color:rgba(255,165,2,0.3)">🔔 Interrupção</div>` : ''}
        <span class="msg-time">${formatTime(new Date())}</span>
      </div>
    `;

    if (isTrick) {
      div.classList.add('trick-shake');
      setTimeout(() => div.classList.remove('trick-shake'), 700);
    }

    container.appendChild(div);
    scrollToBottom();
  }

  function showTyping() {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    const id = 'typing-' + Date.now();
    div.id = id;
    div.className = 'typing-message';
    div.innerHTML = `
      <div class="msg-avatar bot-av">${config.customerEmoji || '👨‍💼'}</div>
      <div class="typing-bubble">
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      </div>
    `;
    container.appendChild(div);
    scrollToBottom();
    return id;
  }

  function removeTyping(id) {
    document.getElementById(id)?.remove();
  }

  // ══════════════════════════════════════
  // COACH TIP
  // ══════════════════════════════════════
  function showCoachTip(tip) {
    if (sessionEnded) return;
    const overlay = document.getElementById('coach-tip-overlay');
    const inner = document.getElementById('coach-tip-inner');
    if (!overlay || !inner) return;

    const priorityColors = {
      urgent: 'var(--danger)',
      normal: 'var(--accent)',
      good: 'var(--success)',
    };

    inner.innerHTML = `
      <span class="coach-tip-icon">${tip.icon || '🎯'}</span>
      <span class="coach-tip-text" style="color:${priorityColors[tip.priority] || 'var(--accent)'}">
        ${tip.tip}
      </span>
      <button class="coach-tip-dismiss" onclick="document.getElementById('coach-tip-overlay').style.display='none'">✕</button>
    `;
    overlay.style.display = 'flex';

    // Auto-dismiss after 6 seconds
    setTimeout(() => { overlay.style.display = 'none'; }, 6000);
  }

  // ══════════════════════════════════════
  // RAIO-X MODAL
  // ══════════════════════════════════════
  function showXray() {
    xrayShown = true;
    const btn = document.getElementById('btn-xray');
    if (btn) btn.classList.remove('xray-pulse');

    const userMessages = messages.filter(m => m.role === 'user');
    const xray = ScoringEngine.buildStyleXray(userMessages);
    const triggers = ScoringEngine.analyzeTriggers(userMessages);

    const xrayContent = document.getElementById('xray-content');
    const modal = document.getElementById('xray-modal');

    if (!xrayContent || !modal) return;

    const scoreColor = xray.xrayScore >= 70 ? 'var(--success)' : xray.xrayScore >= 45 ? 'var(--warning)' : 'var(--danger)';

    xrayContent.innerHTML = `
      <div style="text-align:center;margin-bottom:var(--sp-6)">
        <div style="font-size:2.5rem;font-weight:800;color:${scoreColor}">${xray.xrayScore}<span style="font-size:1rem">/100</span></div>
        <div style="color:var(--text-muted);font-size:0.85rem">Score de Comunicação Comercial</div>
      </div>

      <div class="xray-grid">
        <!-- Perguntas -->
        <div class="xray-card">
          <div class="xray-card-title">❓ Perguntas</div>
          <div class="xray-stat"><span class="xray-stat-label">Abertas</span><span class="xray-stat-val" style="color:var(--success)">${xray.openQuestions}</span></div>
          <div class="xray-stat"><span class="xray-stat-label">Fechadas</span><span class="xray-stat-val" style="color:var(--warning)">${xray.closedQuestions}</span></div>
          <div class="xray-stat"><span class="xray-stat-label">% Abertas</span><span class="xray-stat-val" style="color:${xray.openQuestionRatio>=0.5?'var(--success)':'var(--danger)'}">${Math.round(xray.openQuestionRatio*100)}%</span></div>
          <div class="xray-hint">${xray.openQuestionRatio < 0.5 ? '⚠️ Use mais perguntas abertas (como, o quê, por quê)' : '✅ Bom uso de perguntas abertas!'}</div>
        </div>

        <!-- Vícios -->
        <div class="xray-card">
          <div class="xray-card-title">🚨 Vícios de Linguagem</div>
          ${xray.vicesFound.length === 0
            ? '<div class="xray-hint" style="color:var(--success)">✅ Nenhum vício detectado!</div>'
            : xray.vicesFound.map(v => `<div class="xray-vice">${v.label} <span>(${v.count}x)</span></div>`).join('')
          }
          ${xray.weakWordsFound.length > 0 ? `
            <div class="xray-card-title" style="margin-top:var(--sp-3)">💧 Palavras Fracas</div>
            ${xray.weakWordsFound.map(w => `<div class="xray-vice">"${w}"</div>`).join('')}
          ` : ''}
        </div>
      </div>

      <!-- Gatilhos usados -->
      <div class="xray-card" style="margin-top:var(--sp-4)">
        <div class="xray-card-title">🧲 Gatilhos de Persuasão Usados</div>
        <div class="trigger-meter-grid">
          ${Object.entries(triggers).map(([key, val]) => {
            const labels = {
              autoridade:'Autoridade', provaSocial:'Prova Social', urgencia:'Urgência',
              especificidade:'Especificidade', empatia:'Empatia', clareza:'Clareza',
              seguranca:'Segurança', controleExcessivo:'Controle Excessivo'
            };
            const isNegative = key === 'controleExcessivo';
            const color = isNegative ? 'var(--danger)' : val >= 3 ? 'var(--success)' : val >= 1 ? 'var(--warning)' : 'var(--text-muted)';
            return `
              <div class="trigger-meter-item">
                <span class="trigger-meter-label">${labels[key]||key}</span>
                <div class="trigger-meter-bar">
                  <div style="width:${(val/5)*100}%;background:${color};height:100%;border-radius:2px;transition:width 0.5s ease"></div>
                </div>
                <span class="trigger-meter-val" style="color:${color}">${val}/5</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    modal.classList.add('active');
  }

  // ══════════════════════════════════════
  // CONVICTION & MOOD
  // ══════════════════════════════════════
  let _lastMoodEmoji = null;

  function updateConviction(value) {
    const oldConviction = conviction;
    conviction = Math.round(Math.max(0, Math.min(100, value)));
    const fill = document.getElementById('conviction-fill');
    const valEl = document.getElementById('conviction-value');
    const container = document.getElementById('conviction-container');

    const color = conviction < 30 ? 'var(--danger)'
                : conviction < 50 ? 'var(--warning)'
                : conviction < 70 ? 'var(--teal)'
                : 'var(--success)';

    if (fill) { fill.style.width = conviction + '%'; fill.style.background = color; }
    if (valEl) { valEl.textContent = conviction + '%'; valEl.style.color = color; }

    // Pulse animation when conviction changes by more than 3 points
    if (container && Math.abs(conviction - oldConviction) > 3) {
      container.classList.remove('conviction-pulse');
      void container.offsetWidth; // force reflow
      container.classList.add('conviction-pulse');
      setTimeout(() => container.classList.remove('conviction-pulse'), 800);
    }

    updateMood(conviction);
  }

  function updateMood(c) {
    const moods = [
      { max: 15,  emoji: '😤', label: 'Muito Resistente',    text: 'Extremamente difícil de convencer' },
      { max: 30,  emoji: '😒', label: 'Desinteressado',      text: 'Mostrando pouco interesse' },
      { max: 45,  emoji: '😐', label: 'Neutro',              text: 'Ouvindo, mas sem entusiasmo' },
      { max: 60,  emoji: '🤔', label: 'Considerando',        text: 'Começando a mostrar interesse' },
      { max: 75,  emoji: '😊', label: 'Interessado',         text: 'Demonstrando interesse real' },
      { max: 88,  emoji: '😃', label: 'Muito Interessado',   text: 'Próximo de ser convencido' },
      { max: 100, emoji: '🤩', label: 'Convencido!',         text: 'Pronto para fechar negócio' },
    ];

    const mood = moods.find(m => c <= m.max) || moods[moods.length - 1];
    const el = document.getElementById('mood-emoji');
    const label = document.getElementById('mood-label');
    const text = document.getElementById('mood-text');
    const indicator = document.getElementById('mood-indicator');

    // Only animate if mood actually changed
    const moodChanged = _lastMoodEmoji !== null && _lastMoodEmoji !== mood.emoji;
    _lastMoodEmoji = mood.emoji;

    if (el) el.textContent = mood.emoji;
    if (label) label.textContent = mood.label;
    if (text) text.textContent = mood.text;

    // Trigger pop animation only when mood tier changes
    if (moodChanged && indicator) {
      indicator.classList.remove('mood-transitioning');
      void indicator.offsetWidth; // force reflow
      indicator.classList.add('mood-transitioning');
      setTimeout(() => indicator.classList.remove('mood-transitioning'), 600);
    }
  }

  // ══════════════════════════════════════
  // LIVE CRITERIA ANALYSIS
  // ══════════════════════════════════════
  function analyzeLiveCriteria(text) {
    const lower = text.toLowerCase();
    const len = text.length;
    const userMsgCount = messages.filter(m => m.role === 'user').length;

    if (/olá|oi |bom dia|boa tarde|como vai|prazer|me chamo|sou o|sou a/.test(lower)) boost('rapport', 8);
    if (len > 80) boost('rapport', 3);

    const questionCount = (text.match(/\?/g) || []).length;
    if (questionCount > 0) boost('discovery', 10 * questionCount);
    if (/precisa|necessita|desafio|problema|dificuldade|objetivo|meta|resultado que|o que te preocupa|como está|situação atual/.test(lower)) boost('discovery', 8);

    if (/benefício|vantagem|resultado|economia|lucro|roi|retorno|produtividade|eficiência/.test(lower)) boost('value', 10);
    if (/case|exemplo|cliente|sucesso|provou|demonstrou/.test(lower)) boost('value', 8);
    if (len > 150) boost('value', 5);

    if (userMsgCount > 2 && /entendo|compreendo|faz sentido|concordo|boa ponto|razão|verdade/.test(lower)) boost('objections', 8);
    if (/porém|mas também|no entanto|apesar disso|por outro lado/.test(lower)) boost('objections', 6);

    if (/próximo passo|agendar|demonstração|teste|piloto|proposta|contrato|assinar|fechar|quando podemos/.test(lower)) boost('closing', 12);
    if (userMsgCount > 4 && /que tal|que acha|podemos|vamos|começa/.test(lower)) boost('closing', 8);

    if (len > 50 && len < 500) boost('professionalism', 3);
    if (!/xinga|palavrão/.test(lower)) boost('professionalism', 2);
  }

  function boost(key, amount) {
    const oldScore = criteriaScores[key];
    criteriaScores[key] = Math.min(100, criteriaScores[key] + amount);
    const newScore = criteriaScores[key];
    const scoreEl = document.getElementById(`crit-${key}`);
    const barEl   = document.getElementById(`crit-bar-${key}`);

    // Dynamic color based on score level
    const barColor = newScore < 25 ? '#ff4757'
                   : newScore < 50 ? '#ffa502'
                   : newScore < 75 ? '#00d4aa'
                   : '#6c63ff';

    if (scoreEl) {
      scoreEl.textContent = newScore;
      scoreEl.style.color = barColor;

      // Score bump animation only when score actually changed
      if (newScore > oldScore) {
        scoreEl.classList.remove('criteria-score-bump');
        void scoreEl.offsetWidth;
        scoreEl.classList.add('criteria-score-bump');
        setTimeout(() => scoreEl.classList.remove('criteria-score-bump'), 500);
      }
    }

    if (barEl) {
      barEl.style.width = newScore + '%';
      barEl.style.setProperty('--criteria-color', barColor);
      barEl.style.background = barColor;

      // Bar glow on significant change
      if (newScore - oldScore >= 5) {
        barEl.style.setProperty('--bar-glow-color', barColor.replace(')', ',0.4)').replace('rgb', 'rgba').replace('#', ''));
        const barContainer = barEl.parentElement;
        if (barContainer) {
          barContainer.classList.remove('criteria-bar-glow');
          void barContainer.offsetWidth;
          barContainer.classList.add('criteria-bar-glow');
          setTimeout(() => barContainer.classList.remove('criteria-bar-glow'), 900);
        }
      }
    }
  }

  function analyzeBotResponse(response, prevConviction) {
    if (!response) return;
    
    // If conviction increased significantly, retrofeed local criteria
    const convictionDelta = (response.conviction || prevConviction) - prevConviction;
    if (convictionDelta >= 5) {
      // The AI liked something! Boost the weakest criteria slightly, or closing if high conviction
      if ((response.conviction || prevConviction) > 70) {
        boost('closing', Math.floor(convictionDelta * 0.8));
      } else {
        // Find the criteria with the lowest score that makes sense to boost
        const boostable = ['rapport', 'discovery', 'value', 'objections'];
        boostable.sort((a, b) => (criteriaScores[a] || 0) - (criteriaScores[b] || 0));
        boost(boostable[0], Math.floor(convictionDelta * 0.6));
      }
    }

    // If bot used a trick (e.g., an objection), boost the objections criteria so the seller gets points for handling it later
    if (response.isTrick) {
      // Small bump just to acknowledge the interaction; major bump comes from user text analysis
      boost('objections', 5);
    }
  }

  // ══════════════════════════════════════
  // HIDDEN AGENDA REVEAL
  // ══════════════════════════════════════
  function handleAgendaReveal() {
    const agendaLabels = {
      insatisfeito_fornecedor: 'Insatisfeito com fornecedor atual',
      testando_mercado: 'Apenas testando o mercado',
      coletando_referencia: 'Coletando referência de preço',
      pressao_interna: 'Tem pressão interna para decidir',
      ja_decidiu_nao: 'Já havia decidido não comprar',
      orcamento_curto: 'Orçamento é 40% menor que o preço',
    };

    const mystery = document.getElementById('agenda-mystery');
    if (mystery) {
      mystery.innerHTML = `
        <div class="agenda-revealed">
          <div class="agenda-revealed-icon">🎉</div>
          <div>
            <div style="font-size:0.78rem;font-weight:700;color:var(--success)">Agenda descoberta!</div>
            <div style="font-size:0.72rem;color:var(--text-secondary)">${agendaLabels[config.hiddenAgenda] || 'Motivação revelada'}</div>
          </div>
        </div>
      `;
    }

    addSystemMessage('🕵️ Você descobriu a agenda oculta do cliente! +Bônus na avaliação final.');
  }

  // ══════════════════════════════════════
  // HINTS
  // ══════════════════════════════════════
  function generateHints() {
    const allHints = [
      '💡 Faça uma pergunta sobre os desafios atuais',
      '🎯 Apresente o principal diferencial do produto',
      '💰 Mostre o ROI/retorno sobre investimento',
      '📊 Use dados ou casos de sucesso',
      '🤝 Valide as preocupações do cliente',
      '⏰ Proponha um próximo passo concreto',
      '📞 Sugira uma demonstração prática',
      '🔍 Pergunte qual é a maior prioridade atual',
      '✅ Confirme o entendimento das necessidades',
      '🏆 Diferencie de concorrentes com fatos',
      '🧠 Pergunte sobre o processo de decisão',
      '💼 Explore o orçamento disponível',
    ];
    return allHints.sort(() => Math.random() - 0.5).slice(0, 4);
  }

  function rotateHints() {
    const container = document.getElementById('chat-hints');
    if (!container) return;
    container.innerHTML = generateHints()
      .map(h => `<div class="hint-chip" onclick="Seller.useHint(this)">${h}</div>`)
      .join('');
  }

  function useHint(el) {
    // Extract plain text from hint chip (strip emoji prefix)
    const raw = el.textContent || el.innerText || '';
    // Remove leading emoji/icon chars (everything before first space after the icon)
    const hintText = raw.replace(/^[^\w\sÀ-ÿ]+\s*/, '').trim();
    const input = document.getElementById('chat-input');
    if (input) {
      // If field is empty, insert directly; otherwise append with a space
      if (input.value.trim() === '') {
        input.value = hintText;
      } else {
        input.value = input.value.trimEnd() + ' ' + hintText;
      }
      autoResize(input);
      input.focus();
      // Move cursor to end
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
    // Visual feedback: dim chip
    el.style.opacity = '0.4';
    el.style.pointerEvents = 'none';
  }

  // ══════════════════════════════════════
  // TIMER
  // ══════════════════════════════════════
  // Timer setup is now inside startSession
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    if (interruptionTimer) { clearTimeout(interruptionTimer); interruptionTimer = null; }
  }

  function checkTimeLimit() {
    const maxSec = (config.maxMinutes || 30) * 60;
    // Short session: max 10 user messages
    if (config.sessionConstraints?.shortSession) {
      const userMsgs = messages.filter(m => m.role === 'user').length;
      if (userMsgs >= 10 && !sessionEnded) {
        addSystemMessage('⏱ Sessão curta encerrada automaticamente — o cliente não tem mais tempo.');
        setTimeout(() => endSession(), 2000);
        return;
      }
    }
    if (durationSeconds >= maxSec && !sessionEnded) {
      addSystemMessage('⏰ Tempo esgotado! Encerrando sessão automaticamente...');
      setTimeout(() => endSession(), 2000);
    }
  }

  // ══════════════════════════════════════
  // SESSION END & SCORING
  // ══════════════════════════════════════
  function confirmEnd() {
    if (sessionEnded) {
      // Session already ended — just go back to dashboard
      stopTimer();
      App.navigate('seller');
      return;
    }
    if (messages.length < 2) {
      stopTimer();
      sessionEnded = true;
      isWaiting = false;
      App.navigate('seller');
      return;
    }
    // Directly end session to prevent window.confirm blocks
    endSession();
  }

  async function endSession() {
    if (sessionEnded) return;
    sessionEnded = true;
    isWaiting = false; // guarantee UI is never stuck
    stopTimer();

    // Disable send button and show loading — always keep an escape hatch
    const sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    const inputArea = document.getElementById('chat-input-area');
    if (inputArea) inputArea.innerHTML = `
      <div style="text-align:center;padding:var(--sp-6)">
        <div style="color:var(--text-muted);margin-bottom:var(--sp-4)">&#x23F3; Analisando conversa e calculando pontuação...</div>
        <button class="btn btn-ghost btn-sm" onclick="Seller._forceExit()" style="font-size:0.78rem">
          ← Sair sem pontuação
        </button>
      </div>
    `;

    addSystemMessage('&#x1F4CA; Sessão encerrada. Calculando sua pontuação...');

    const session = {
      sellerId: Auth.getUser()?.id,
      config: { ...config },
      messages: messages.map(m => ({ role: m.role, content: m.content, isTrick: m.isTrick })),
      durationSeconds,
      conviction,
      trickCount: tricks,
      agendaRevealed,
      result: null,
      createdAt: new Date().toISOString(),
    };

    let savedSession;
    try { savedSession = Storage.saveSession(session); } catch (e) { savedSession = { id: 'tmp_' + Date.now() }; }

    // Helper: build result safely and navigate to results
    function buildAndShow(evalData) {
      try {
        const result = ScoringEngine.buildResult(evalData, config, session);
        result.hiddenAgendaRevealed = agendaRevealed || evalData?.hiddenAgendaRevealed || false;
        try {
          const userId = Auth.getUser()?.id;
          const allSessions = Storage.getSessionsBySeller(userId);
          result.newBadges = BadgeSystem.checkNewBadges(result, allSessions, config, userId);
        } catch (e) { result.newBadges = []; }
        try { Storage.updateSession(savedSession.id, { result }); } catch (e) {}
        
        // Mark the scheduled session as done if we had one
        if (config._pendingSessionId && typeof Storage.updateScheduledSession === 'function') {
          Storage.updateScheduledSession(config._pendingSessionId, { status: 'done', doneAt: new Date().toISOString() });
        }

        if (config._showReport === false) {
          App.navigate('seller');
          setTimeout(() => UI.toast('Sessão encerrada! Relatório enviado ao gestor.', 'success'), 300);
        } else {
          App.showResults(result, savedSession.id);
        }
      } catch (e) {
        // Last resort: navigate away so user is never stuck
        console.error('endSession buildAndShow failed:', e);
        App.navigate('seller');
      }
    }

    try {
      const aiEval = await AIEngine.evaluateConversation(
        messages.map(m => ({ role: m.role, content: m.content })),
        config
      );
      buildAndShow(aiEval);

    } catch (err) {
      // API failed — use local scoring and still show results
      const fallbackEval = {
        scores: criteriaScores,
        customerConvinced: conviction >= 65,
        convictionFinal: conviction,
        positives: ['Continue praticando para melhorar sua performance.'],
        improvements: ['Análise automática indisponível (erro de conexão com API). Refine sua API Key nas configurações.'],
        highlightMoments: [],
        summary: 'Análise local (sem IA). Configure a API Key para análise completa.',
        narrative: '',
        triggerUsage: {},
        languageVices: [],
        weakPoints: [],
      };
      buildAndShow(fallbackEval);
    }
  }

  // Emergency exit — called by the inline button in the loading overlay
  function _forceExit() {
    stopTimer();
    sessionEnded = true;
    isWaiting = false;
    App.navigate('seller');
  }

  function handleDealbreaker() {
    addSystemMessage('💔 Atenção: você mencionou algo que o cliente considera um dealbreaker! O cliente encerrou a negociação.');
    updateConviction(0);
    setTimeout(() => {
      endSession();
    }, 1500);
  }

  // ══════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════
  function setStatus(text, typing) {
    const statusEl = document.getElementById('status-text');
    if (statusEl) statusEl.textContent = text;
    const dot = document.querySelector('.glow-dot');
    if (dot) dot.style.background = typing ? 'var(--warning)' : 'var(--success)';
  }

  function addSystemMessage(text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-day-label';
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
  }

  function updateMsgCount() {
    const el = document.getElementById('msg-count');
    if (el) el.textContent = messages.filter(m => m.role === 'user').length;
  }

  function scrollToBottom() {
    const c = document.getElementById('chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendUserMessage();
    }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function handleApiError(err) {
    const msgMap = {
      'API_KEY_MISSING': '❌ API Key não configurada. O gestor precisa inserir a chave em Configurações.',
      'API_KEY_INVALID': '❌ API Key inválida. Verifique as configurações.',
      'RATE_LIMIT':      '⚠️ Limite de requisições atingido. Aguarde alguns segundos e tente novamente.',
      'API_ERROR':       '⚠️ Erro de comunicação com a IA. Verifique sua conexão e tente novamente.',
    };

    const rawMsg = err?.message || String(err);
    const isFetchError = rawMsg.toLowerCase().includes('fetch') || rawMsg.toLowerCase().includes('network');
    const display = msgMap[rawMsg]
      || (isFetchError ? '⚠️ Falha de conexão com a IA (Failed to fetch). Verifique sua internet e API Key.' : `⚠️ Erro: ${rawMsg}`);

    addSystemMessage(display);

    // Show a helper button in the input area to unblock the user
    if (isFetchError || rawMsg === 'API_KEY_MISSING' || rawMsg === 'API_KEY_INVALID') {
      const inputArea = document.getElementById('chat-input-area');
      const existing = document.getElementById('api-error-hint');
      if (inputArea && !existing) {
        const hint = document.createElement('div');
        hint.id = 'api-error-hint';
        hint.style.cssText = 'padding:var(--sp-2) var(--sp-4);background:rgba(255,71,87,0.06);border-top:1px solid rgba(255,71,87,0.15);display:flex;align-items:center;gap:var(--sp-3);font-size:0.8rem;';
        hint.innerHTML = `
          <span style="color:var(--danger)">⚠️ API indisponível</span>
          <div style="margin-left:auto;display:flex;gap:4px">
            <button class="btn btn-sm btn-ghost" onclick="Seller._forceExit()">Sair Sem Salvar</button>
            <button class="btn btn-sm btn-ghost" onclick="Seller.confirmEnd()" style="border:1px solid rgba(255,255,255,0.1)">Encerrar (Pontuação Local)</button>
          </div>
        `;
        inputArea.prepend(hint);
      }
    }
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatTime(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return {
    init,
    startTraining,
    sendUserMessage,
    handleKeydown,
    autoResize,
    useHint,
    confirmEnd,
    showXray,
    toggleMic,
    _forceExit,
  };
})();
