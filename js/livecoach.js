// ================================================
// SALESPULSE — Live Coach
// Assistente de IA para chamadas de vendas REAIS
// (Google Meet, Teams, Zoom ou qualquer app no navegador)
//
// Como funciona:
//  - O vendedor compartilha a ABA da reunião (com áudio) + microfone.
//  - Canal do microfone  = fala do VENDEDOR.
//  - Canal do áudio da aba = fala do CLIENTE (outro lado).
//  - Cada canal é transcrito separadamente via Whisper → identificação
//    de quem fala é por canal físico, não por adivinhação de IA.
//  - O vídeo da aba compartilhada é exibido dentro do SalesPulse
//    (com opção de picture-in-picture).
//  - A cada intervalo, a IA analisa o trecho recente e envia dicas
//    (painel + notificação do navegador se a aba estiver em segundo plano).
//  - Ao encerrar, a IA analisa a chamada inteira e ATUALIZA O PERFIL
//    APRENDIDO do vendedor (consolidando com chamadas anteriores).
// ================================================

const LiveCoach = (() => {

  const CHUNK_MS = 8000;           // duração de cada bloco de áudio transcrito
  const COACH_INTERVAL_MS = 20000; // frequência das dicas
  const SAVE_INTERVAL_MS = 12000;  // frequência de persistência no backend
  const RMS_THRESHOLD = 0.025;     // energia mínima para considerar "voz"
  const MIN_VOICED_TICKS = 2;      // ticks de 250ms com voz exigidos por bloco (~0,5s de fala)

  let running = false;
  let callId = null;
  let startedAt = null;
  let micStream = null;
  let displayStream = null;
  let activeRecorders = [];
  let audioCtx = null;
  let voicedInChunk = { seller: 0, client: 0 };  // ticks com voz no bloco atual
  let lastSoundAt = { seller: 0, client: 0 };    // último instante com voz por canal
  let micPaused = false;
  let sharedSurface = null;                       // 'browser' (aba) | 'monitor' | 'window'
  let transcript = [];   // { t, speaker: 'seller'|'client', text }
  let tips = [];         // { t, tip, priority, icon }
  let coachTimer = null;
  let saveTimer = null;
  let clockTimer = null;
  let healthTimer = null;
  let lastCoachedCount = 0;
  let profile = null;    // perfil aprendido (chamadas anteriores)
  let coachBusy = false;

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
        .lc-wrap { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
        .lc-header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .lc-title { font-size: 1.3rem; font-weight: 800; }
        .lc-live-dot { width: 10px; height: 10px; border-radius: 50%; background: #ff4757; animation: lcPulse 1.2s infinite; display: inline-block; margin-right: 6px; }
        @keyframes lcPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .lc-grid { display: grid; grid-template-columns: 1fr 360px; gap: 1.25rem; align-items: start; }
        @media (max-width: 900px) { .lc-grid { grid-template-columns: 1fr; } }
        .lc-card { background: rgba(14,14,26,0.85); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 1.25rem; }
        .lc-card + .lc-card { margin-top: 1.25rem; }
        .lc-card-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: #5a5a7a; margin-bottom: 0.9rem; }
        .lc-video { width: 100%; max-height: 340px; border-radius: 10px; background: #000; display: block; }
        .lc-transcript { max-height: 44vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
        .lc-seg { padding: 8px 12px; border-radius: 10px; font-size: 0.86rem; line-height: 1.45; max-width: 92%; }
        .lc-seg.seller { background: rgba(108,99,255,0.14); border: 1px solid rgba(108,99,255,0.25); align-self: flex-end; }
        .lc-seg.client { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); align-self: flex-start; }
        .lc-seg-who { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
        .lc-seg.seller .lc-seg-who { color: #a8a2ff; }
        .lc-seg.client .lc-seg-who { color: #00d4aa; }
        .lc-tip { padding: 10px 12px; border-radius: 10px; font-size: 0.85rem; line-height: 1.4; margin-bottom: 8px; border: 1px solid; animation: lcTipIn 0.35s ease; }
        @keyframes lcTipIn { from { transform: translateY(-6px); opacity: 0; } to { transform: none; opacity: 1; } }
        .lc-tip.urgent { background: rgba(255,71,87,0.10); border-color: rgba(255,71,87,0.35); }
        .lc-tip.normal { background: rgba(108,99,255,0.10); border-color: rgba(108,99,255,0.30); }
        .lc-tip.good   { background: rgba(46,213,115,0.10); border-color: rgba(46,213,115,0.30); }
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
            <div class="lc-setup-step"><div class="lc-step-num">2</div><div>Clique em <strong>Iniciar</strong> e selecione a <strong>ABA da reunião</strong> (não a tela inteira!), marcando <strong>"Compartilhar áudio da guia"</strong>. Compartilhando a aba, o áudio do cliente é captado direto — mesmo com o som do PC baixo ou mudo.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">3</div><div>Permita o acesso ao <strong>microfone</strong>. Sua fala e a do cliente são identificadas automaticamente por canal.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">4</div><div>Use <strong>fones de ouvido</strong> para o microfone não captar a voz do cliente junto com a sua.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">5</div><div>⚠️ O botão de mudo do Meet/Teams <strong>não silencia o Live Coach</strong> — o coach ouve seu microfone direto. Ao se mutar na reunião, use também o botão <strong>"Pausar minha captura"</strong> aqui.</div></div>
            <div class="lc-setup-step"><div class="lc-step-num">6</div><div>O vídeo da reunião aparece <strong>dentro do SalesPulse</strong>, junto com a transcrição e as dicas. Se preferir ficar na aba da reunião, as dicas chegam como notificações do navegador.</div></div>
          </div>
          <div class="lc-card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1rem">
            <div style="font-size:3rem">🎙</div>
            <p class="lc-muted">Transcrição ao vivo, dicas de venda em tempo real e aprendizado do seu perfil a cada chamada.</p>
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

      // Detecta o tipo de superfície compartilhada (aba = ideal)
      try {
        sharedSurface = displayStream.getVideoTracks()[0]?.getSettings()?.displaySurface || null;
      } catch (e) { sharedSurface = null; }

      setStatus('Agora permita o acesso ao microfone...');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });

      setStatus('Preparando...');
      try { await Notification.requestPermission(); } catch (e) {}

      // Cria a chamada no backend
      const created = await API.createLiveCall();
      callId = created?.id || ('call_' + Date.now());

      // Carrega o perfil aprendido (chamadas anteriores) para personalizar dicas
      const user = Auth.getUser();
      try {
        const p = await API.getLiveProfile(user.id);
        profile = (p && p.profile && Object.keys(p.profile).length > 0) ? p.profile : null;
      } catch (e) { profile = null; }

      // Estado
      running = true;
      startedAt = Date.now();
      transcript = [];
      tips = [];
      lastCoachedCount = 0;
      voicedInChunk = { seller: 0, client: 0 };
      lastSoundAt = { seller: 0, client: 0 };
      micPaused = false;
      activeRecorders = [];

      // Monitor de voz (para pular blocos de silêncio/ruído) + gravação por canal
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const tabAudioStream = new MediaStream(displayStream.getAudioTracks());
      monitorSound(micStream, 'seller');
      monitorSound(tabAudioStream, 'client');
      startChunkLoop(micStream, 'seller');
      startChunkLoop(tabAudioStream, 'client');

      // Se o usuário parar o compartilhamento pela barra do navegador, encerra
      const vTrack = displayStream.getVideoTracks()[0];
      if (vTrack) vTrack.addEventListener('ended', () => { if (running) stop(); });

      // Loops de coach, persistência e saúde do áudio
      coachTimer = setInterval(coachTick, COACH_INTERVAL_MS);
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

  // Conta "ticks" (250ms) com energia de voz — usado para descartar
  // blocos de silêncio/ruído leve (que fazem o Whisper alucinar frases).
  function monitorSound(stream, speaker) {
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!running) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        if (Math.sqrt(sum / data.length) > RMS_THRESHOLD) {
          voicedInChunk[speaker]++;
          lastSoundAt[speaker] = Date.now();
        }
        setTimeout(tick, 250);
      };
      tick();
    } catch (e) { console.warn('[LiveCoach] monitor fail', speaker, e); }
  }

  // Grava em blocos independentes (recorder reiniciado a cada bloco para que
  // cada blob seja um arquivo webm completo e válido para o Whisper).
  function startChunkLoop(stream, speaker) {
    const recordChunk = () => {
      if (!running) return;
      let recorder;
      try { recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' }); }
      catch (e) { recorder = new MediaRecorder(stream); }
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const idx = activeRecorders.indexOf(recorder);
        if (idx >= 0) activeRecorders.splice(idx, 1);
        const voiced = voicedInChunk[speaker];
        voicedInChunk[speaker] = 0;
        const blob = new Blob(chunks, { type: 'audio/webm' });
        // Só transcreve se houve fala sustentada no bloco (>= ~0,5s de voz)
        if (voiced >= MIN_VOICED_TICKS && blob.size > 3000 && !(speaker === 'seller' && micPaused)) {
          transcribeChunk(blob, speaker);
        }
        if (running) recordChunk();
      };
      activeRecorders.push(recorder);
      recorder.start();
      setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, CHUNK_MS);
    };
    recordChunk();
  }

  // Alucinações clássicas do Whisper em trechos de silêncio/ruído
  const JUNK_PATTERNS = [
    'amara.org', 'legendas pela comunidade', 'legendado por', 'transcrito por',
    'obrigado por assistir', 'não se esqueça de se inscrever', 'inscreva-se no canal',
    'se inscreva no canal', 'curta o vídeo', 'deixe seu like', 'até o próximo vídeo',
    'obrigado por acompanhar', 'legenda', '[música]', '[aplausos]', '♪', '♫',
    'tchau, tchau!', 'valeu, falou', 'www.', 'http',
  ];

  function isNoise(text) {
    const lower = text.toLowerCase().trim();
    if (JUNK_PATTERNS.some(j => lower.includes(j))) return true;
    // Sem nenhuma letra/número real (só pontuação, símbolos, reticências)
    if (!/[a-zà-úçãõáéíóúâêôü0-9]/i.test(lower)) return true;
    // Frases genéricas soltas típicas de alucinação em silêncio
    if (['obrigado.', 'obrigada.', 'tchau.', 'tchau!', 'até mais.', 'é...', 'hã?', 'ok.'].includes(lower) ) return true;
    return false;
  }

  async function transcribeChunk(blob, speaker) {
    try {
      const result = await AIEngine.transcribeAudio(blob, { openaiKey: getApiKey() });
      const text = (result?.text || '').trim();
      if (!text || text.length < 3 || isNoise(text)) return;
      // Descarta repetição idêntica consecutiva do mesmo canal (loop de alucinação)
      const lastSame = [...transcript].reverse().find(s => s.speaker === speaker);
      if (lastSame && lastSame.text.toLowerCase() === text.toLowerCase()) return;
      transcript.push({ t: Date.now(), speaker, text });
      renderTranscript();
    } catch (e) {
      console.warn('[LiveCoach] transcribe fail', e?.message);
    }
  }

  // ══════════════════════════════════════
  // MIC PAUSE — espelha o mute da reunião
  // ══════════════════════════════════════
  function toggleMicPause() {
    micPaused = !micPaused;
    if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = !micPaused; });
    if (micPaused) voicedInChunk.seller = 0;
    const btn = document.getElementById('lc-mic-btn');
    if (btn) {
      btn.className = micPaused ? 'lc-btn lc-btn-warning lc-btn-block' : 'lc-btn lc-btn-ghost lc-btn-block';
      btn.innerHTML = micPaused ? '🔇 Captura pausada — clique para retomar' : '🎤 Pausar minha captura (ao se mutar na reunião)';
    }
    renderHealth();
  }

  // ══════════════════════════════════════
  // COACH — dicas em tempo real
  // ══════════════════════════════════════
  async function coachTick() {
    if (!running || coachBusy) return;
    if (transcript.length - lastCoachedCount < 2) return; // pouco material novo
    coachBusy = true;
    const sinceCount = transcript.length;

    try {
      const recent = transcript.slice(-14)
        .map(s => `${s.speaker === 'seller' ? 'VENDEDOR' : 'CLIENTE'}: ${s.text}`)
        .join('\n');

      const profileBlock = profile
        ? `\nPERFIL CONHECIDO DO VENDEDOR (aprendido em chamadas anteriores — personalize a dica com base nele):\n${JSON.stringify(profile)}\n`
        : '';

      const prompt = `Você é um coach de vendas invisível acompanhando uma chamada de vendas REAL em andamento (videochamada). O VENDEDOR é seu aluno; o CLIENTE é a pessoa do outro lado (pode haver mais de uma pessoa no canal do cliente).
${profileBlock}
TRECHO MAIS RECENTE DA CONVERSA:
${recent}

Sua tarefa: dar UMA dica curta, específica e acionável para o vendedor usar AGORA (ou apontar como ele poderia ter falado melhor a última fala dele).
Critérios: exploração de dor antes de pitch, escuta ativa, objeções mal respondidas, sinais de compra ignorados, linguagem fraca/vícios, hora de avançar para próximo passo.
IMPORTANTE: a transcrição pode conter pequenos erros ou trechos soltos — ignore fragmentos sem sentido e só comente sobre o que claramente faz parte da conversa de vendas.
Retorne EXCLUSIVAMENTE JSON: {"tip": "dica com no máximo 18 palavras", "priority": "urgent|normal|good", "icon": "um emoji"}
Se realmente não houver nada útil a dizer agora (ou o material for só fragmentos), retorne {"tip": null}`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getApiKey()}` },
        body: JSON.stringify({
          model: Storage.getConfig().openaiModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 120,
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
      });
      if (!response.ok) return;
      const data = await response.json();
      const parsed = JSON.parse(data.choices[0]?.message?.content || 'null');
      if (parsed && parsed.tip) {
        addTip({ t: Date.now(), tip: parsed.tip, priority: parsed.priority || 'normal', icon: parsed.icon || '🎯' });
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
    // Notificação do navegador quando o vendedor está na aba da reunião
    try {
      if (document.hidden && Notification.permission === 'granted') {
        new Notification('🎧 Live Coach', { body: `${tip.icon} ${tip.tip}`, tag: 'livecoach-tip' });
      }
    } catch (e) {}
  }

  async function persist() {
    if (!callId) return;
    try {
      await API.updateLiveCall(callId, {
        transcript: transcript,
        tips: tips,
      });
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
        <div class="lc-grid">
          <div>
            <div class="lc-card" style="padding:0.9rem">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.6rem">
                <div class="lc-card-title" style="margin:0">🖥 Sua reunião (ao vivo)</div>
                <button class="lc-btn lc-btn-ghost" style="padding:0.35rem 0.9rem;font-size:0.75rem" onclick="LiveCoach.pip()">🗔 Janela flutuante</button>
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
              <div class="lc-card-title">🎛 Controles e áudio</div>
              ${surfaceWarning}
              <button class="lc-btn lc-btn-ghost lc-btn-block" id="lc-mic-btn" onclick="LiveCoach.toggleMicPause()">🎤 Pausar minha captura (ao se mutar na reunião)</button>
              <div style="margin-top:0.75rem" id="lc-health"></div>
            </div>
            <div class="lc-card">
              <div class="lc-card-title">💡 Dicas do Coach</div>
              <div id="lc-tips"><div class="lc-muted">As dicas aparecem aqui conforme a conversa evolui.</div></div>
            </div>
          </div>
        </div>
      </div>`;
    overlay.style.display = 'block';

    // Vídeo da reunião dentro do SalesPulse (mudo para não duplicar o áudio)
    const video = document.getElementById('lc-video');
    if (video && displayStream) {
      video.srcObject = displayStream;
      video.play().catch(() => {});
    }

    clockTimer = setInterval(() => {
      const el = document.getElementById('lc-clock');
      if (el && startedAt) el.textContent = fmtClock(Date.now() - startedAt);
    }, 1000);

    renderHealth();
  }

  // Indicadores de saúde: o coach está ouvindo cada canal?
  function renderHealth() {
    const el = document.getElementById('lc-health');
    if (!el || !running) return;
    const now = Date.now();
    const ago = (t) => t ? Math.round((now - t) / 1000) : null;

    const sellerAgo = ago(lastSoundAt.seller);
    const clientAgo = ago(lastSoundAt.client);

    const sellerDot = micPaused ? 'off' : (sellerAgo !== null && sellerAgo < 10 ? 'on' : 'off');
    const sellerLabel = micPaused
      ? '🎤 Você: captura pausada'
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
  }

  // Picture-in-picture: vídeo da reunião numa janela flutuante sempre visível
  async function pip() {
    const v = document.getElementById('lc-video');
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      try { UI.toast('Picture-in-picture não disponível neste navegador.', 'warning'); } catch (e2) {}
    }
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

  function renderTips() {
    const el = document.getElementById('lc-tips');
    if (!el) return;
    el.innerHTML = tips.map(t => `
      <div class="lc-tip ${t.priority}">
        <strong>${t.icon || '🎯'}</strong> ${esc(t.tip)}
        <div class="lc-muted" style="margin-top:3px">${new Date(t.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `).join('') || '<div class="lc-muted">As dicas aparecem aqui conforme a conversa evolui.</div>';
  }

  // ══════════════════════════════════════
  // STOP — análise final + aprendizado de perfil
  // ══════════════════════════════════════
  function cleanupMedia() {
    activeRecorders.forEach(r => { try { if (r.state !== 'inactive') r.stop(); } catch (e) {} });
    activeRecorders = [];
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

  return { open, close, start, stop, toggleMicPause, pip };
})();

window.LiveCoach = LiveCoach;
