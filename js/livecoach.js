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
//  - Coach de IA: dica acionável + estágio da venda + temperatura
//    (0-100) a cada intervalo, personalizado pelo perfil aprendido.
//  - Ao encerrar: análise completa + consolidação do perfil do vendedor.
// ================================================

const LiveCoach = (() => {

  const COACH_MIN_GAP_MS = 6000;   // intervalo mínimo entre dicas (anti-spam)
  const COACH_FALLBACK_MS = 10000; // verificação periódica (rede de segurança)
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
  let coachTimer = null;
  let saveTimer = null;
  let clockTimer = null;
  let healthTimer = null;
  let lastCoachedCount = 0;
  let lastCoachAt = 0;
  let tipSoundOn = true;           // aviso sonoro sutil ao chegar dica
  let profile = null;
  let coachBusy = false;
  let transcribeModelOk = true;    // gpt-4o-mini-transcribe disponível?

  const STAGE_LABELS = {
    rapport:      { label: 'Rapport',      icon: '🤝' },
    descoberta:   { label: 'Descoberta',   icon: '🔍' },
    apresentacao: { label: 'Apresentação', icon: '🎯' },
    objecoes:     { label: 'Objeções',     icon: '🛡' },
    fechamento:   { label: 'Fechamento',   icon: '✍️' },
  };

  function getApiKey() {
    return Storage.getConfig().openaiKey || (Storage.getSettings() || {}).openaiKey || null;
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        .lc-wrap { max-width: 1280px; margin: 0 auto; padding: 1.5rem; }
        .lc-header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .lc-title { font-size: 1.3rem; font-weight: 800; }
        .lc-live-dot { width: 10px; height: 10px; border-radius: 50%; background: #ff4757; animation: lcPulse 1.2s infinite; display: inline-block; margin-right: 6px; }
        @keyframes lcPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .lc-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 1.25rem; align-items: start; }
        .lc-grid.lc-theater { grid-template-columns: 1fr; }
        @media (max-width: 900px) { .lc-grid { grid-template-columns: 1fr; } }
        .lc-card { background: rgba(14,14,26,0.85); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.25rem; }
        .lc-card + .lc-card { margin-top: 1.25rem; }
        .lc-card-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #5a5a7a; margin-bottom: 0.9rem; }
        .lc-video { width: 100%; max-height: 56vh; border-radius: 10px; background: #000; display: block; object-fit: contain; }
        .lc-theater .lc-video { max-height: 74vh; }
        .lc-transcript { max-height: 40vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
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
        .lc-hero-body { display: flex; gap: 12px; align-items: flex-start; }
        .lc-hero-icon { font-size: 1.7rem; line-height: 1; flex-shrink: 0; filter: drop-shadow(0 0 8px rgba(255,255,255,0.15)); }
        .lc-hero-text { font-size: 1.04rem; font-weight: 700; line-height: 1.45; color: #f2f2fa; }
        .lc-hero-fresh { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; font-size: 0.7rem; color: #9494b8; }
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

    overlay.innerHTML = `${baseStyles()}
      <div class="lc-wrap">
        <div class="lc-header">
          <button class="lc-btn lc-btn-ghost" onclick="LiveCoach.close()">← Voltar</button>
          <div class="lc-title">🎧 Live Coach — Assistente de Chamadas Reais</div>
        </div>
        <div class="lc-grid">
          <div class="lc-card">
            <div class="lc-card-title">Como funciona</div>
            <div class="lc-setup-step"><div class="lc-step-num">1</div><div>Abra sua reunião (Google Meet, Teams, Zoom Web...) em <strong>outra aba deste navegador</strong>.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">2</div><div>Clique em <strong>Iniciar</strong> e selecione a <strong>ABA da reunião</strong> (não a tela inteira!), marcando <strong>"Compartilhar áudio da guia"</strong>. Assim o áudio do cliente é captado direto — mesmo com o som do PC baixo ou mudo.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">3</div><div>Permita o acesso ao <strong>microfone</strong>. Sua fala e a do cliente são identificadas automaticamente por canal.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">4</div><div>Use <strong>fones de ouvido</strong> para o microfone não captar a voz do cliente junto com a sua.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">5</div><div>Clique em <strong>🗔 Janela flutuante</strong>: uma mini-janela fica por cima de tudo com o vídeo, as dicas ao vivo, a temperatura da negociação e o botão de <strong>mute do coach</strong> — controle total sem sair da reunião.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">6</div><div>⚠️ O mudo do Meet/Teams <strong>não silencia o Live Coach</strong> — use o botão de microfone daqui (na tela ou na janela flutuante).</div></div>
          </div>
          <div class="lc-card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1rem">
            <div style="font-size:3rem">🎙</div>
            <p class="lc-muted">Transcrição ao vivo, dicas em tempo real, temperatura da negociação e aprendizado do seu perfil a cada chamada.</p>
            <button class="lc-btn lc-btn-primary" onclick="LiveCoach.start()" id="lc-start-btn">🚀 Iniciar Live Coach</button>
            <div class="lc-muted" id="lc-start-status"></div>
          </div>
        </div>
      </div>`;
    overlay.style.display = 'block';
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

    try {
      setStatus('Selecione a ABA da reunião e marque "Compartilhar áudio da guia"...');
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

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

      const created = await API.createLiveCall();
      callId = created?.id || ('call_' + Date.now());

      const user = Auth.getUser();
      try {
        const p = await API.getLiveProfile(user.id);
        profile = (p && p.profile && Object.keys(p.profile).length > 0) ? p.profile : null;
      } catch (e) { profile = null; }

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

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const tabAudioStream = new MediaStream(displayStream.getAudioTracks());
      startChannel(micStream, 'seller');
      startChannel(tabAudioStream, 'client');

      const vTrack = displayStream.getVideoTracks()[0];
      if (vTrack) vTrack.addEventListener('ended', () => { if (running) stop(); });

      lastCoachAt = 0;
      coachTimer = setInterval(() => requestCoach('periodic'), COACH_FALLBACK_MS);
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
  function adaptiveHang(speechDur) {
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
        if (silence > adaptiveHang(dur) || dur > MAX_UTTERANCE_MS) {
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

      // Cliente acabou de falar → o vendedor precisa de ajuda AGORA:
      // dispara o coach imediatamente (com cooldown anti-spam).
      if (speaker === 'client') requestCoach('client');
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
  // Disparo reativo: assim que o CLIENTE termina uma fala, o coach é
  // acionado na hora (cooldown de 6s anti-spam). Um timer de 10s cobre
  // os demais casos (ex: avaliar a última fala do vendedor).
  // ══════════════════════════════════════
  async function requestCoach(trigger) {
    if (!running || coachBusy) return;
    if (transcript.length - lastCoachedCount < 1) return;
    if (Date.now() - lastCoachAt < COACH_MIN_GAP_MS) return;
    coachBusy = true;
    lastCoachAt = Date.now();
    const sinceCount = transcript.length;

    try {
      const recent = transcript.slice(-16)
        .map(s => `${s.speaker === 'seller' ? 'VENDEDOR' : 'CLIENTE'}: ${s.text}`)
        .join('\n');

      const profileBlock = profile
        ? `\nPERFIL CONHECIDO DO VENDEDOR (aprendido em chamadas anteriores — personalize a dica com base nele):\n${JSON.stringify(profile)}\n`
        : '';

      const triggerBlock = trigger === 'client'
        ? '\n⚡ O CLIENTE ACABOU DE FALAR e o vendedor vai responder AGORA. Priorize: o que ele deve dizer/fazer nesta resposta imediata (tratar a objeção, aproveitar o sinal de compra, fazer a pergunta certa).\n'
        : '';

      const prompt = `Você é um coach de vendas de elite (formado em SPIN Selling, Challenger e Sandler) acompanhando em silêncio uma chamada de vendas REAL em videochamada. O VENDEDOR é seu aluno; o CLIENTE é o outro lado (pode haver mais de uma pessoa no canal do cliente).
${profileBlock}${triggerBlock}
TRECHO MAIS RECENTE DA CONVERSA (transcrição automática — pode conter pequenos erros; ignore fragmentos sem sentido):
${recent}

Retorne EXCLUSIVAMENTE JSON:
{
  "tip": "UMA dica curta, específica e acionável para o vendedor usar AGORA (máx 18 palavras). null se nada útil.",
  "priority": "urgent|normal|good",
  "icon": "um emoji",
  "stage": "rapport|descoberta|apresentacao|objecoes|fechamento",
  "temperature": <0-100, o quão quente a negociação está: interesse real, sinais de compra, engajamento do cliente>
}

Critérios para a dica: dor explorada antes do pitch? escuta ativa? objeção mal respondida? sinal de compra ignorado? linguagem fraca? hora de avançar? Se o vendedor acabou de mandar bem, use priority "good" e reforce.`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getApiKey()}` },
        body: JSON.stringify({
          model: Storage.getConfig().openaiModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 160,
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) return;
      const data = await response.json();
      const parsed = JSON.parse(data.choices[0]?.message?.content || 'null');
      if (parsed) {
        if (parsed.stage && STAGE_LABELS[parsed.stage]) latestStage = parsed.stage;
        if (typeof parsed.temperature === 'number') latestTemp = Math.max(0, Math.min(100, Math.round(parsed.temperature)));
        renderStage();
        if (parsed.tip) {
          addTip({ t: Date.now(), tip: parsed.tip, priority: parsed.priority || 'normal', icon: parsed.icon || '🎯' });
        }
        updatePip();
      }
      lastCoachedCount = sinceCount;
    } catch (e) {
      console.warn('[LiveCoach] coach fail', e?.message);
    } finally {
      coachBusy = false;
    }
  }

  function addTip(tip) {
    tips.unshift(tip);
    renderTips();
    updatePip();
    playChime(tip.priority);
    try {
      if (document.hidden && Notification.permission === 'granted') {
        new Notification('🎧 Live Coach', { body: `${tip.icon} ${tip.tip}`, tag: 'livecoach-tip' });
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
      <div class="lc-wrap">
        <div class="lc-header">
          <div class="lc-title"><span class="lc-live-dot"></span>Live Coach — Monitorando chamada</div>
          <div class="lc-chip" id="lc-clock">00:00</div>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="lc-btn lc-btn-danger" onclick="LiveCoach.stop()">⏹ Encerrar e Analisar</button>
          </div>
        </div>
        <div class="lc-grid" id="lc-main-grid">
          <div>
            <div class="lc-card" style="padding:0.9rem">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem;gap:8px;flex-wrap:wrap">
                <div class="lc-card-title" style="margin:0">🖥 Sua reunião (ao vivo)</div>
                <div style="display:flex;gap:6px">
                  <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.toggleTheater()" id="lc-theater-btn">⛶ Ampliar</button>
                  <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.pip()">🗔 Janela flutuante</button>
                </div>
              </div>
              <video id="lc-video" class="lc-video" autoplay muted playsinline></video>
            </div>
            <div class="lc-card">
              <div class="lc-card-title">📝 Transcrição ao vivo</div>
              <div class="lc-transcript" id="lc-transcript">
                <div class="lc-muted">Aguardando as primeiras falas...</div>
              </div>
            </div>
          </div>
          <div>
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
            <div class="lc-card">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <div class="lc-card-title" style="margin-bottom:0.9rem">💡 Coach em tempo real</div>
                <button class="lc-sound-btn" id="lc-sound-btn" onclick="LiveCoach.toggleSound()" title="Som de dica ligado">🔔</button>
              </div>
              <div id="lc-tips"><div class="lc-muted">As dicas aparecem aqui conforme a conversa evolui.</div></div>
            </div>
          </div>
        </div>
      </div>`;
    overlay.style.display = 'block';

    const video = document.getElementById('lc-video');
    if (video && displayStream) {
      video.srcObject = displayStream;
      video.play().catch(() => {});
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
        d.getElementById('pip-mic').addEventListener('click', () => toggleMicPause());
        pipWin.addEventListener('pagehide', () => { pipWin = null; });
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
        const box = d.getElementById('pip-tip-box');
        if (box) { box.style.borderColor = theme.border; box.style.background = theme.bg; box.style.boxShadow = `0 0 16px ${theme.bg}`; }
        const lbl = d.getElementById('pip-tip-label');
        if (lbl) { lbl.style.display = 'block'; lbl.textContent = theme.label; lbl.style.background = theme.labelBg; lbl.style.color = theme.labelFg; }
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
    el.innerHTML = `
      <div class="lc-hero ${hero.priority}${(Date.now() - hero.t) > 45000 ? ' stale' : ''}" id="lc-hero">
        <span class="lc-hero-label">${HERO_LABELS[hero.priority] || HERO_LABELS.normal}</span>
        <div class="lc-hero-body">
          <span class="lc-hero-icon">${hero.icon || '🎯'}</span>
          <div class="lc-hero-text">${esc(hero.tip)}</div>
        </div>
        <div class="lc-hero-fresh">
          <span><span class="lc-fresh-dot"></span><span id="lc-tip-fresh">${freshLabel(hero.t)}</span></span>
          <span>${new Date(hero.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      </div>
      ${history.length ? `<div class="lc-hist-divider">Anteriores</div>` : ''}
      ${history.map((t, i) => `
        <div class="lc-hist" style="opacity:${Math.max(0.35, 0.85 - i * 0.12)}">
          <span>${t.icon || '🎯'}</span>
          <span>${esc(t.tip)}</span>
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
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (coachTimer) { clearInterval(coachTimer); coachTimer = null; }
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

        const prompt = `Você é um coach de vendas sênior. Abaixo está a transcrição de uma chamada de vendas REAL do vendedor "${user?.name || 'Vendedor'}". O canal CLIENTE pode conter mais de uma pessoa do lado remoto — se o contexto permitir distinguir, mencione no resumo. A transcrição pode conter pequenos fragmentos com erro — ignore-os.

PERFIL ACUMULADO ATUAL DO VENDEDOR (vazio se primeira análise):
${JSON.stringify(profile || {})}

TRANSCRIÇÃO DA CHAMADA:
${fullText}

Tarefas:
1. Resuma a chamada e o desempenho do vendedor.
2. CONSOLIDE o perfil do vendedor: combine o perfil acumulado com o que esta chamada revela (evolução, padrões recorrentes, vícios que persistem, melhorias).

Retorne EXCLUSIVAMENTE JSON:
{
  "callSummary": "resumo da chamada e do desempenho em 2-4 frases",
  "profile": {
    "styleSummary": "estilo de comunicação e venda do vendedor, consolidado, 2-3 frases",
    "strengths": ["até 5 pontos fortes"],
    "weaknesses": ["até 5 pontos a melhorar"],
    "languageVices": ["vícios de linguagem detectados"],
    "recommendations": ["até 5 dicas personalizadas para as próximas chamadas"]
  }
}`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getApiKey()}` },
          body: JSON.stringify({
            model: Storage.getConfig().openaiModel || 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 900,
            temperature: 0.3,
            response_format: { type: 'json_object' },
          }),
        });
        if (response.ok) {
          const data = await response.json();
          const parsed = JSON.parse(data.choices[0]?.message?.content || '{}');
          summary = parsed.callSummary || null;
          if (parsed.profile) {
            profile = parsed.profile;
            try { await API.saveLiveProfile(user.id, profile); } catch (e) { console.warn('profile save fail', e); }
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
              ${(p.recommendations || []).length ? `<div class="lc-card-title" style="margin-top:0.75rem">💡 Recomendações</div><ul style="font-size:0.83rem;line-height:1.6;padding-left:1.1rem">${p.recommendations.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
            ` : '<p class="lc-muted">Perfil ainda não gerado (chamada muito curta).</p>'}
          </div>
        </div>
      </div>`;
  }

  return { open, close, start, stop, toggleMicPause, pip, toggleTheater, toggleSound };
})();

window.LiveCoach = LiveCoach;
