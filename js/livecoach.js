// ================================================
// SALESPULSE — Live Coach
// Assistente de IA para chamadas de vendas REAIS
// (Google Meet, Teams, Zoom ou qualquer app no navegador)
//
// Arquitetura:
//  - Canal do microfone  = fala do VENDEDOR.
//  - Canal do áudio da aba compartilhada = fala do CLIENTE.
//  - Transcrição: gpt-4o-mini-transcribe (fallback whisper-1 com filtro
//    estatístico de alucinação via no_speech_prob/avg_logprob), com
//    prompt de contexto contínuo por canal e gate de voz sustentada.
//  - Vídeo da reunião exibido dentro do SalesPulse (modo teatro) e em
//    janela flutuante (Document Picture-in-Picture) com controles:
//    mute do microfone, última dica, estágio e temperatura da venda.
//  - Coach de IA: acionado quando o CLIENTE termina de falar — dica
//    técnica com script pronto e entonação, + estágio e temperatura,
//    personalizado pelo perfil aprendido. A entrega espera o vendedor
//    estar em silêncio (nunca interrompe quem está falando).
//  - Ao encerrar: análise completa + consolidação do perfil do vendedor.
// ================================================

const LiveCoach = (() => {

  const COACH_GAP_CLIENT_MS = 1200;  // cooldown mínimo entre chamadas do coach (anti-duplicata)
  const TIP_MAX_HOLD_MS = 45000;   // dica segurada por mais que isso = assunto já mudou, descarta
  const SAVE_INTERVAL_MS = 12000;  // frequência de persistência no backend
  const PREROLL_MS = 400;          // áudio guardado ANTES da voz começar (não corta a 1ª sílaba)
  const MIN_SPEECH_MS = 350;       // fala mínima para valer uma transcrição
  const MAX_UTTERANCE_MS = 30000;  // corte de segurança para monólogos sem pausa
  const MERGE_WINDOW_MS = 8000;    // falas do mesmo locutor separadas por menos que isso viram um balão só

  let running = false;
  let callId = null;
  let startedAt = null;
  let micStream = null;
  let displayStream = null;
  let audioCtx = null;
  let channels = { seller: null, client: null };  // motor de gravação por canal (VAD)
  let lastSoundAt = { seller: 0, client: 0 };
  let micPaused = false;
  let sharedSurface = null;        // 'browser' (aba) | 'monitor' | 'window'
  let theaterMode = false;
  let pipWin = null;               // janela Document Picture-in-Picture
  let transcript = [];             // { t, speaker: 'seller'|'client', text }
  let tips = [];                   // { t, tip, priority, icon }
  let latestStage = null;          // rapport|descoberta|apresentacao|objecoes|fechamento
  let latestTemp = null;           // 0-100 temperatura da negociação
  let saveTimer = null;
  let clockTimer = null;
  let healthTimer = null;
  let lastCoachedCount = 0;
  let lastCoachAt = 0;
  let tipSoundOn = true;           // aviso sonoro sutil ao chegar dica
  let profile = null;
  let profileHistory = [];         // histórico cumulativo de aprendizados (live + treinos)
  let coach = null;                // coach atribuído pelo gestor: {id, name, special?, profile?}
  let brief = null;                // briefing pré-chamada: produtos, ramo do cliente, diretrizes
  let availableProducts = [];
  let selectedProductIds = new Set();
  let coachBusy = false;
  let coachQueued = false;         // pedido chegou com o coach ocupado → roda logo em seguida
  let clientFinishTimer = null;    // aguarda o cliente TERMINAR de falar antes de acionar o coach
  let pendingTip = null;           // dica pronta aguardando o vendedor PARAR de falar
  let pendingTipTimer = null;
  let captureController = null;    // Captured Surface Control (rolagem/zoom na aba capturada)
  let surfaceCtlEnabled = false;
  let clickHintShown = false;

  // Listas e rótulos vivem no núcleo compartilhado com o WhatsApp Coach
  const INDUSTRIES = CoachCore.INDUSTRIES;
  const STAGE_LABELS = CoachCore.STAGE_LABELS;

  let transcribeModelOk = true;    // gpt-4o-mini-transcribe disponível?

  function getApiKey() {
    return Storage.getConfig().openaiKey || (Storage.getSettings() || {}).openaiKey || null;
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Say pronto para leitura ao vivo: **palavra-chave** vira amarelo (onde
  // dar ênfase na voz) e (PAUSA) fica amarelo (onde pausar). Estilo inline
  // para valer também na janela flutuante (documento separado).
  function renderSay(say) {
    return esc(say)
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#ffd25c;font-weight:800">$1</strong>')
      .replace(/\(\s*pausa\s*\)/gi, '<strong style="color:#ffd25c;font-weight:800">(PAUSA)</strong>');
  }

  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function tempColor(t) {
    if (t === null || t === undefined) return '#5a5a7a';
    if (t >= 70) return '#2ed573';
    if (t >= 40) return '#ffa502';
    return '#ff4757';
  }

  // ══════════════════════════════════════
  // UI — overlay em tela cheia
  // ══════════════════════════════════════
  function ensureOverlay() {
    let el = document.getElementById('livecoach-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'livecoach-overlay';
    document.body.appendChild(el);
    return el;
  }

  function baseStyles() {
    return `
      <style>
        #livecoach-overlay { position: fixed; inset: 0; z-index: 99990; background: #07070f; overflow-y: auto; color: #e8e8f0; font-family: inherit; }
        .lc-wrap { max-width: 1720px; margin: 0 auto; padding: 1.25rem 1.75rem; }
        .lc-header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .lc-title { font-size: 1.3rem; font-weight: 800; }
        .lc-live-dot { width: 10px; height: 10px; border-radius: 50%; background: #ff4757; animation: lcPulse 1.2s infinite; display: inline-block; margin-right: 6px; }
        @keyframes lcPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .lc-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(390px, 460px); gap: 1.25rem; align-items: stretch; }
        .lc-grid.lc-theater { grid-template-columns: 1fr; }
        @media (max-width: 1000px) { .lc-grid { grid-template-columns: 1fr; } }
        .lc-card { background: rgba(14,14,26,0.85); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.25rem; }
        .lc-card + .lc-card { margin-top: 1.25rem; }
        .lc-card-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #5a5a7a; margin-bottom: 0.9rem; }
        .lc-video { width: 100%; max-height: 40vh; border-radius: 10px; background: #000; display: block; object-fit: contain; }
        .lc-theater .lc-video { max-height: 74vh; }
        .lc-transcript { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
        /* ── Tela ao vivo = dashboard 100vh: NADA de rolagem de página.
           Cada painel rola por dentro; dica sempre visível no topo direito. ── */
        .lc-wrap.lc-live { height: 100vh; display: flex; flex-direction: column; padding: 1rem 1.5rem; }
        .lc-live .lc-header { flex-shrink: 0; margin-bottom: 0.9rem; }
        .lc-live .lc-grid { flex: 1; min-height: 0; }
        .lc-col-left { display: flex; flex-direction: column; gap: 1.1rem; min-height: 0; }
        .lc-col-left .lc-card + .lc-card, .lc-col-right .lc-card + .lc-card { margin-top: 0; }
        .lc-video-card { flex-shrink: 0; }
        .lc-transcript-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .lc-transcript-card .lc-transcript { flex: 1; min-height: 0; }
        .lc-col-right { display: flex; flex-direction: column; gap: 1.1rem; min-height: 0; overflow-y: auto; padding-right: 3px; }
        .lc-col-right .lc-card { flex-shrink: 0; }
        .lc-theater .lc-col-right { display: none; }
        .lc-video-hint { margin-top: 8px; font-size: 0.74rem; line-height: 1.4; color: #8a8aad; text-align: center; }
        .lc-video-hint strong { color: #c3beff; font-weight: 700; }
        @media (max-width: 1000px) { .lc-wrap.lc-live { height: auto; } .lc-col-right { overflow: visible; } }
        .lc-seg { padding: 8px 12px; border-radius: 10px; font-size: 0.86rem; line-height: 1.45; max-width: 92%; }
        .lc-seg.seller { background: rgba(108,99,255,0.14); border: 1px solid rgba(108,99,255,0.25); align-self: flex-end; }
        .lc-seg.client { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); align-self: flex-start; }
        .lc-seg-who { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
        .lc-seg.seller .lc-seg-who { color: #a8a2ff; }
        .lc-seg.client .lc-seg-who { color: #00d4aa; }
        /* ── Dica atual: cartão-herói impossível de ignorar ── */
        .lc-hero { position: relative; border-radius: 14px; padding: 14px 16px; border: 1.5px solid; margin-bottom: 12px; animation: lcHeroIn 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.15); }
        @keyframes lcHeroIn { from { transform: translateY(-12px) scale(0.96); opacity: 0; } to { transform: none; opacity: 1; } }
        .lc-hero.urgent { background: linear-gradient(140deg, rgba(255,71,87,0.18), rgba(255,71,87,0.04)); border-color: rgba(255,71,87,0.65); box-shadow: 0 0 28px rgba(255,71,87,0.30), inset 0 0 18px rgba(255,71,87,0.06); }
        .lc-hero.normal { background: linear-gradient(140deg, rgba(108,99,255,0.18), rgba(108,99,255,0.04)); border-color: rgba(108,99,255,0.65); box-shadow: 0 0 28px rgba(108,99,255,0.26), inset 0 0 18px rgba(108,99,255,0.06); }
        .lc-hero.good { background: linear-gradient(140deg, rgba(46,213,115,0.16), rgba(46,213,115,0.04)); border-color: rgba(46,213,115,0.6); box-shadow: 0 0 28px rgba(46,213,115,0.24), inset 0 0 18px rgba(46,213,115,0.05); }
        .lc-hero.stale { box-shadow: none; opacity: 0.72; }
        .lc-hero-label { display: inline-flex; align-items: center; gap: 5px; font-size: 0.62rem; font-weight: 800; letter-spacing: 1.6px; padding: 3px 10px; border-radius: 100px; margin-bottom: 9px; }
        .lc-hero.urgent .lc-hero-label { background: #ff4757; color: #fff; animation: lcPulse 0.9s infinite; }
        .lc-hero.normal .lc-hero-label { background: #6c63ff; color: #fff; }
        .lc-hero.good .lc-hero-label { background: #2ed573; color: #04140b; }
        .lc-tech-chip { display: inline-block; margin-left: 8px; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.6px; padding: 3px 10px; border-radius: 100px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18); color: #c9c9dd; vertical-align: middle; text-transform: uppercase; }
        .lc-hero-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 11px; }
        .lc-hero-body { display: flex; gap: 12px; align-items: flex-start; }
        .lc-hero-icon { font-size: 1.7rem; line-height: 1; flex-shrink: 0; filter: drop-shadow(0 0 8px rgba(255,255,255,0.15)); }
        .lc-hero-text { font-size: 1.04rem; font-weight: 700; line-height: 1.45; color: #f2f2fa; }
        .lc-hero-fresh { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; color: #9494b8; }
        /* FALE ASSIM é o herói do cartão: script grande, ênfases em amarelo */
        .lc-say { padding: 14px 16px; border-radius: 12px; background: rgba(7,7,15,0.6); border: 1px solid rgba(255,255,255,0.16); }
        .lc-say-label { font-size: 0.62rem; font-weight: 800; letter-spacing: 1.4px; color: #9a9abf; margin-bottom: 9px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .lc-say-hint { font-weight: 600; letter-spacing: 0.2px; text-transform: none; font-size: 0.66rem; color: #6f6f92; }
        .lc-say-hint b { color: #ffd25c; font-weight: 700; }
        .lc-say-text { font-size: 1.16rem; line-height: 1.62; color: #ffffff; font-weight: 500; }
        .lc-say-text strong { color: #ffd25c; font-weight: 800; }
        /* Entonação: instrução de COMO falar, logo abaixo do script */
        .lc-hero-tone { margin-top: 11px; display: flex; align-items: flex-start; gap: 8px; font-size: 0.92rem; font-weight: 600; line-height: 1.45; color: #ffd28a; }
        .lc-hero-tone b { color: #ffde9e; font-weight: 800; }
        .lc-tone-ic { font-size: 1rem; line-height: 1.4; flex-shrink: 0; }
        .lc-fresh-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2ed573; margin-right: 5px; animation: lcPulse 1.2s infinite; }
        /* ── Histórico: dicas antigas encolhem e apagam ── */
        .lc-hist { display: flex; gap: 8px; align-items: baseline; padding: 7px 10px; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); margin-bottom: 5px; font-size: 0.78rem; color: #9a9ab5; line-height: 1.35; }
        .lc-hist .lc-hist-time { margin-left: auto; font-size: 0.65rem; color: #5a5a7a; white-space: nowrap; flex-shrink: 0; }
        .lc-hist-divider { font-size: 0.62rem; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: #44445e; margin: 10px 0 6px; }
        .lc-sound-btn { background: none; border: none; cursor: pointer; font-size: 0.95rem; padding: 0 4px; }
        .lc-btn { display: inline-flex; align-items: center; gap: 8px; padding: 0.7rem 1.4rem; border-radius: 100px; border: none; cursor: pointer; font-weight: 700; font-size: 0.9rem; }
        .lc-btn-primary { background: linear-gradient(135deg, #6c63ff, #00d4aa); color: #fff; }
        .lc-btn-danger { background: rgba(255,71,87,0.15); border: 1px solid rgba(255,71,87,0.4); color: #ff4757; }
        .lc-btn-ghost { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #9494b8; }
        .lc-btn-warning { background: rgba(255,165,2,0.15); border: 1px solid rgba(255,165,2,0.4); color: #ffa502; }
        .lc-btn-block { width: 100%; justify-content: center; }
        .lc-setup-step { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.88rem; color: #b9b9d0; }
        .lc-setup-step:last-child { border-bottom: none; }
        .lc-step-num { width: 26px; height: 26px; border-radius: 50%; background: rgba(108,99,255,0.2); color: #a8a2ff; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 0.8rem; flex-shrink: 0; }
        .lc-muted { color: #5a5a7a; font-size: 0.8rem; }
        .lc-chip { display: inline-block; padding: 3px 10px; border-radius: 100px; font-size: 0.72rem; font-weight: 600; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); margin: 2px; }
        .lc-health-row { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; padding: 5px 0; }
        .lc-health-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
        .lc-health-dot.on { background: #2ed573; box-shadow: 0 0 8px rgba(46,213,115,0.6); }
        .lc-health-dot.off { background: #5a5a7a; }
        .lc-health-dot.warn { background: #ff4757; animation: lcPulse 1.2s infinite; }
        .lc-warn-banner { background: rgba(255,165,2,0.10); border: 1px solid rgba(255,165,2,0.35); border-radius: 10px; padding: 10px 12px; font-size: 0.8rem; line-height: 1.5; color: #ffd28a; margin-bottom: 0.9rem; }
        .lc-stage-row { display: flex; align-items: center; gap: 10px; margin-bottom: 0.75rem; flex-wrap: wrap; }
        .lc-temp-track { flex: 1; min-width: 110px; height: 8px; border-radius: 100px; background: rgba(255,255,255,0.07); overflow: hidden; }
        .lc-temp-fill { height: 100%; border-radius: 100px; transition: width 0.6s ease, background 0.6s ease; }
        /* ── Briefing pré-chamada ── */
        .lc-label { display: block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #8a8aad; margin: 1rem 0 0.5rem; }
        .lc-label:first-of-type { margin-top: 0; }
        .lc-pchips { display: flex; flex-wrap: wrap; gap: 8px; }
        .lc-pchip { padding: 8px 14px; border-radius: 100px; border: 1.5px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #b9b9d0; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.18s; user-select: none; }
        .lc-pchip:hover { border-color: rgba(108,99,255,0.5); }
        .lc-pchip.sel { border-color: #00d4aa; background: linear-gradient(135deg, rgba(0,212,170,0.18), rgba(0,212,170,0.06)); color: #7dead0; box-shadow: 0 0 12px rgba(0,212,170,0.2); }
        .lc-pchip.sel::before { content: '✓ '; }
        .lc-input, .lc-select, .lc-textarea { width: 100%; background: rgba(255,255,255,0.045); border: 1.5px solid rgba(255,255,255,0.12); color: #e8e8f0; border-radius: 12px; padding: 0.7rem 0.9rem; font-size: 0.88rem; font-family: inherit; transition: border 0.2s; }
        .lc-input:focus, .lc-select:focus, .lc-textarea:focus { outline: none; border-color: rgba(108,99,255,0.6); background: rgba(255,255,255,0.045); }
        .lc-textarea { min-height: 92px; resize: vertical; line-height: 1.5; }
        .lc-select {width: 100%; background: #1b1b22; color: #e8e8f0; border: 1.5px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 0.7rem 0.9rem;}
        .lc-select option { background: #1b1b22; color: #e8e8f0; }
        .lc-brief-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 100px; font-size: 0.73rem; font-weight: 600; background: rgba(0,212,170,0.1); border: 1px solid rgba(0,212,170,0.3); color: #7dead0; margin: 2px; }
      </style>
    `;
  }

  function open() {
    const key = getApiKey();
    const overlay = ensureOverlay();
    if (!key) {
      overlay.innerHTML = `${baseStyles()}
        <div class="lc-wrap" style="display:flex;align-items:center;justify-content:center;min-height:100vh">
          <div class="lc-card" style="max-width:440px;text-align:center">
            <div style="font-size:2.5rem;margin-bottom:0.75rem">🔑</div>
            <h3 style="margin-bottom:0.5rem">Chave de IA não configurada</h3>
            <p class="lc-muted" style="margin-bottom:1.25rem">O gestor precisa configurar a chave da OpenAI em Configurações para o Live Coach funcionar.</p>
            <button class="lc-btn lc-btn-ghost" onclick="LiveCoach.close()">← Voltar</button>
          </div>
        </div>`;
      overlay.style.display = 'block';
      return;
    }

    // O coach atribuído já aparece na escolha da modalidade — é a mesma
    // pessoa nos dois meios, e ver isso antes de escolher reforça a ideia.
    renderModeChooser();
    Promise.resolve().then(async () => {
      try {
        const p = await API.getLiveProfile(Auth.getUser().id);
        coach = p?.coach || null;
        if (document.querySelector('.lc-mode-grid')) renderModeChooser();
      } catch (e) { coach = null; }
    });
  }

  // ══════════════════════════════════════
  // ESCOLHA DA MODALIDADE
  // O mesmo coach atua nos dois meios (ver js/coachcore.js): por voz, numa
  // chamada ao vivo; por escrito, nas conversas de WhatsApp.
  // ══════════════════════════════════════
  function renderModeChooser() {
    const overlay = ensureOverlay();
    overlay.innerHTML = `${baseStyles()}
      <style>
        .lc-mode-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; max-width: 960px; margin: 0 auto; }
        .lc-mode { text-align: left; cursor: pointer; border: 1.5px solid rgba(255,255,255,0.09); transition: all 0.2s; display: flex; flex-direction: column; gap: 0.8rem; }
        .lc-mode:hover { transform: translateY(-3px); }
        .lc-mode.audio:hover { border-color: rgba(108,99,255,0.65); box-shadow: 0 10px 34px rgba(108,99,255,0.22); }
        .lc-mode.wpp:hover { border-color: rgba(37,211,102,0.65); box-shadow: 0 10px 34px rgba(37,211,102,0.20); }
        /* altura fixa: emojis diferentes têm métricas diferentes e
           desalinhavam o topo dos dois cartões */
        .lc-mode-ic { font-size: 2.4rem; line-height: 1; height: 2.6rem; display: flex; align-items: center; }
        .lc-mode-h { font-size: 1.08rem; font-weight: 800; }
        .lc-mode-d { font-size: 0.86rem; line-height: 1.55; color: #9494b8; }
        .lc-mode-f { font-size: 0.8rem; line-height: 1.7; color: #b9b9d0; padding-left: 1.05rem; margin: 0; }
      </style>
      <div class="lc-wrap">
        <div class="lc-header">
          <button class="lc-btn lc-btn-ghost" onclick="LiveCoach.close()">← Voltar</button>
          <div class="lc-title">🎧 Live Coach — escolha a modalidade</div>
        </div>
        <p class="lc-muted" style="text-align:center;max-width:660px;margin:0 auto 1.6rem">
          Nas duas o coach é o mesmo${coach && coach.id === 'junior' ? ' (⭐ Júnior Smarzaro)' : coach && coach.name ? ` (estilo de ${esc(coach.name)})` : ''} e as sugestões seguem a mesma cabeça de vendas.
          Muda o meio: numa você <strong>fala</strong>, na outra você <strong>escreve</strong>.
        </p>
        <div class="lc-mode-grid">
          <div class="lc-card lc-mode audio" onclick="LiveCoach.startAudioMode()">
            <div class="lc-mode-ic">🎙</div>
            <div class="lc-mode-h">Chamada ao vivo (áudio)</div>
            <div class="lc-mode-d">Para reuniões no Meet, Teams ou Zoom. O coach ouve os dois lados, transcreve e te entrega a fala pronta com entonação.</div>
            <ul class="lc-mode-f">
              <li>Transcrição ao vivo dos dois canais</li>
              <li>Script para falar, com ênfases e pausas</li>
              <li>Janela flutuante por cima da reunião</li>
              <li>Análise final + evolução do seu perfil</li>
            </ul>
            <button class="lc-btn lc-btn-primary lc-btn-block" style="margin-top:auto">🎙 Usar modo áudio</button>
          </div>
          <div class="lc-card lc-mode wpp" onclick="LiveCoach.startWhatsappMode()">
            <div class="lc-mode-ic">💬</div>
            <div class="lc-mode-h">WhatsApp (mensagens)</div>
            <div class="lc-mode-d">Você escaneia o QR do WhatsApp e o coach acompanha as conversas novas, escrevendo a resposta pronta para copiar e colar.</div>
            <ul class="lc-mode-f">
              <li>QR Code igual ao do WhatsApp Web</li>
              <li>Todas as conversas iniciadas dali em diante</li>
              <li>Mensagem pronta, é só copiar e colar</li>
              <li>Briefing por conversa + termômetro</li>
            </ul>
            <button class="lc-btn lc-btn-primary lc-btn-block" style="margin-top:auto;background:linear-gradient(135deg,#25d366,#00a884);color:#04140b">💬 Usar modo WhatsApp</button>
          </div>
        </div>
      </div>`;
    overlay.style.display = 'block';
  }

  // Modo áudio: fluxo original (briefing → captura de tela/mic → dicas faladas)
  function startAudioMode() {
    const overlay = ensureOverlay();
    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap" style="display:flex;align-items:center;justify-content:center;min-height:60vh">
        <div class="lc-muted">Carregando seus produtos...</div>
      </div>`;
    overlay.style.display = 'block';
    Promise.resolve().then(async () => {
      try { availableProducts = (await API.listProducts()) || []; } catch (e) { availableProducts = []; }
      try {
        const p = await API.getLiveProfile(Auth.getUser().id);
        coach = p?.coach || null;
      } catch (e) { coach = null; }
      selectedProductIds = new Set();
      renderSetup();
    });
  }

  // Modo WhatsApp: entrega a tela ao módulo irmão (js/whatsappcoach.js)
  function startWhatsappMode() {
    const overlay = document.getElementById('livecoach-overlay');
    if (overlay) overlay.style.display = 'none';
    WhatsAppCoach.open();
  }

  function renderSetup() {
    const overlay = ensureOverlay();
    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap">
        <div class="lc-header">
          <button class="lc-btn lc-btn-ghost" onclick="LiveCoach.renderModeChooser()">← Modalidades</button>
          <div class="lc-title">🎙 Live Coach — Chamada ao vivo (áudio)</div>
        </div>
        <div class="lc-grid">
          <div class="lc-card">
            <div class="lc-card-title">🎯 Briefing da chamada — o coach vai agir com base nisso</div>

            <label class="lc-label">1 · O que você vai vender? *</label>
            ${availableProducts.length > 0 ? `
              <div class="lc-pchips">
                ${availableProducts.map(p => `
                  <span class="lc-pchip" data-id="${p.id}" onclick="LiveCoach.toggleProduct(this)">${esc(p.name)}${p.price ? ` · ${esc(p.price)}` : ''}</span>
                `).join('')}
              </div>
              <input class="lc-input" id="lc-brief-extra" placeholder="Outro produto/serviço não cadastrado (opcional)" style="margin-top:10px">
            ` : `
              <div class="lc-muted" style="margin-bottom:8px">Você não tem produtos cadastrados — descreva abaixo o que vai vender.</div>
              <input class="lc-input" id="lc-brief-extra" placeholder="Ex: Consultoria de marketing digital, plano trimestral R$ 4.500">
            `}

            <label class="lc-label">2 · Ramo do cliente</label>
            <select class="lc-select" id="lc-brief-industry">
              ${INDUSTRIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
            </select>

            <label class="lc-label">3 · Contexto da chamada (linguagem natural, opcional)</label>
            <textarea class="lc-textarea" id="lc-brief-directives" placeholder="Ex: É uma segunda reunião, o cliente já viu a demo e travou no preço. Objetivo de hoje: fechar o plano anual com no máximo 10% de desconto. Decisor é o CFO, perfil analítico — usar números e ROI. Não mencionar o concorrente X."></textarea>
            <div class="lc-muted" style="margin-top:6px">O coach usa isso como contexto da venda — objetivo, histórico, limites de negociação, perfil do decisor, o que evitar. Não muda o jeito do coach: ele continua falando do estilo dele, só que embasado nesse contexto.</div>
          </div>

          <div>
            <div class="lc-card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1rem">
              <div style="font-size:3rem">🎙</div>
              ${coach && coach.id === 'junior'
                ? `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:14px;border:1.5px solid rgba(255,200,50,0.55);background:linear-gradient(135deg, rgba(255,200,50,0.14), rgba(20,20,35,0.6));box-shadow:0 0 20px rgba(255,200,50,0.25)">
                    <img src="img/junior.jpg" style="width:46px;height:46px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,200,50,0.75)" alt="Júnior Smarzaro">
                    <div style="text-align:left">
                      <div style="font-weight:800;color:#ffd76a;font-size:0.92rem">⭐ Seu coach: Júnior Smarzaro</div>
                      <div class="lc-muted" style="font-size:0.68rem">Coach Master · alta performance comercial</div>
                    </div>
                  </div>`
                : coach && coach.name
                  ? `<div class="lc-chip" style="border-color:rgba(0,212,170,0.4);color:#7dead0">🧬 Seu coach: Estilo de ${esc(coach.name)}</div>`
                  : ''}
              <p class="lc-muted">Transcrição ao vivo, dicas em tempo real moldadas pelo seu briefing, temperatura da negociação e aprendizado do seu perfil.</p>
              <button class="lc-btn lc-btn-primary" onclick="LiveCoach.start()" id="lc-start-btn">🚀 Iniciar Live Coach</button>
              <div class="lc-muted" id="lc-start-status"></div>
            </div>
            <div class="lc-card">
              <div class="lc-card-title">Como funciona</div>
              <div class="lc-setup-step"><div class="lc-step-num">1</div><div>Abra sua reunião (Meet, Teams, Zoom Web...) em <strong>outra aba deste navegador</strong>.</div></div>
              <div class="lc-setup-step"><div class="lc-step-num">2</div><div>Ao iniciar, selecione a <strong>ABA da reunião</strong> (não a tela inteira!) e marque <strong>"Compartilhar áudio da guia"</strong>.</div></div>
              <div class="lc-setup-step"><div class="lc-step-num">3</div><div>Permita o <strong>microfone</strong> e use <strong>fones de ouvido</strong>.</div></div>
              <div class="lc-setup-step"><div class="lc-step-num">4</div><div>Use a <strong>🗔 Janela flutuante</strong> para ver dicas, termômetro e mutar o coach por cima da reunião. Com <strong>🖱 Controle da aba</strong> (Chrome), dá para rolar e dar zoom na aba da reunião direto pelo espelho.</div></div>
              <div class="lc-setup-step"><div class="lc-step-num">5</div><div>⚠️ O mudo do Meet/Teams <strong>não silencia o Live Coach</strong> — use o botão de microfone daqui.</div></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function toggleProduct(el) {
    const id = String(el.dataset.id);
    if (selectedProductIds.has(id)) { selectedProductIds.delete(id); el.classList.remove('sel'); }
    else { selectedProductIds.add(id); el.classList.add('sel'); }
  }

  // Monta o briefing a partir do formulário; retorna null se inválido
  function collectBrief() {
    const products = availableProducts.filter(p => selectedProductIds.has(String(p.id)));
    const extra = (document.getElementById('lc-brief-extra')?.value || '').trim();
    if (products.length === 0 && !extra) return null;
    const sel = document.getElementById('lc-brief-industry');
    return {
      products: products.map(p => ({
        id: p.id, name: p.name, price: p.price || '',
        description: p.description || '', benefits: p.benefits || [],
      })),
      extraProduct: extra || null,
      industry: sel?.value || 'geral',
      industryLabel: sel?.options[sel.selectedIndex]?.text || 'Geral',
      directives: (document.getElementById('lc-brief-directives')?.value || '').trim() || null,
    };
  }

  // Bloco do briefing injetado em todos os prompts do coach (ver coachcore.js)
  function briefBlock() {
    return CoachCore.briefBlock(brief);
  }

  function close() {
    if (running) {
      if (!confirm('A chamada está sendo monitorada. Encerrar o Live Coach?')) return;
      stop(true);
      return;
    }
    const overlay = document.getElementById('livecoach-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // ══════════════════════════════════════
  // START — captura de áudio (2 canais)
  // ══════════════════════════════════════
  async function start() {
    const statusEl = document.getElementById('lc-start-status');
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

    // Briefing é obrigatório: pelo menos um produto (ou descrição livre)
    brief = collectBrief();
    if (!brief) {
      setStatus('⚠️ Selecione ao menos um produto (ou descreva o que vai vender) antes de iniciar.');
      return;
    }

    try {
      setStatus('Selecione a ABA da reunião e marque "Compartilhar áudio da guia"...');
      // Captured Surface Control (Chrome 136+): permite rolar/dar zoom na aba
      // capturada de dentro do SalesPulse, e evita roubar o foco ao iniciar.
      captureController = null;
      surfaceCtlEnabled = false;
      clickHintShown = false;
      try {
        if ('CaptureController' in window) {
          captureController = new CaptureController();
          try { captureController.setFocusBehavior('no-focus-change'); } catch (e) {}
        }
      } catch (e) { captureController = null; }
      const gdmOpts = { video: true, audio: true };
      if (captureController) gdmOpts.controller = captureController;
      displayStream = await navigator.mediaDevices.getDisplayMedia(gdmOpts);

      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach(t => t.stop());
        displayStream = null;
        alert('O compartilhamento veio SEM áudio. Selecione a ABA da reunião e marque a caixinha "Compartilhar áudio da guia" antes de confirmar.');
        setStatus('');
        return;
      }

      try {
        sharedSurface = displayStream.getVideoTracks()[0]?.getSettings()?.displaySurface || null;
      } catch (e) { sharedSurface = null; }

      setStatus('Agora permita o acesso ao microfone...');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });

      setStatus('Preparando...');
      try { await Notification.requestPermission(); } catch (e) {}

      const created = await API.createLiveCall(brief);
      callId = created?.id || ('call_' + Date.now());

      const user = Auth.getUser();
      try {
        const p = await API.getLiveProfile(user.id);
        profile = (p && p.profile && Object.keys(p.profile).length > 0) ? p.profile : null;
        profileHistory = Array.isArray(p?.history) ? p.history : [];
        coach = p?.coach || null;
      } catch (e) { profile = null; profileHistory = []; coach = null; }

      running = true;
      startedAt = Date.now();
      transcript = [];
      tips = [];
      latestStage = null;
      latestTemp = null;
      lastCoachedCount = 0;
      channels = { seller: null, client: null };
      lastSoundAt = { seller: 0, client: 0 };
      micPaused = false;
      theaterMode = false;
      transcribeModelOk = true;
      pendingTip = null;
      if (pendingTipTimer) { clearInterval(pendingTipTimer); pendingTipTimer = null; }

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const tabAudioStream = new MediaStream(displayStream.getAudioTracks());
      startChannel(micStream, 'seller');
      startChannel(tabAudioStream, 'client');

      const vTrack = displayStream.getVideoTracks()[0];
      if (vTrack) vTrack.addEventListener('ended', () => { if (running) stop(); });

      lastCoachAt = 0;
      coachQueued = false;
      // Sem timer periódico: o coach é acionado EXCLUSIVAMENTE quando o
      // cliente termina de falar — dica na hora certa, nunca no meio.
      saveTimer = setInterval(persist, SAVE_INTERVAL_MS);
      healthTimer = setInterval(renderHealth, 3000);

      renderLive();
    } catch (err) {
      console.error('[LiveCoach] start failed', err);
      cleanupMedia();
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setStatus('Captura cancelada. Tente novamente quando quiser.');
      } else {
        setStatus('Erro ao iniciar: ' + (err?.message || err));
      }
    }
  }

  // ══════════════════════════════════════
  // MOTOR DE CANAL — buffer PCM contínuo com VAD adaptativo
  //
  // O áudio bruto é capturado sem interrupção (nada de parar/reiniciar
  // gravador — zero perda entre falas). Um detector de voz decide onde
  // cada fala começa e termina:
  //  - PRÉ-CAPTURA: 400ms anteriores ao início da voz entram no trecho
  //    (a primeira sílaba nunca é cortada).
  //  - PAUSA ADAPTATIVA: pausas breves de respiração/pensamento NÃO
  //    encerram a fala — a tolerância varia com o contexto: início de
  //    fala tolera até 1,8s de pausa; meio de fala 1,4s; monólogos
  //    longos 1,0s.
  //  - LIMIAR ADAPTATIVO: o piso de ruído de cada canal é medido
  //    continuamente e o limiar de voz se ajusta sozinho ao ambiente.
  // Cada fala completa vira um WAV 16kHz e vai para transcrição.
  // ══════════════════════════════════════
  function adaptiveHang(speechDur, speaker) {
    // Canal do CLIENTE fecha mais rápido: cada fala dele vira dica, e cada
    // 100ms aqui é latência direta na dica. Fragmentação não é problema —
    // o merge de balões e o gate de entrega reagrupam.
    if (speaker === 'client') {
      if (speechDur < 2500) return 700;
      if (speechDur > 15000) return 500;
      return 620;
    }
    if (speechDur < 2500) return 1800;   // começo de fala: tolera pausa maior
    if (speechDur > 15000) return 1000;  // monólogo longo: corta mais rápido
    return 1400;                          // meio de fala: tolerância padrão
  }

  function startChannel(stream, speaker) {
    const ch = {
      state: 'idle',            // 'idle' | 'speaking'
      preroll: [],              // buffers de pré-captura (áudio antes da voz)
      prerollLen: 0,
      utter: [],                // buffers da fala em andamento
      utterLen: 0,
      speechStartAt: 0,
      lastVoiceAt: 0,
      voicedMs: 0,
      noiseFloor: 0.008,        // piso de ruído (EMA) → limiar adaptativo
      nodes: [],
    };
    channels[speaker] = ch;

    const srcNode = audioCtx.createMediaStreamSource(stream);
    const proc = audioCtx.createScriptProcessor(4096, 1, 1);
    const sink = audioCtx.createGain();
    sink.gain.value = 0; // mantém o grafo ativo sem ecoar áudio
    srcNode.connect(proc);
    proc.connect(sink);
    sink.connect(audioCtx.destination);
    ch.nodes = [srcNode, proc, sink];

    const sampleRate = audioCtx.sampleRate;
    const prerollMaxSamples = Math.round(PREROLL_MS / 1000 * sampleRate);

    proc.onaudioprocess = (e) => {
      if (!running) return;
      const input = e.inputBuffer.getChannelData(0);
      const frameMs = input.length / sampleRate * 1000;

      // Energia do frame
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);

      // Limiar adaptativo: piso de ruído aprendido + margem
      const threshold = Math.max(0.015, Math.min(0.06, ch.noiseFloor * 3 + 0.007));
      const voiced = rms > threshold;
      if (!voiced) ch.noiseFloor = ch.noiseFloor * 0.97 + rms * 0.03;

      const now = Date.now();
      if (voiced) {
        ch.lastVoiceAt = now;
        lastSoundAt[speaker] = now;
      }

      if (ch.state === 'idle') {
        // Mantém a janela de pré-captura girando
        ch.preroll.push(new Float32Array(input));
        ch.prerollLen += input.length;
        while (ch.prerollLen > prerollMaxSamples && ch.preroll.length > 1) {
          ch.prerollLen -= ch.preroll[0].length;
          ch.preroll.shift();
        }
        if (voiced) {
          // Voz começou: inicia a fala já incluindo a pré-captura
          ch.state = 'speaking';
          ch.speechStartAt = now;
          ch.voicedMs = frameMs;
          ch.utter = ch.preroll.slice();
          ch.utterLen = ch.prerollLen;
          ch.utter.push(new Float32Array(input));
          ch.utterLen += input.length;
        }
      } else {
        // speaking: acumula tudo (inclusive as pausas internas)
        ch.utter.push(new Float32Array(input));
        ch.utterLen += input.length;
        if (voiced) ch.voicedMs += frameMs;

        const silence = now - ch.lastVoiceAt;
        const dur = now - ch.speechStartAt;
        if (silence > adaptiveHang(dur, speaker) || dur > MAX_UTTERANCE_MS) {
          closeUtterance(ch, speaker, sampleRate);
        }
      }
    };
  }

  function closeUtterance(ch, speaker, sampleRate) {
    const buffers = ch.utter;
    const totalLen = ch.utterLen;
    const voicedMs = ch.voicedMs;
    ch.state = 'idle';
    ch.utter = [];
    ch.utterLen = 0;
    ch.voicedMs = 0;
    ch.preroll = [];
    ch.prerollLen = 0;

    if (voicedMs < MIN_SPEECH_MS) return;                      // só ruído/blip
    if (speaker === 'seller' && micPaused) return;             // mic do coach desligado

    try {
      const pcm16k = downsampleTo16k(buffers, totalLen, sampleRate);
      const wav = encodeWav(pcm16k, 16000);
      transcribeChunk(wav, speaker);
    } catch (e) { console.warn('[LiveCoach] encode fail', e); }
  }

  function downsampleTo16k(buffers, totalLen, fromRate) {
    const input = new Float32Array(totalLen);
    let o = 0;
    for (const b of buffers) { input.set(b, o); o += b.length; }
    const ratio = fromRate / 16000;
    const outLen = Math.floor(totalLen / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), totalLen);
      let sum = 0, c = 0;
      for (let j = start; j < end; j++) { sum += input[j]; c++; }
      out[i] = c ? sum / c : 0;
    }
    return out;
  }

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ══════════════════════════════════════
  // TRANSCRIÇÃO — modelo novo + filtro estatístico + contexto contínuo
  // ══════════════════════════════════════
  const JUNK_PATTERNS = [
    // Eco do próprio prompt de contexto da transcrição (whisper devolve o
    // prompt em trechos de silêncio/ruído — virava "fala do cliente")
    'reunião de vendas em português brasileiro', 'termos comuns: proposta',
    'português brasileiro por videochamada', 'termos comuns:',
    'amara.org', 'legendas pela comunidade', 'legendado por', 'transcrito por',
    'obrigado por assistir', 'não se esqueça de se inscrever', 'inscreva-se no canal',
    'se inscreva no canal', 'curta o vídeo', 'deixe seu like', 'até o próximo vídeo',
    'obrigado por acompanhar', '[música]', '[aplausos]', '♪', '♫',
    'tchau, tchau!', 'valeu, falou', 'www.', 'http', 'legenda por',
  ];

  function isNoise(text) {
    const lower = text.toLowerCase().trim();
    if (JUNK_PATTERNS.some(j => lower.includes(j))) return true;
    if (!/[a-zà-úçãõáéíóúâêôü0-9]/i.test(lower)) return true;
    if (['obrigado.', 'obrigada.', 'tchau.', 'tchau!', 'até mais.', 'é...', 'hã?', 'ok.'].includes(lower)) return true;
    return false;
  }

  // Prompt de contexto: informa o domínio e a "cauda" do que o mesmo canal
  // já disse — melhora consistência de nomes/termos entre blocos.
  function buildTranscribePrompt(speaker) {
    const tail = transcript.filter(s => s.speaker === speaker).slice(-3).map(s => s.text).join(' ').slice(-220);
    return `Reunião de vendas em português brasileiro por videochamada. Termos comuns: proposta, orçamento, contrato, desconto, prazo, reunião, cliente, produto. ${tail}`;
  }

  async function whisperTranscribe(blob, speaker) {
    const key = getApiKey();

    // 1ª opção: gpt-4o-mini-transcribe (mais preciso, menos alucinação)
    if (transcribeModelOk) {
      try {
        const fd = new FormData();
        fd.append('file', blob, 'chunk.wav');
        fd.append('model', 'gpt-4o-mini-transcribe');
        fd.append('language', 'pt');
        fd.append('temperature', '0');
        fd.append('prompt', buildTranscribePrompt(speaker));
        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: fd,
        });
        if (res.ok) {
          const data = await res.json();
          return (data.text || '').trim();
        }
        // Modelo indisponível na conta → passa a usar whisper-1 direto
        if (res.status === 404 || res.status === 400 || res.status === 403) transcribeModelOk = false;
        else return '';
      } catch (e) { /* cai para o fallback */ }
    }

    // Fallback: whisper-1 com verbose_json → filtro estatístico de alucinação
    const fd = new FormData();
    fd.append('file', blob, 'chunk.wav');
    fd.append('model', 'whisper-1');
    fd.append('language', 'pt');
    fd.append('temperature', '0');
    fd.append('response_format', 'verbose_json');
    fd.append('prompt', buildTranscribePrompt(speaker));
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: fd,
    });
    if (!res.ok) return '';
    const data = await res.json();
    // Descarta segmentos que o próprio modelo considera prováveis alucinações
    const segs = (data.segments || []).filter(s =>
      (s.no_speech_prob === undefined || s.no_speech_prob < 0.5) &&
      (s.avg_logprob === undefined || s.avg_logprob > -1.2)
    );
    return segs.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(t) {
    return t.toLowerCase().replace(/[^\wà-úçãõ ]/gi, '').replace(/\s+/g, ' ').trim();
  }

  async function transcribeChunk(blob, speaker) {
    try {
      const text = await whisperTranscribe(blob, speaker);
      if (!text || text.length < 3 || isNoise(text)) return;

      // Anti-repetição: descarta se for igual (ou contido) na última fala do mesmo canal
      const lastSame = [...transcript].reverse().find(s => s.speaker === speaker);
      if (lastSame) {
        const a = normalizeText(lastSame.text);
        const b = normalizeText(text);
        if (a === b || (b.length > 10 && a.includes(b)) || (a.length > 10 && b.includes(a) && (Date.now() - lastSame.t) < 30000)) return;
      }

      // Continuidade: se a última fala do transcript é do MESMO locutor e
      // recente, une no mesmo balão — pausas breves não quebram a frase.
      const last = transcript[transcript.length - 1];
      if (last && last.speaker === speaker && (Date.now() - last.t) < MERGE_WINDOW_MS) {
        last.text = (last.text + ' ' + text).replace(/\s+/g, ' ').trim();
        last.t = Date.now();
      } else {
        transcript.push({ t: Date.now(), speaker, text });
      }
      renderTranscript();

      // Cliente falou → aciona o coach assim que ele TERMINAR a fala
      // (se ele só respirou e continuou, espera concluir o raciocínio).
      if (speaker === 'client') scheduleClientCoach();
    } catch (e) {
      console.warn('[LiveCoach] transcribe fail', e?.message);
    }
  }

  // ══════════════════════════════════════
  // MIC — controle total da captura
  // ══════════════════════════════════════
  function toggleMicPause() {
    micPaused = !micPaused;
    if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = !micPaused; });
    if (micPaused && channels.seller) {
      // Descarta qualquer fala em andamento do vendedor
      channels.seller.state = 'idle';
      channels.seller.utter = [];
      channels.seller.utterLen = 0;
      channels.seller.voicedMs = 0;
    }
    const btn = document.getElementById('lc-mic-btn');
    if (btn) {
      btn.className = micPaused ? 'lc-btn lc-btn-warning lc-btn-block' : 'lc-btn lc-btn-ghost lc-btn-block';
      btn.innerHTML = micPaused ? '🔇 Microfone do coach DESLIGADO — clique para ligar' : '🎤 Microfone do coach LIGADO — clique para desligar';
    }
    renderHealth();
    updatePip();
  }

  // ══════════════════════════════════════
  // COACH — dicas + estágio + temperatura
  // Modelo do bot de treino (Realtime): não esperar nada que não precise
  // ser esperado. A GERAÇÃO da dica começa assim que a transcrição do
  // cliente chega — em paralelo com o fim da fala dele. Só a EXIBIÇÃO
  // espera: a dica aparece quando o cliente terminou E o vendedor está
  // em silêncio. Pedido com o coach ocupado entra na fila; bloqueio por
  // cooldown reagenda — nada é descartado.
  // ══════════════════════════════════════
  function clientStillTalking() {
    const ch = channels.client;
    if (!ch) return false;
    if (ch.state === 'speaking') return true;
    return (Date.now() - (ch.lastVoiceAt || 0)) < 600;
  }

  function scheduleClientCoach() {
    if (clientFinishTimer) { clearTimeout(clientFinishTimer); clientFinishTimer = null; }
    if (!running) return;
    requestCoach('client'); // gera JÁ; a entrega é que espera o momento certo
  }

  async function requestCoach(trigger) {
    if (!running) return;
    if (coachBusy) { coachQueued = true; return; }
    if (transcript.length - lastCoachedCount < 1) return;
    const sinceGap = Date.now() - lastCoachAt;
    if (sinceGap < COACH_GAP_CLIENT_MS) {
      // Nunca descarta: reagenda para o instante em que o cooldown expira
      if (clientFinishTimer) clearTimeout(clientFinishTimer);
      clientFinishTimer = setTimeout(scheduleClientCoach, COACH_GAP_CLIENT_MS - sinceGap + 60);
      return;
    }
    coachBusy = true;
    lastCoachAt = Date.now();
    const sinceCount = transcript.length;

    try {
      // Falas com idade relativa: o coach sabe o que é o assunto ATUAL
      // e o que já ficou para trás (dica atrasada = dica errada).
      const nowT = Date.now();
      const recent = transcript.slice(-12)
        .map(s => `[há ${Math.max(0, Math.round((nowT - s.t) / 1000))}s] ${s.speaker === 'seller' ? 'VENDEDOR' : 'CLIENTE'}: ${s.text}`)
        .join('\n');

      const profileBlock = profile
        ? `\nPERFIL CONHECIDO DO VENDEDOR (aprendido em chamadas anteriores — personalize a dica com base nele):\n${JSON.stringify(profile)}\n`
        : '';

      // Memória das próprias dicas: sem isso o coach repetia o mesmo
      // argumento (ex: o mesmo ROI) em sequência, chamada inteira.
      const tipHistoryBlock = tips.length
        ? `\nDICAS QUE VOCÊ JÁ DEU NESTA CHAMADA (mais recente primeiro — NÃO as repita):\n${tips.slice(0, 6)
            .map(t => `- [${new Date(t.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${t.technique || 'sem técnica'} · ${t.priority}] ${t.tip}${t.say ? ` | say: "${String(t.say).slice(0, 90)}"` : ''}`)
            .join('\n')}\n`
        : '';

      // Persona do coach atribuído pelo gestor (compartilhada com o WhatsApp Coach)
      const coachPersona = CoachCore.persona(coach);

      // Prompt montado com o BLOCO ESTÁTICO primeiro (persona + regras +
      // formato) e o DINÂMICO por último (briefing/perfil/histórico/
      // transcrição). Isso ativa o cache automático de prompt da OpenAI:
      // do 2º disparo em diante o prefixo estático não é reprocessado →
      // menos latência (TTFT) em toda a chamada.
      const prompt = `${coachPersona}, observando em silêncio uma chamada de vendas REAL por vídeo. O VENDEDOR é seu aluno; você escreve a fala PRONTA que ele deve dizer AGORA. Quando o cliente termina de falar, capte o subtexto (hesitação/frase inacabada = insegurança; resposta seca = desinteresse/pressa; pergunta sobre preço/prazo/contrato = sinal de compra; tema que volta = objeção real disfarçada) e escreva a resposta perfeita, espelhando as palavras do cliente.

${CoachCore.playbook('audio')}

MARCAÇÃO DO "say" (é o que o vendedor LÊ ao vivo — ele precisa usar em 1 segundo):
- Envolva em **asteriscos** APENAS as 1-3 PALAVRAS-CHAVE que carregam o peso e devem ser enfatizadas na voz (ex: **garantia**, **hoje**, **grátis**, o número). NUNCA marque frases inteiras nem palavras banais.
- Escreva (PAUSA) exatamente onde ele deve pausar de propósito (antes do preço, antes da pergunta de fechamento). Use com parcimônia.

REGRA DE OURO DO OUTPUT: tip e say andam JUNTOS. Ou você retorna os dois preenchidos (uma dica COM o script pronto), ou retorna tip=null e say=null (silêncio). NUNCA retorne um tip sem say — dica sem a fala pronta é inútil e será descartada pelo sistema.

Retorne SÓ JSON:
{
 "tip": "diagnóstico interno curtíssimo (máx 10 palavras). null → então say também null",
 "say": "a fala pronta do vendedor, 1-3 frases faladas (máx 42 palavras), com **palavras-chave** e (PAUSA) embutidos. OBRIGATÓRIO sempre que tip existir.",
 "grounded": <true só se cada número/fato/promessa do say tem fonte; senão false — say descartado>,
 "technique": "técnica aplicada, 2-4 palavras",
 "priority": "urgent|normal|good",
 "stage": "rapport|descoberta|apresentacao|objecoes|fechamento",
 "temperature": <0-100 quão quente está a negociação>
}
Se o vendedor mandou bem, priority "good": no tip diga a técnica que ele acertou e no say a jogada seguinte.

━━━━━ BRIEFING DESTA CHAMADA ━━━━━${briefBlock()}${profileBlock}
━━━━━ CONVERSA AO VIVO ━━━━━${tipHistoryBlock}
Falas recentes (mais recente por último; transcrição automática, pode ter erros):
${recent}

⚡ O CLIENTE ACABOU DE FALAR. Escreva a resposta que o vendedor deve dar AGORA.`;

      // Modelo do coach = gpt-4o-mini: o mini de menor latência. Com o
      // prompt enxuto + grounding + kill-switch, mantém a qualidade e
      // responde rápido (prioridade máxima aqui é chegar a tempo).
      // Timeout curto: um request pendurado segurava o coachBusy e
      // congelava TODAS as dicas seguintes da chamada.
      const parsed = await CoachCore.ask(prompt, getApiKey());
      if (!parsed) return; // timeout/rede/erro: solta o coachBusy e a próxima fala tenta de novo
      {
        if (parsed.stage && STAGE_LABELS[parsed.stage]) latestStage = parsed.stage;
        if (typeof parsed.temperature === 'number') latestTemp = Math.max(0, Math.min(100, Math.round(parsed.temperature)));
        renderStage();
        if (parsed.tip) {
          // Kill-switch do say: placeholder ("X reais", "[valor]") ou
          // autocertificação grounded=false → script inválido.
          const say = CoachCore.validSay(parsed.say, parsed.grounded);
          // Dica é SEMPRE script pronto: sem say, não há dica (nunca o
          // cartão-resumo de fallback). Anti-obsolescência: se a conversa
          // andou muito enquanto gerava, o assunto mudou — descarta (exceto urgente).
          const grewBy = transcript.length - sinceCount;
          if (say && (grewBy < 3 || parsed.priority === 'urgent')) {
            const prio = parsed.priority || 'normal';
            deliverTip({
              t: Date.now(),
              tip: parsed.tip,
              say,
              technique: parsed.technique || null,
              priority: prio,
              icon: prio === 'urgent' ? '🔥' : prio === 'good' ? '✅' : '💬',
            });
          }
        }
        updatePip();
      }
      lastCoachedCount = sinceCount;
    } catch (e) {
      console.warn('[LiveCoach] coach fail', e?.message);
    } finally {
      coachBusy = false;
      // Pedido que chegou enquanto o coach rodava: atende agora, sem descartar
      if (coachQueued) {
        coachQueued = false;
        setTimeout(() => scheduleClientCoach(), 60);
      }
    }
  }

  // ── Gate de entrega: NUNCA mostra dica enquanto o VENDEDOR está falando ──
  // Uma dica chegando no meio da fala tira a concentração. A dica fica
  // segurada e aparece no instante em que ele faz uma pausa. Se ficar
  // segurada tempo demais, o assunto já mudou — é descartada.
  function sellerMidSpeech() {
    if (micPaused) return false;
    const ch = channels.seller;
    if (!ch) return false;
    if (ch.state === 'speaking') return true;
    return (Date.now() - (ch.lastVoiceAt || 0)) < 700;
  }

  // Rede de segurança final contra repetição: mesmo que o modelo insista
  // numa dica parecida com as recentes, ela é descartada aqui (Jaccard
  // sobre as palavras significativas de tip+say — ver coachcore.js).
  function tooSimilarToRecent(tip) {
    return CoachCore.tooSimilar(tip, tips);
  }

  function deliverTip(tip) {
    if (tooSimilarToRecent(tip)) return; // repetida = pior que nenhuma
    // Exibe só quando o CLIENTE terminou de falar e o VENDEDOR está em silêncio
    if (!clientStillTalking() && !sellerMidSpeech()) { addTip(tip); return; }
    pendingTip = tip; // dica mais nova substitui a que estava na fila
    if (!pendingTipTimer) pendingTipTimer = setInterval(tryFlushPendingTip, 300);
  }

  function tryFlushPendingTip() {
    if (!pendingTip || !running) {
      pendingTip = null;
      if (pendingTipTimer) { clearInterval(pendingTipTimer); pendingTipTimer = null; }
      return;
    }
    if (Date.now() - pendingTip.t > TIP_MAX_HOLD_MS) {
      pendingTip = null;
      clearInterval(pendingTipTimer); pendingTipTimer = null;
      return;
    }
    if (clientStillTalking() || sellerMidSpeech()) return;
    const tip = pendingTip;
    pendingTip = null;
    clearInterval(pendingTipTimer); pendingTipTimer = null;
    addTip(tip);
  }

  let lastChimeAt = 0;
  function addTip(tip) {
    tips.unshift(tip);
    renderTips();
    updatePip();
    // Som com disciplina: urgent/good sempre tocam; "normal" no máximo a
    // cada 25s — dica é ajuda, não alarme.
    const now = Date.now();
    if (tip.priority !== 'normal' || now - lastChimeAt > 25000) {
      playChime(tip.priority);
      lastChimeAt = now;
    }
    try {
      // Notificação do navegador só quando estiver em OUTRA aba e a dica
      // for urgente (ou a primeira da chamada) — nada de spam repetitivo.
      if (document.hidden && Notification.permission === 'granted' && (tip.priority === 'urgent' || tips.length === 1)) {
        const body = `${tip.icon} ${tip.tip}${tip.say ? `\n💬 "${tip.say.replace(/\*\*/g, '')}"` : ''}`.slice(0, 180);
        new Notification('🎧 Live Coach', { body, tag: 'livecoach-tip' });
      }
    } catch (e) {}
  }

  // Aviso sonoro sutil (2 notas, ~160ms) — desligável no painel
  function playChime(priority) {
    if (!tipSoundOn || !audioCtx) return;
    try {
      const t0 = audioCtx.currentTime;
      const freqs = priority === 'urgent' ? [740, 988] : priority === 'good' ? [660, 880] : [587, 784];
      freqs.forEach((f, i) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.09);
        g.gain.linearRampToValueAtTime(0.055, t0 + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.11);
        osc.connect(g); g.connect(audioCtx.destination);
        osc.start(t0 + i * 0.09);
        osc.stop(t0 + i * 0.09 + 0.12);
      });
    } catch (e) {}
  }

  function toggleSound() {
    tipSoundOn = !tipSoundOn;
    const btn = document.getElementById('lc-sound-btn');
    if (btn) { btn.textContent = tipSoundOn ? '🔔' : '🔕'; btn.title = tipSoundOn ? 'Som de dica ligado' : 'Som de dica desligado'; }
  }

  async function persist() {
    if (!callId) return;
    try {
      await API.updateLiveCall(callId, { transcript, tips });
    } catch (e) { console.warn('[LiveCoach] persist fail', e?.message); }
  }

  // ══════════════════════════════════════
  // RENDER — tela ao vivo
  // ══════════════════════════════════════
  function renderLive() {
    const overlay = ensureOverlay();
    const surfaceWarning = (sharedSurface && sharedSurface !== 'browser')
      ? `<div class="lc-warn-banner">⚠️ Você compartilhou a <strong>${sharedSurface === 'monitor' ? 'tela inteira' : 'janela'}</strong>. Nesse modo, o áudio do cliente vem do som do sistema — se o volume do PC estiver mudo, o coach <strong>não ouve o cliente</strong>. Para captura independente do volume, encerre e compartilhe a <strong>ABA da reunião</strong> com "Compartilhar áudio da guia".</div>`
      : '';

    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap lc-live">
        <div class="lc-header">
          <div class="lc-title"><span class="lc-live-dot"></span>Live Coach — Monitorando chamada</div>
          <div class="lc-chip" id="lc-clock">00:00</div>
          ${coach && coach.id === 'junior'
            ? `<div class="lc-chip" style="display:inline-flex;align-items:center;gap:7px;padding-left:4px;border-color:rgba(255,200,50,0.6);background:linear-gradient(135deg, rgba(255,200,50,0.18), rgba(255,160,0,0.08));color:#ffd76a;font-weight:800">
                 <img src="img/junior.jpg" style="width:20px;height:20px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,200,50,0.8)" alt="">⭐ Coach: Júnior Smarzaro
               </div>`
            : coach && coach.name
              ? `<div class="lc-chip" style="border-color:rgba(0,212,170,0.4);color:#7dead0">🧬 Coach: Estilo de ${esc(coach.name)}</div>`
              : `<div class="lc-chip">🤖 Coach Padrão</div>`}
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="lc-btn lc-btn-danger" onclick="LiveCoach.stop()">⏹ Encerrar e Analisar</button>
          </div>
        </div>
        <div class="lc-grid" id="lc-main-grid">
          <div class="lc-col-left">
            <div class="lc-card lc-video-card" style="padding:0.9rem">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem;gap:8px;flex-wrap:wrap">
                <div class="lc-card-title" style="margin:0">🖥 Sua reunião (ao vivo)</div>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                  ${surfaceControlSupported() ? `
                    <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.enableSurfaceControl()" id="lc-interact-btn" title="Rolar e dar zoom na aba da reunião daqui de dentro">🖱 Ativar controle da aba</button>
                    <span id="lc-zoom-ctl" style="display:none;align-items:center;gap:4px">
                      <button class="lc-btn lc-btn-ghost" style="padding:0.3rem 0.7rem;font-size:0.8rem" onclick="LiveCoach.zoomSurface(-1)" title="Diminuir zoom da aba">−</button>
                      <span class="lc-muted" id="lc-zoom-val" style="min-width:38px;text-align:center">100%</span>
                      <button class="lc-btn lc-btn-ghost" style="padding:0.3rem 0.7rem;font-size:0.8rem" onclick="LiveCoach.zoomSurface(1)" title="Aumentar zoom da aba">＋</button>
                    </span>
                  ` : ''}
                  <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.toggleTheater()" id="lc-theater-btn">⛶ Ampliar</button>
                  <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.pip()">🗔 Janela flutuante</button>
                </div>
              </div>
              <video id="lc-video" class="lc-video" autoplay muted playsinline onclick="LiveCoach.videoClicked()"></video>
              ${surfaceControlSupported()
                ? `<div class="lc-video-hint" id="lc-video-hint">🖱 <strong>Role o mouse sobre o vídeo</strong> para rolar a reunião · use os botões de zoom · para <strong>clicar</strong> em algo, vá até a aba da reunião (Alt+Tab)</div>`
                : `<div class="lc-video-hint">🖥 Espelho da reunião. Para interagir (clicar, rolar), use a própria aba da reunião — Alt+Tab.</div>`}
            </div>
            <div class="lc-card lc-transcript-card">
              <div class="lc-card-title">📝 Transcrição ao vivo</div>
              <div class="lc-transcript" id="lc-transcript">
                <div class="lc-muted">Aguardando as primeiras falas...</div>
              </div>
            </div>
          </div>
          <div class="lc-col-right">
            <div class="lc-card lc-coach-card">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div class="lc-card-title" style="margin-bottom:0.9rem">💡 Coach em tempo real</div>
                <button class="lc-sound-btn" id="lc-sound-btn" onclick="LiveCoach.toggleSound()" title="Som de dica ligado">🔔</button>
              </div>
              <div id="lc-tips"><div class="lc-muted">As dicas aparecem aqui conforme a conversa evolui.</div></div>
            </div>
            <div class="lc-card">
              <div class="lc-card-title">🌡 Termômetro da negociação</div>
              <div id="lc-stage"><div class="lc-muted">Analisando os primeiros minutos...</div></div>
            </div>
            <div class="lc-card">
              <div class="lc-card-title">🎛 Controles e áudio</div>
              ${surfaceWarning}
              <button class="lc-btn lc-btn-ghost lc-btn-block" id="lc-mic-btn" onclick="LiveCoach.toggleMicPause()">🎤 Microfone do coach LIGADO — clique para desligar</button>
              <div style="margin-top:0.75rem" id="lc-health"></div>
            </div>
            ${brief ? `
            <div class="lc-card" style="padding:0.9rem 1.25rem">
              <div class="lc-card-title" style="margin-bottom:0.5rem">🎯 Briefing ativo</div>
              ${(brief.products || []).map(p => `<span class="lc-brief-chip">📦 ${esc(p.name)}</span>`).join('')}
              ${brief.extraProduct ? `<span class="lc-brief-chip">📦 ${esc(brief.extraProduct)}</span>` : ''}
              <span class="lc-brief-chip" style="border-color:rgba(108,99,255,0.35);background:rgba(108,99,255,0.1);color:#c3beff">${esc(brief.industryLabel)}</span>
              ${brief.directives ? `<div class="lc-muted" style="margin-top:6px;line-height:1.45">📋 ${esc(brief.directives.slice(0, 160))}${brief.directives.length > 160 ? '…' : ''}</div>` : ''}
            </div>
            ` : ''}
          </div>
        </div>
      </div>`;
    overlay.style.display = 'block';

    const video = document.getElementById('lc-video');
    if (video && displayStream) {
      video.srcObject = displayStream;
      video.play().catch(() => {});
    }

    // Tenta ativar o controle da aba já de cara (rolagem/zoom sem clique
    // extra). Se o navegador exigir um gesto, o clique no vídeo ativa depois.
    if (surfaceControlSupported()) {
      setTimeout(() => { enableSurfaceControl(true); }, 400);
    }

    clockTimer = setInterval(() => {
      const el = document.getElementById('lc-clock');
      if (el && startedAt) el.textContent = fmtClock(Date.now() - startedAt);
      const pel = pipWin?.document?.getElementById('pip-clock');
      if (pel && startedAt) pel.textContent = fmtClock(Date.now() - startedAt);
      tickTipFreshness();
    }, 1000);

    renderHealth();
    renderStage();
  }

  function toggleTheater() {
    theaterMode = !theaterMode;
    const grid = document.getElementById('lc-main-grid');
    const btn = document.getElementById('lc-theater-btn');
    if (grid) grid.classList.toggle('lc-theater', theaterMode);
    if (btn) btn.textContent = theaterMode ? '🗗 Reduzir' : '⛶ Ampliar';
  }

  // ══════════════════════════════════════
  // CONTROLE DA ABA CAPTURADA (Captured Surface Control, Chrome 136+)
  // Rolar com o mouse sobre o espelho da reunião rola a ABA REAL da
  // reunião; botões de zoom ajustam o zoom da aba. Cliques dentro do
  // espelho não são repassados — nenhum navegador permite injetar
  // cliques numa aba capturada (segurança); o clique aqui ativa o modo.
  // ══════════════════════════════════════
  function surfaceControlSupported() {
    return !!(captureController && typeof captureController.forwardWheel === 'function' && sharedSurface === 'browser');
  }

  async function enableSurfaceControl(silent = false) {
    if (surfaceCtlEnabled) return;
    if (!surfaceControlSupported()) {
      if (!silent) { try { UI.toast('Controle da aba indisponível: use Chrome 136+ e compartilhe a ABA da reunião.', 'warning'); } catch (e) {} }
      return;
    }
    const video = document.getElementById('lc-video');
    if (!video) return;
    try {
      await captureController.forwardWheel(video);
      surfaceCtlEnabled = true;
      const btn = document.getElementById('lc-interact-btn');
      if (btn) { btn.textContent = '✅ Controle ativo'; btn.style.borderColor = 'rgba(0,212,170,0.5)'; btn.style.color = '#7dead0'; }
      refreshZoomUI();
      if (!silent) { try { UI.toast('Controle ativo: role o mouse sobre o vídeo para rolar a reunião. Cliques não são repassados pelo navegador — para clicar, use a aba da reunião.', 'success'); } catch (e) {} }
    } catch (e) {
      console.warn('[LiveCoach] surface control fail', e);
      if (!silent) { try { UI.toast('Não foi possível ativar o controle da aba: ' + (e?.message || 'permissão negada'), 'warning'); } catch (e2) {} }
    }
  }

  function refreshZoomUI() {
    const ctl = document.getElementById('lc-zoom-ctl');
    if (!ctl) return;
    if (!surfaceCtlEnabled || typeof captureController?.getZoomLevel !== 'function') { ctl.style.display = 'none'; return; }
    ctl.style.display = 'inline-flex';
    try {
      const val = document.getElementById('lc-zoom-val');
      if (val) val.textContent = captureController.getZoomLevel() + '%';
    } catch (e) {}
  }

  async function zoomSurface(dir) {
    if (!surfaceCtlEnabled || typeof captureController?.setZoomLevel !== 'function') return;
    try {
      const levels = captureController.getSupportedZoomLevels();
      const cur = captureController.getZoomLevel();
      let idx = levels.indexOf(cur);
      if (idx === -1) idx = levels.findIndex(l => l >= cur);
      const next = levels[Math.max(0, Math.min(levels.length - 1, idx + dir))];
      if (next && next !== cur) await captureController.setZoomLevel(next);
      refreshZoomUI();
    } catch (e) { console.warn('[LiveCoach] zoom fail', e); }
  }

  function videoClicked() {
    if (!surfaceCtlEnabled && surfaceControlSupported()) { enableSurfaceControl(); return; }
    if (!clickHintShown) {
      clickHintShown = true;
      try {
        UI.toast(surfaceCtlEnabled
          ? 'Rolagem e zoom funcionam aqui; para CLICAR em algo, use a própria aba da reunião (o navegador não permite repassar cliques).'
          : 'Este é um espelho da reunião — para clicar em algo, vá até a aba da reunião (Alt+Tab / Ctrl+Tab).', 'info');
      } catch (e) {}
    }
  }

  function renderStage() {
    const el = document.getElementById('lc-stage');
    if (!el) return;
    if (latestStage === null && latestTemp === null) {
      el.innerHTML = '<div class="lc-muted">Analisando os primeiros minutos...</div>';
      return;
    }
    const st = STAGE_LABELS[latestStage] || null;
    el.innerHTML = `
      ${st ? `<div class="lc-stage-row"><span class="lc-chip" style="border-color:rgba(108,99,255,0.4);background:rgba(108,99,255,0.12)">${st.icon} Estágio: <strong>&nbsp;${st.label}</strong></span></div>` : ''}
      ${latestTemp !== null ? `
        <div class="lc-stage-row">
          <span style="font-size:0.82rem">🌡</span>
          <div class="lc-temp-track"><div class="lc-temp-fill" style="width:${latestTemp}%;background:${tempColor(latestTemp)}"></div></div>
          <strong style="color:${tempColor(latestTemp)};font-size:0.9rem">${latestTemp}%</strong>
        </div>
        <div class="lc-muted">${latestTemp >= 70 ? 'Negociação quente — considere avançar para o fechamento.' : latestTemp >= 40 ? 'Interesse moderado — continue explorando a dor e gerando valor.' : 'Cliente frio — foque em rapport e descoberta antes de vender.'}</div>
      ` : ''}
    `;
  }

  function renderHealth() {
    const el = document.getElementById('lc-health');
    if (!el || !running) return;
    const now = Date.now();
    const ago = (t) => t ? Math.round((now - t) / 1000) : null;

    const sellerAgo = ago(lastSoundAt.seller);
    const clientAgo = ago(lastSoundAt.client);

    const sellerDot = micPaused ? 'off' : (sellerAgo !== null && sellerAgo < 10 ? 'on' : 'off');
    const sellerLabel = micPaused
      ? '🎤 Você: microfone desligado'
      : (sellerAgo === null ? '🎤 Você: aguardando sua primeira fala' : (sellerAgo < 10 ? '🎤 Você: ouvindo' : `🎤 Você: sem áudio há ${sellerAgo}s`));

    const clientWarn = clientAgo === null ? (now - startedAt > 30000) : clientAgo > 45;
    const clientDot = clientWarn ? 'warn' : (clientAgo !== null && clientAgo < 10 ? 'on' : 'off');
    const clientLabel = clientAgo === null
      ? '🖥 Cliente: nenhum áudio recebido ainda'
      : (clientAgo < 10 ? '🖥 Cliente: ouvindo' : `🖥 Cliente: sem áudio há ${clientAgo}s`);

    el.innerHTML = `
      <div class="lc-health-row"><span class="lc-health-dot ${sellerDot}"></span>${sellerLabel}</div>
      <div class="lc-health-row"><span class="lc-health-dot ${clientDot}"></span>${clientLabel}</div>
      ${clientWarn ? `<div class="lc-warn-banner" style="margin:6px 0 0">⚠️ Não estou ouvindo o cliente. Verifique: (1) você marcou "Compartilhar áudio da guia"? (2) se compartilhou a tela inteira, o som do PC precisa estar ligado; (3) o cliente está falando/desmutado?</div>` : ''}
    `;
    updatePipHealth(sellerDot, clientDot);
  }

  // ══════════════════════════════════════
  // JANELA FLUTUANTE (Document Picture-in-Picture)
  // Vídeo + dica ao vivo + termômetro + mute do coach, por cima de tudo.
  // ══════════════════════════════════════
  async function pip() {
    // Fecha se já aberta
    if (pipWin) { try { pipWin.close(); } catch (e) {} pipWin = null; return; }

    if ('documentPictureInPicture' in window) {
      try {
        pipWin = await documentPictureInPicture.requestWindow({ width: 400, height: 430 });
        const d = pipWin.document;
        d.body.style.cssText = 'margin:0;background:#07070f;color:#e8e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;';
        d.body.innerHTML = `
          <style>
            .p-row { display:flex; align-items:center; gap:8px; padding:8px 12px; }
            .p-dot { width:8px; height:8px; border-radius:50%; }
            .p-btn { border:none; border-radius:100px; padding:10px 14px; font-weight:700; font-size:0.85rem; cursor:pointer; width:calc(100% - 24px); margin:6px 12px 10px; }
            .p-temp-track { flex:1; height:7px; border-radius:100px; background:rgba(255,255,255,0.1); overflow:hidden; }
            .p-temp-fill { height:100%; border-radius:100px; transition:width 0.6s ease, background 0.6s ease; }
          </style>
          <video id="pip-video" autoplay muted playsinline style="width:100%;max-height:170px;background:#000;object-fit:contain;flex-shrink:0"></video>
          <div class="p-row" style="justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06)">
            <span style="font-size:0.72rem;font-weight:700;color:#5a5a7a">🎧 LIVE COACH</span>
            <span id="pip-clock" style="font-size:0.75rem;color:#9494b8">00:00</span>
          </div>
          <div class="p-row" id="pip-stage-row" style="display:none">
            <span id="pip-stage" style="font-size:0.75rem;font-weight:700;color:#a8a2ff"></span>
            <div class="p-temp-track"><div class="p-temp-fill" id="pip-temp-fill" style="width:0%"></div></div>
            <strong id="pip-temp" style="font-size:0.8rem"></strong>
          </div>
          <div id="pip-tip-box" style="flex:1;margin:8px 12px;padding:10px 12px;border-radius:12px;border:1.5px solid rgba(255,255,255,0.1);overflow-y:auto;transition:all 0.3s">
            <div id="pip-tip-label" style="display:none;font-size:0.58rem;font-weight:800;letter-spacing:1.4px;padding:2px 8px;border-radius:100px;margin-bottom:6px;width:fit-content"></div>
            <div id="pip-tip" style="font-size:0.95rem;font-weight:600;line-height:1.45;color:#e8e8f0">Aguardando a primeira dica do coach...</div>
            <div id="pip-say" style="display:none;margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,0.45);border:1px dashed rgba(255,255,255,0.25);font-size:0.88rem;line-height:1.5;color:#fff"></div>
            <div id="pip-fresh" style="font-size:0.65rem;color:#9494b8;margin-top:6px"></div>
          </div>
          <div class="p-row" style="gap:12px;padding-top:0">
            <span class="p-dot" id="pip-dot-seller" style="background:#5a5a7a"></span><span style="font-size:0.7rem;color:#9494b8">Você</span>
            <span class="p-dot" id="pip-dot-client" style="background:#5a5a7a"></span><span style="font-size:0.7rem;color:#9494b8">Cliente</span>
          </div>
          <button class="p-btn" id="pip-mic"></button>
        `;
        const v = d.getElementById('pip-video');
        if (displayStream) { v.srcObject = displayStream; v.play().catch(() => {}); }
        // Se o controle da aba está ativo, a rolagem passa a funcionar também
        // sobre o vídeo da janela flutuante (o forwardWheel aponta para 1 elemento).
        if (surfaceCtlEnabled && captureController) {
          try { Promise.resolve(captureController.forwardWheel(v)).catch(() => {}); } catch (e) {}
        }
        d.getElementById('pip-mic').addEventListener('click', () => toggleMicPause());
        pipWin.addEventListener('pagehide', () => {
          pipWin = null;
          if (surfaceCtlEnabled && captureController) {
            const mainV = document.getElementById('lc-video');
            if (mainV) { try { Promise.resolve(captureController.forwardWheel(mainV)).catch(() => {}); } catch (e) {} }
          }
        });
        updatePip();
      } catch (e) {
        console.warn('[LiveCoach] doc-pip fail', e);
        pipWin = null;
        fallbackVideoPip();
      }
    } else {
      fallbackVideoPip();
    }
  }

  async function fallbackVideoPip() {
    const v = document.getElementById('lc-video');
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      try { UI.toast('Janela flutuante não disponível neste navegador.', 'warning'); } catch (e2) {}
    }
  }

  function updatePip() {
    if (!pipWin) return;
    const d = pipWin.document;
    try {
      const micBtn = d.getElementById('pip-mic');
      if (micBtn) {
        micBtn.textContent = micPaused ? '🔇 Mic do coach DESLIGADO — ligar' : '🎤 Mic do coach LIGADO — desligar';
        micBtn.style.background = micPaused ? 'rgba(255,165,2,0.2)' : 'rgba(255,255,255,0.08)';
        micBtn.style.color = micPaused ? '#ffa502' : '#c9c9dd';
        micBtn.style.border = micPaused ? '1px solid rgba(255,165,2,0.5)' : '1px solid rgba(255,255,255,0.15)';
      }
      const tipEl = d.getElementById('pip-tip');
      if (tipEl && tips.length > 0) {
        const t = tips[0];
        const theme = t.priority === 'urgent'
          ? { fg: '#ffb3ba', border: 'rgba(255,71,87,0.7)', bg: 'rgba(255,71,87,0.12)', label: '⚡ RESPONDA AGORA', labelBg: '#ff4757', labelFg: '#fff' }
          : t.priority === 'good'
            ? { fg: '#a9f5c8', border: 'rgba(46,213,115,0.6)', bg: 'rgba(46,213,115,0.10)', label: '✅ MANDOU BEM', labelBg: '#2ed573', labelFg: '#04140b' }
            : { fg: '#d5d1ff', border: 'rgba(108,99,255,0.7)', bg: 'rgba(108,99,255,0.12)', label: '🎯 DICA', labelBg: '#6c63ff', labelFg: '#fff' };
        tipEl.innerHTML = `<span style="font-size:1.2rem;margin-right:6px">${t.icon || '🎯'}</span><span style="color:${theme.fg}">${esc(t.tip)}</span>`;
        const sayEl = d.getElementById('pip-say');
        if (sayEl) {
          if (t.say) {
            sayEl.style.display = 'block';
            sayEl.innerHTML = `<span style="font-size:0.58rem;font-weight:800;letter-spacing:1.2px;color:#8a8aad">💬 FALE ASSIM · <span style="color:#ffd25c">amarelo=ênfase</span></span><br>"${renderSay(t.say)}"`;
          } else {
            sayEl.style.display = 'none';
          }
        }
        const box = d.getElementById('pip-tip-box');
        if (box) { box.style.borderColor = theme.border; box.style.background = theme.bg; box.style.boxShadow = `0 0 16px ${theme.bg}`; }
        const lbl = d.getElementById('pip-tip-label');
        if (lbl) { lbl.style.display = 'block'; lbl.textContent = theme.label + (t.technique ? ` · ${t.technique}` : ''); lbl.style.background = theme.labelBg; lbl.style.color = theme.labelFg; }
        const pf = d.getElementById('pip-fresh');
        if (pf) pf.textContent = freshLabel(t.t);
      }
      const stRow = d.getElementById('pip-stage-row');
      if (stRow && (latestStage !== null || latestTemp !== null)) {
        stRow.style.display = 'flex';
        const st = STAGE_LABELS[latestStage];
        const stEl = d.getElementById('pip-stage');
        if (stEl && st) stEl.textContent = `${st.icon} ${st.label}`;
        const tf = d.getElementById('pip-temp-fill');
        const tv = d.getElementById('pip-temp');
        if (tf && latestTemp !== null) { tf.style.width = latestTemp + '%'; tf.style.background = tempColor(latestTemp); }
        if (tv && latestTemp !== null) { tv.textContent = latestTemp + '%'; tv.style.color = tempColor(latestTemp); }
      }
    } catch (e) {}
  }

  function updatePipHealth(sellerDot, clientDot) {
    if (!pipWin) return;
    try {
      const d = pipWin.document;
      const map = { on: '#2ed573', off: '#5a5a7a', warn: '#ff4757' };
      const ds = d.getElementById('pip-dot-seller');
      const dc = d.getElementById('pip-dot-client');
      if (ds) ds.style.background = map[sellerDot] || '#5a5a7a';
      if (dc) dc.style.background = map[clientDot] || '#5a5a7a';
    } catch (e) {}
  }

  function renderTranscript() {
    const el = document.getElementById('lc-transcript');
    if (!el) return;
    el.innerHTML = transcript.map(s => `
      <div class="lc-seg ${s.speaker}">
        <div class="lc-seg-who">${s.speaker === 'seller' ? '🎤 Você' : '🖥 Cliente'}</div>
        ${esc(s.text)}
      </div>
    `).join('') || '<div class="lc-muted">Aguardando as primeiras falas...</div>';
    el.scrollTop = el.scrollHeight;
  }

  const HERO_LABELS = { urgent: '⚡ RESPONDA AGORA', normal: '🎯 DICA', good: '✅ MANDOU BEM' };

  function freshLabel(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 5) return 'agora';
    if (s < 60) return `há ${s}s`;
    return `há ${Math.floor(s / 60)}min`;
  }

  function renderTips() {
    const el = document.getElementById('lc-tips');
    if (!el) return;
    if (tips.length === 0) {
      el.innerHTML = '<div class="lc-muted">As dicas aparecem aqui conforme a conversa evolui.</div>';
      return;
    }
    const hero = tips[0];
    const history = tips.slice(1, 7);
    const stale = (Date.now() - hero.t) > 45000;
    el.innerHTML = `
      <div class="lc-hero ${hero.priority}${stale ? ' stale' : ''}" id="lc-hero">
        <div class="lc-hero-top">
          <span class="lc-hero-label">${HERO_LABELS[hero.priority] || HERO_LABELS.normal}</span>
          ${hero.technique ? `<span class="lc-tech-chip">📐 ${esc(hero.technique)}</span>` : ''}
        </div>
        ${hero.say ? `
          <div class="lc-say">
            <div class="lc-say-label">💬 FALE ASSIM <span class="lc-say-hint"><b>amarelo</b> = enfatize · <b>(PAUSA)</b> = pause aqui</span></div>
            <div class="lc-say-text">"${renderSay(hero.say)}"</div>
          </div>
        ` : `
          <div class="lc-hero-body">
            <span class="lc-hero-icon">${hero.icon || '🎯'}</span>
            <div class="lc-hero-text">${esc(hero.tip)}</div>
          </div>
        `}
        <div class="lc-hero-fresh">
          <span><span class="lc-fresh-dot"></span><span id="lc-tip-fresh">${freshLabel(hero.t)}</span></span>
          <span>${new Date(hero.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      </div>
      ${history.length ? `<div class="lc-hist-divider">Anteriores</div>` : ''}
      ${history.map((t, i) => `
        <div class="lc-hist" style="opacity:${Math.max(0.35, 0.85 - i * 0.12)}">
          <span>${t.icon || '🎯'}</span>
          <span>${esc(t.tip)}${t.technique ? ` <em style="color:#6b6b8f;font-style:normal">· ${esc(t.technique)}</em>` : ''}</span>
          <span class="lc-hist-time">${new Date(t.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `).join('')}
    `;
  }

  // Atualiza o frescor da dica-herói (chamado pelo relógio de 1s)
  function tickTipFreshness() {
    if (tips.length === 0) return;
    const freshEl = document.getElementById('lc-tip-fresh');
    if (freshEl) freshEl.textContent = freshLabel(tips[0].t);
    const heroEl = document.getElementById('lc-hero');
    if (heroEl && (Date.now() - tips[0].t) > 45000) heroEl.classList.add('stale');
    if (pipWin) {
      try {
        const pf = pipWin.document.getElementById('pip-fresh');
        if (pf) pf.textContent = freshLabel(tips[0].t);
      } catch (e) {}
    }
  }

  // ══════════════════════════════════════
  // STOP — análise final + aprendizado de perfil
  // ══════════════════════════════════════
  function cleanupMedia() {
    Object.values(channels).forEach(ch => {
      if (ch && ch.nodes) ch.nodes.forEach(n => { try { n.disconnect(); } catch (e) {} });
    });
    channels = { seller: null, client: null };
    if (pipWin) { try { pipWin.close(); } catch (e) {} pipWin = null; }
    try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) {}
    [micStream, displayStream].forEach(s => { if (s) s.getTracks().forEach(t => t.stop()); });
    micStream = null; displayStream = null;
    captureController = null;
    surfaceCtlEnabled = false;
    pendingTip = null;
    if (pendingTipTimer) { clearInterval(pendingTipTimer); pendingTipTimer = null; }
    if (clientFinishTimer) { clearTimeout(clientFinishTimer); clientFinishTimer = null; }
    coachQueued = false;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  async function stop(skipConfirmClose = false) {
    if (!running) return;
    running = false;
    cleanupMedia();

    const overlay = ensureOverlay();
    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap" style="display:flex;align-items:center;justify-content:center;min-height:100vh">
        <div class="lc-card" style="max-width:480px;text-align:center">
          <div style="font-size:2.5rem;margin-bottom:0.75rem">🧠</div>
          <h3 style="margin-bottom:0.5rem">Analisando a chamada...</h3>
          <p class="lc-muted">A IA está gerando o resumo e atualizando seu perfil de vendedor.</p>
        </div>
      </div>`;

    let summary = null;
    const user = Auth.getUser();

    try {
      if (transcript.length >= 4) {
        const fullText = transcript
          .map(s => `${s.speaker === 'seller' ? 'VENDEDOR' : 'CLIENTE'}: ${s.text}`)
          .join('\n')
          .slice(0, 24000);

        const eventContext = `CHAMADA REAL por videochamada. O canal CLIENTE pode conter mais de uma pessoa do lado remoto. A transcrição pode conter pequenos fragmentos com erro — ignore-os.
${briefBlock()}
Avalie também se o vendedor trabalhou bem o contexto da chamada (objetivo, limites, perfil do decisor) e explorou bem os produtos do briefing.

TRANSCRIÇÃO DA CHAMADA:
${fullText}`;

        const parsed = await consolidateLearning({
          userName: user?.name || 'Vendedor',
          sourceLabel: 'CHAMADA REAL',
          eventContext,
          currentProfile: profile,
          history: profileHistory,
        });
        if (parsed) {
          summary = parsed.eventSummary || null;
          if (parsed.profile) {
            profile = parsed.profile;
            const event = {
              source: 'live',
              summary,
              strengths: parsed.eventStrengths || [],
              weaknesses: parsed.eventWeaknesses || [],
              industry: brief?.industryLabel || null,
            };
            try { await API.saveLiveProfile(user.id, profile, event); } catch (e) { console.warn('profile save fail', e); }
          }
        }
      }
    } catch (e) {
      console.warn('[LiveCoach] final analysis fail', e?.message);
    }

    try {
      await API.updateLiveCall(callId, {
        transcript, tips,
        summary: summary || (transcript.length < 4 ? 'Chamada muito curta para análise.' : null),
        endedAt: new Date().toISOString(),
      });
    } catch (e) { console.warn('[LiveCoach] final persist fail', e?.message); }

    renderEnded(summary);
  }

  // ══════════════════════════════════════
  // DOSSIÊ EVOLUTIVO — consolidação cumulativa de aprendizados
  // Cada evento (chamada real OU treinamento) alimenta um histórico; a
  // consolidação recebe o perfil atual + o histórico e PRESERVA os pontos
  // bons recorrentes em vez de reescrever do zero a cada chamada.
  // ══════════════════════════════════════
  function historyDigest(history) {
    if (!history || history.length === 0) return '(sem eventos anteriores — primeira análise)';
    return history.slice(-12).map(e => {
      const d = e.t ? new Date(e.t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '?';
      const src = e.source === 'training' ? 'treino' : 'chamada real';
      const st = (e.strengths || []).slice(0, 3).join('; ');
      const wk = (e.weaknesses || []).slice(0, 3).join('; ');
      return `[${d} · ${src}${e.score !== undefined && e.score !== null ? ` · nota ${e.score}` : ''}]${st ? ` fortes: ${st}` : ''}${wk ? ` | melhorar: ${wk}` : ''}`;
    }).join('\n');
  }

  async function consolidateLearning({ userName, sourceLabel, eventContext, currentProfile, history }) {
    const prompt = `Você é um coach de vendas sênior responsável pelo DOSSIÊ EVOLUTIVO do vendedor "${userName}". O dossiê é CUMULATIVO: construído ao longo de muitas interações (chamadas reais e sessões de treinamento), capturando e preservando os pontos bons de cada uma.

PERFIL CONSOLIDADO ATUAL (vazio se primeira análise):
${JSON.stringify(currentProfile || {})}

HISTÓRICO DE APRENDIZADOS ANTERIORES (mais antigo → mais recente):
${historyDigest(history)}

NOVO EVENTO — ${sourceLabel}:
${eventContext}

REGRAS DE CONSOLIDAÇÃO CUMULATIVA (obrigatórias):
1. PRESERVE os pontos fortes recorrentes já comprovados em eventos anteriores — NÃO os descarte só porque não apareceram neste evento.
2. Registre EVOLUÇÃO explicitamente (ex: "reduziu vícios de linguagem nas últimas 3 interações", "escuta ativa evoluiu de fraca para consistente").
3. Padrão que se repete em 3+ eventos = traço consolidado do vendedor; mencione a recorrência.
4. O que apareceu só neste evento entra como observação recente, sem apagar o acumulado.
5. Fraqueza superada em eventos recentes deve migrar para evolução, não permanecer como fraqueza.

Retorne EXCLUSIVAMENTE JSON:
{
  "eventSummary": "resumo deste evento e do desempenho em 2-4 frases",
  "eventStrengths": ["até 4 pontos bons ESPECÍFICOS deste evento"],
  "eventWeaknesses": ["até 4 pontos a melhorar ESPECÍFICOS deste evento"],
  "profile": {
    "styleSummary": "estilo consolidado do vendedor em 2-4 frases, mencionando a trajetória ao longo das interações",
    "strengths": ["até 7 pontos fortes consolidados, priorizando os recorrentes"],
    "weaknesses": ["até 6 pontos a melhorar consolidados"],
    "languageVices": ["vícios de linguagem persistentes"],
    "recommendations": ["até 6 dicas personalizadas para as próximas interações"],
    "evolutionNotes": ["até 4 marcos de evolução observados ao longo do tempo"]
  }
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getApiKey()}` },
      body: JSON.stringify({
        model: Storage.getConfig().openaiModel || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1100,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    try { return JSON.parse(data.choices[0]?.message?.content || 'null'); } catch (e) { return null; }
  }

  // Chamado pelo módulo de TREINAMENTO (seller.js) ao fim de cada sessão
  // simulada — o dossiê aprende também com os treinos, não só com as
  // chamadas reais. Fire-and-forget: nunca bloqueia a tela de resultados.
  async function learnFromTraining(trainMessages, evalData, trainConfig, totalScore) {
    try {
      const user = Auth.getUser();
      if (!user || !getApiKey()) return;

      let currentProfile = null;
      let history = [];
      try {
        const p = await API.getLiveProfile(user.id);
        currentProfile = (p?.profile && Object.keys(p.profile).length > 0) ? p.profile : null;
        history = Array.isArray(p?.history) ? p.history : [];
      } catch (e) {}

      const convo = (trainMessages || [])
        .map(m => `${m.role === 'user' ? 'VENDEDOR' : 'CLIENTE'}: ${m.content}`)
        .join('\n')
        .slice(0, 9000);

      const eventContext = `SESSÃO DE TREINAMENTO (simulação com cliente de IA "${trainConfig?.customerName || ''}", dificuldade ${trainConfig?.difficulty || 'média'}${totalScore !== undefined && totalScore !== null ? `, nota final ${totalScore}` : ''}).
AVALIAÇÃO AUTOMÁTICA DA SESSÃO:
${JSON.stringify({ scores: evalData?.scores, positives: evalData?.positives, improvements: evalData?.improvements, summary: evalData?.summary, languageVices: evalData?.languageVices })}

TRECHO DA CONVERSA:
${convo}`;

      const parsed = await consolidateLearning({
        userName: user.name || 'Vendedor',
        sourceLabel: 'SESSÃO DE TREINAMENTO',
        eventContext,
        currentProfile,
        history,
      });
      if (parsed?.profile) {
        const event = {
          source: 'training',
          summary: parsed.eventSummary || evalData?.summary || null,
          strengths: parsed.eventStrengths || [],
          weaknesses: parsed.eventWeaknesses || [],
          score: (totalScore !== undefined && totalScore !== null) ? totalScore : null,
        };
        await API.saveLiveProfile(user.id, parsed.profile, event);
        console.log('[LiveCoach] dossiê atualizado com o treinamento');
      }
    } catch (e) {
      console.warn('[LiveCoach] learnFromTraining fail', e?.message);
    }
  }

  function renderEnded(summary) {
    const overlay = ensureOverlay();
    const p = profile || {};
    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap">
        <div class="lc-header">
          <div class="lc-title">✅ Chamada encerrada</div>
          <div style="margin-left:auto"><button class="lc-btn lc-btn-primary" onclick="LiveCoach.close()">Concluir</button></div>
        </div>
        <div class="lc-grid">
          <div class="lc-card">
            <div class="lc-card-title">📋 Resumo da chamada</div>
            <p style="font-size:0.9rem;line-height:1.6">${esc(summary || 'Chamada muito curta para gerar análise.')}</p>
            <div class="lc-card-title" style="margin-top:1.25rem">📝 Transcrição (${transcript.length} falas)</div>
            <div class="lc-transcript" style="max-height:38vh">
              ${transcript.map(s => `
                <div class="lc-seg ${s.speaker}">
                  <div class="lc-seg-who">${s.speaker === 'seller' ? '🎤 Você' : '🖥 Cliente'}</div>
                  ${esc(s.text)}
                </div>`).join('') || '<div class="lc-muted">Nenhuma fala transcrita.</div>'}
            </div>
          </div>
          <div class="lc-card">
            <div class="lc-card-title">🧠 Seu perfil atualizado</div>
            ${p.styleSummary ? `
              <p style="font-size:0.85rem;line-height:1.5;margin-bottom:0.75rem">${esc(p.styleSummary)}</p>
              ${(p.strengths || []).length ? `<div class="lc-card-title">💪 Pontos fortes</div>${p.strengths.map(s => `<span class="lc-chip">${esc(s)}</span>`).join('')}` : ''}
              ${(p.weaknesses || []).length ? `<div class="lc-card-title" style="margin-top:0.75rem">🎯 A melhorar</div>${p.weaknesses.map(s => `<span class="lc-chip">${esc(s)}</span>`).join('')}` : ''}
              ${(p.evolutionNotes || []).length ? `<div class="lc-card-title" style="margin-top:0.75rem">📈 Sua evolução</div><ul style="font-size:0.83rem;line-height:1.6;padding-left:1.1rem;color:#7dead0">${p.evolutionNotes.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
              ${(p.recommendations || []).length ? `<div class="lc-card-title" style="margin-top:0.75rem">💡 Recomendações</div><ul style="font-size:0.83rem;line-height:1.6;padding-left:1.1rem">${p.recommendations.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
            ` : '<p class="lc-muted">Perfil ainda não gerado (chamada muito curta).</p>'}
          </div>
        </div>
      </div>`;
  }

  return { open, close, start, stop, toggleMicPause, pip, toggleTheater, toggleSound, toggleProduct, learnFromTraining, enableSurfaceControl, zoomSurface, videoClicked, startAudioMode, startWhatsappMode, renderModeChooser };
})();

window.LiveCoach = LiveCoach;
