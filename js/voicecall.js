// ================================================
// SALESPULSE — Voice Call (Treinamento por Voz)
// Ligação em tempo real com o cliente IA via OpenAI
// Realtime (WebRTC): o vendedor fala no microfone e o
// cliente responde com voz humana, turnos e interrupções
// naturais. A avaliação final reusa o pipeline do chat.
// ================================================

const VoiceCall = (() => {

  // ── Estado da chamada ──
  let cfg = null;              // config da sessão (mesma shape do chat)
  let sess = null;             // scheduled session
  let pc = null;               // RTCPeerConnection
  let dc = null;               // data channel de eventos
  let micStream = null;
  let audioEl = null;          // áudio remoto (voz do cliente)
  let running = false;
  let ending = false;
  let micMuted = false;
  let captionsOn = true;

  let transcript = [];         // [{role:'user'|'bot', content}]
  let liveBotText = '';        // legenda em streaming do turno atual do cliente
  let conviction = 0;
  let callStartMs = null;
  let timerInt = null;
  let openingSent = false;
  let apiFlavor = 'ga';        // 'ga' = /v1/realtime/calls | 'beta' = /v1/realtime
  let voiceUsed = 'cedar';
  let isRedial = false;
  let dialSeq = 0;             // época da chamada: teardown() invalida qualquer dial() em andamento

  // Analisador paralelo (convicção / fechamento / dealbreaker)
  let analyzerBusy = false;
  let lastAnalyzeAt = 0;
  const ANALYZE_MIN_GAP_MS = 6000;

  // Tom de chamada (ringback brasileiro: 1s tocando / 4s silêncio, 425Hz)
  let ringCtx = null, ringInt = null;

  // ══════════════════════════════════════
  // ENTRADA — chamada a partir de Seller.startTraining
  // ══════════════════════════════════════
  function start({ session, config }) {
    // Nunca duas ligações: se alguma conexão anterior ainda vive
    // (ex: tela foi re-renderizada por cima da chamada), derruba antes.
    if (isActive()) abort();
    cfg = config;
    sess = session;
    transcript = [];
    liveBotText = '';
    running = false;
    ending = false;
    micMuted = false;
    openingSent = false;
    isRedial = false;

    conviction = { easy: 35, medium: 20, hard: 10, expert: 5 }[cfg.difficulty] || 20;

    // Ligação caiu antes? Restaura a conversa e liga de volta com contexto.
    // (basta haver mensagens salvas — não depende do startedAt ter persistido)
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      transcript = session.messages
        .filter(m => m.role === 'user' || m.role === 'bot')
        .map(m => ({ role: m.role, content: m.content }));
      if (typeof session.conviction === 'number') conviction = session.conviction;
      isRedial = transcript.length > 0;
    }

    renderPreCall();
  }

  // ══════════════════════════════════════
  // TELA PRÉ-CHAMADA
  // ══════════════════════════════════════
  function renderPreCall() {
    const page = document.getElementById('page-seller');
    if (!page) return;

    page.innerHTML = `
      <div class="vc-screen">
        <button class="btn btn-ghost btn-sm vc-back" onclick="VoiceCall.exit()">← Voltar</button>
        <div class="vc-card">
          <div class="vc-avatar-wrap">
            <div class="vc-avatar">${cfg.customerEmoji || '👤'}</div>
          </div>
          <div class="vc-client-name">${esc(cfg.customerName)}</div>
          <div class="vc-client-role">${esc(cfg.customerRole)} — ${esc(cfg.customerCompany)}</div>
          <span class="badge ${{ easy:'badge-success', medium:'badge-teal', hard:'badge-warning', expert:'badge-danger' }[cfg.difficulty] || 'badge-muted'}" style="margin-top:10px">
            ${{ easy:'😊 Fácil', medium:'🤔 Médio', hard:'😤 Difícil', expert:'🔥 Expert' }[cfg.difficulty] || 'Médio'}
          </span>

          <div class="vc-brief">
            <div class="vc-brief-title">🎙️ Sessão de treinamento por voz</div>
            <div class="vc-brief-text">
              ${isRedial
                ? 'A ligação anterior caiu. Ligue de volta — o cliente lembra da conversa até onde vocês pararam.'
                : cfg.salesApproach === 'passive'
                  ? `Este cliente entrou em contato com a sua empresa. <strong>Ele vai ligar para você</strong> — atenda, entenda a dor e conduza a venda por voz.`
                  : `Prospecção ativa: <strong>você liga para o cliente</strong>. Ele não te conhece — apresente-se e conduza a conversa como numa ligação real.`}
            </div>
            <div class="vc-brief-tips">
              <span>🎧 Use fone de ouvido para evitar eco</span>
              <span>🗣️ Fale natural — o cliente ouve, interrompe e responde como uma pessoa</span>
              <span>📴 Para encerrar, despeça-se ou toque no botão vermelho</span>
            </div>
          </div>

          <button class="vc-dial-btn" id="vc-dial-btn" onclick="VoiceCall.dial()">
            📞 ${isRedial ? 'Ligar novamente' : (cfg.salesApproach === 'passive' ? 'Atender chamada' : `Ligar para ${esc(firstName(cfg.customerName))}`)}
          </button>
          <div class="vc-status-line" id="vc-precall-status"></div>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════
  // DISCAR — captura mic + conecta ao Realtime
  // ══════════════════════════════════════
  async function dial() {
    if (running) return;
    const statusEl = document.getElementById('vc-precall-status');
    const btn = document.getElementById('vc-dial-btn');
    const setPre = (t) => { if (statusEl) statusEl.textContent = t; };

    const apiKey = cfg.openaiKey || (Storage.getSettings && Storage.getSettings().openaiKey) || Storage.getConfig().openaiKey;
    if (!apiKey) { setPre('⚠️ Chave da OpenAI não configurada. Avise seu gestor.'); return; }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      setPre('⚠️ Seu navegador não suporta chamadas de voz. Use Chrome ou Edge atualizados.');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '🎤 Liberando microfone...'; }
    // Época desta tentativa: se o usuário sair da tela (exit/navegação)
    // enquanto aguardamos permissão/conexão, o teardown muda a época e
    // esta continuação assíncrona aborta em vez de conectar uma chamada
    // "fantasma" fora da sessão (causa de áudio duplicado/persistente).
    const seq = ++dialSeq;
    let gotStream = null;
    try {
      gotStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (seq !== dialSeq) return;
      if (btn) { btn.disabled = false; btn.textContent = '📞 Tentar novamente'; }
      setPre('⚠️ Microfone bloqueado. Permita o acesso ao microfone e tente de novo.');
      return;
    }
    if (seq !== dialSeq) {
      // Usuário abandonou a tela enquanto o navegador pedia permissão
      try { gotStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      return;
    }
    micStream = gotStream;

    running = true;
    renderInCall();
    setStatus(cfg.salesApproach === 'passive' ? 'Recebendo chamada...' : 'Chamando...', 'ringing');
    startRingback();

    try {
      await connectRealtime(apiKey, seq);
    } catch (e) {
      if (seq !== dialSeq) return;
      console.error('[VoiceCall] connect fail', e);
      stopRingback();
      dropCall('Não foi possível conectar a chamada. ' + friendlyError(e));
      return;
    }
    if (seq !== dialSeq) { teardown(); return; }

    // Marca a sessão como iniciada (uma vez), igual ao fluxo de texto
    if (!sess.startedAt) {
      sess.startedAt = new Date().toISOString();
      try { Storage.updateScheduledSession(sess.id, { startedAt: sess.startedAt }); } catch (e) {}
    }

    callStartMs = Date.now();
    timerInt = setInterval(tickTimer, 1000);
    window.addEventListener('beforeunload', beforeUnloadGuard);
  }

  async function connectRealtime(apiKey, seq) {
    // Nunca deixa uma conexão anterior viva (garantia extra contra áudio duplo)
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (audioEl) { try { audioEl.pause(); audioEl.srcObject = null; } catch (e) {} audioEl = null; }
    pc = new RTCPeerConnection();

    audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    micStream.getAudioTracks().forEach(t => pc.addTrack(t, micStream));

    dc = pc.createDataChannel('oai-events');
    dc.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) {} };
    dc.onopen = () => {
      sendSessionConfig();
      // Se o session.updated não chegar (variações de API), abre a ligação mesmo assim
      setTimeout(() => { if (!openingSent) sendOpeningTurn(); }, 2500);
    };

    pc.onconnectionstatechange = () => {
      if (!running || ending) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        dropCall('A ligação caiu.');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Endpoint GA primeiro; se o modelo/rota não existir na conta, cai para o beta.
    const attempts = [
      { flavor: 'ga',   url: 'https://api.openai.com/v1/realtime/calls?model=gpt-realtime', headers: {} },
      { flavor: 'beta', url: 'https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', headers: { 'OpenAI-Beta': 'realtime=v1' } },
    ];

    let answerSdp = null;
    let lastErr = null;
    for (const att of attempts) {
      try {
        const resp = await fetch(att.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/sdp', ...att.headers },
          body: offer.sdp,
        });
        if (resp.ok) {
          answerSdp = await resp.text();
          apiFlavor = att.flavor;
          break;
        }
        lastErr = new Error(`HTTP_${resp.status}`);
        if (resp.status === 401) throw new Error('API_KEY_INVALID');
      } catch (e) {
        lastErr = e;
        if (e.message === 'API_KEY_INVALID') throw e;
      }
    }
    if (!answerSdp) throw (lastErr || new Error('API_ERROR'));

    voiceUsed = pickVoice(apiFlavor);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  // Voz da ligação, em ordem de prioridade:
  // 1. Voz escolhida pelo gestor no perfil do cliente (cfg.customerVoice);
  // 2. Gênero escolhido no perfil (cfg.customerGender) → melhor voz do gênero;
  // 3. Heurística por nome/emoji (comportamento antigo).
  // O endpoint beta não tem marin/cedar — cai para a voz equivalente.
  function pickVoice(flavor) {
    let v = cfg.customerVoice || null;
    if (!v) {
      const female = cfg.customerGender ? cfg.customerGender === 'female' : guessFemale();
      v = female ? 'marin' : 'cedar';
    }
    if (flavor !== 'ga') {
      if (v === 'marin') v = 'sage';
      if (v === 'cedar') v = 'verse';
    }
    return v;
  }

  function guessFemale() {
    if (cfg.customerGender === 'female') return true;
    if (cfg.customerGender === 'male') return false;
    const femaleEmojis = ['👩', '👧', '👵', '🙍‍♀️', '💁‍♀️', '👩‍💼', '👩‍⚕️', '👩‍🏫', '👩‍🔧', '👩‍🌾', '🧕', '👸'];
    if (cfg.customerEmoji && femaleEmojis.some(e => cfg.customerEmoji.includes(e))) return true;
    const maleEmojis = ['👨', '👦', '👴', '🙍‍♂️', '💁‍♂️', '👨‍💼', '👨‍⚕️', '👨‍🏫', '🤵', '👔'];
    if (cfg.customerEmoji && maleEmojis.some(e => cfg.customerEmoji.includes(e))) return false;
    const first = firstName(cfg.customerName).toLowerCase();
    return first.endsWith('a') && !['juca', 'luca', 'costa', 'nokia'].includes(first);
  }

  function sendSessionConfig() {
    const instructions = buildCallInstructions();
    let payload;
    if (apiFlavor === 'ga') {
      payload = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'pt' },
              turn_detection: { type: 'semantic_vad', eagerness: 'medium' },
            },
            output: { voice: voiceUsed },
          },
        },
      };
    } else {
      payload = {
        type: 'session.update',
        session: {
          instructions,
          voice: voiceUsed,
          modalities: ['text', 'audio'],
          input_audio_transcription: { model: 'whisper-1', language: 'pt' },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 650 },
        },
      };
    }
    sendEvent(payload);
  }

  function buildCallInstructions() {
    let extra = '';
    if (isRedial && transcript.length > 0) {
      const recap = transcript.slice(-10)
        .map(t => `${t.role === 'user' ? 'VENDEDOR' : 'VOCÊ'}: ${t.content}`)
        .join('\n');
      extra = `\n\nCONTEXTO: vocês JÁ ESTAVAM conversando nesta negociação e A LIGAÇÃO CAIU. O vendedor ligou de volta. Últimas falas REAIS antes da queda:\n${recap}\nContinue a conversa exatamente de onde parou — não se reapresente, não recomece do zero. PROIBIDO alegar que estavam falando de um assunto que não aparece nas falas acima; se não souber, pergunte onde tinham parado.`;
    }
    return AIEngine.buildVoiceInstructions(cfg) + extra;
  }

  function sendOpeningTurn() {
    if (openingSent || !dc || dc.readyState !== 'open') return;
    openingSent = true;

    let opening = '';
    const prodNames = [
      ...((cfg.products || []).map(p => p.name)),
      ...(cfg.productName && !(cfg.products || []).some(p => p.name === cfg.productName) ? [cfg.productName] : []),
    ].filter(Boolean).join(', ');
    if (isRedial) {
      // O recap REAL vai dentro da instrução de abertura: sem ele o modelo
      // "lembrava" de um assunto inventado (ex: condições de pagamento).
      const recap = transcript.slice(-8)
        .map(t => `${t.role === 'user' ? 'VENDEDOR' : 'VOCÊ'}: ${t.content}`)
        .join('\n');
      opening = `A ligação caiu há pouco e o vendedor acabou de ligar de volta. Atenda de forma natural e curta, comentando a queda ("oi, caiu aqui", "agora sim, te ouço").
${recap ? `ÚLTIMAS FALAS REAIS ANTES DA QUEDA (sua memória do assunto — use SOMENTE isso):\n${recap}\n` : ''}
REGRA CRÍTICA: é PROIBIDO afirmar que vocês estavam falando de um assunto que NÃO aparece nas falas acima (ex: não diga "a gente tava vendo as condições de pagamento" se isso não estiver lá). ${recap ? 'Retome EXATAMENTE do ponto das últimas falas.' : 'Se você não tem registro do assunto, apenas atenda e deixe o vendedor retomar — ou pergunte "onde a gente tinha parado mesmo?".'}`;
    } else if (cfg.salesApproach === 'passive') {
      opening = `Foi VOCÊ que ligou para o vendedor. Ele acabou de atender. Cumprimente e explique em 1-2 frases faladas por que você está ligando, no estilo do seu perfil.${prodNames ? ` O motivo da sua ligação é OBRIGATORIAMENTE uma dor/necessidade real do seu negócio ligada a: ${prodNames}. Não mencione nenhum outro tipo de produto ou interesse.` : ' O motivo é a dor/necessidade do seu perfil.'} Você é o CLIENTE com uma dor — NUNCA pergunte o que ELE precisa entender nem ofereça explicar como o produto funciona; é ELE quem explica para você. Depois espere a resposta dele.`;
    } else {
      opening = 'Seu telefone tocou: número desconhecido (é um vendedor, mas você ainda não sabe). Atenda como você atenderia no trabalho: curto e neutro, tipo "Alô?" ou "Pois não?". NÃO se apresente com nome completo, NÃO pergunte "como posso ajudar". Só atenda e espere a pessoa falar.';
    }
    // A primeira fala define o tom da ligação inteira: o comportamento escrito
    // pelo gestor vai junto da instrução de abertura, não só nas instruções da
    // sessão (onde competia com o resto e saía uma versão amenizada).
    const persona = AIEngine.behaviorReminder?.(cfg);
    if (persona?.content) opening += `\n\n${persona.content}`;
    sendEvent({ type: 'response.create', response: { instructions: opening } });
  }

  function sendEvent(obj) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  // ══════════════════════════════════════
  // EVENTOS DO REALTIME
  // ══════════════════════════════════════
  function handleEvent(evt) {
    switch (evt.type) {
      case 'session.created':
        break;

      case 'session.updated':
        if (!openingSent) sendOpeningTurn();
        break;

      // Cliente começou a falar (áudio chegando)
      case 'output_audio_buffer.started':
        stopRingback();
        setStatus('Na linha', 'live');
        setSpeaking(true);
        break;

      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        setSpeaking(false);
        break;

      // Vendedor falando (VAD do servidor)
      case 'input_audio_buffer.speech_started':
        setSellerTalking(true);
        break;
      case 'input_audio_buffer.speech_stopped':
        setSellerTalking(false);
        break;

      // Transcrição do que o VENDEDOR falou
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (evt.transcript || '').trim();
        if (text) {
          transcript.push({ role: 'user', content: text });
          renderCaptions();
          persistState(); // fala do vendedor também entra no histórico salvo (recap fiel após queda)
        }
        break;
      }

      // Legenda em streaming da fala do CLIENTE
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        stopRingback();
        setStatus('Na linha', 'live');
        liveBotText += evt.delta || '';
        renderCaptions();
        break;

      // Turno do CLIENTE concluído
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = (evt.transcript || liveBotText || '').trim();
        liveBotText = '';
        if (text) {
          transcript.push({ role: 'bot', content: text });
          renderCaptions();
          persistState();
          analyzeCall();
        }
        break;
      }

      case 'error':
        console.warn('[VoiceCall] realtime error', evt.error || evt);
        break;
    }
  }

  // ══════════════════════════════════════
  // ANALISADOR PARALELO — convicção + fechamento
  // (tags de metadado não existem em voz; um modelo
  // barato observa a transcrição e devolve o estado)
  // ══════════════════════════════════════
  async function analyzeCall() {
    if (analyzerBusy || ending || transcript.length < 2) return;
    if (Date.now() - lastAnalyzeAt < ANALYZE_MIN_GAP_MS) return;
    analyzerBusy = true;
    lastAnalyzeAt = Date.now();

    const apiKey = cfg.openaiKey || (Storage.getSettings && Storage.getSettings().openaiKey) || Storage.getConfig().openaiKey;
    if (!apiKey) { analyzerBusy = false; return; }

    const recent = transcript.slice(-14)
      .map(t => `${t.role === 'user' ? 'VENDEDOR' : 'CLIENTE'}: ${t.content}`)
      .join('\n');

    const prompt = `Você observa uma LIGAÇÃO de treinamento de vendas. O CLIENTE é ${cfg.customerName} (dificuldade: ${cfg.difficulty}; convicção atual estimada: ${conviction}).
Analise a transcrição recente e retorne o estado ATUAL da negociação.

REGRAS:
- "closed" SÓ é true se o preço/valor foi negociado e o cliente aceitou a proposta financeira final (agendar reunião/demo NÃO é fechar).
- "noInterest" só é true se o cliente encerrou DEFINITIVAMENTE a conversa/negociação.
- "dealbreaker" só é true se o vendedor ofendeu o cliente ou feriu um limite grave.

TRANSCRIÇÃO RECENTE:
${recent}

Retorne EXCLUSIVAMENTE JSON: {"conviction": <0-100>, "closed": <bool>, "noInterest": <bool>, "dealbreaker": <bool>}`;

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.openaiModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 60,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const parsed = JSON.parse(data.choices[0]?.message?.content || 'null');
        if (parsed && !ending) {
          if (typeof parsed.conviction === 'number') {
            conviction = Math.max(0, Math.min(100, Math.round(parsed.conviction)));
            renderMeter();
          }
          if (parsed.dealbreaker) {
            conviction = 0; renderMeter();
            finishCall('💔 O cliente se sentiu ofendido e encerrou a ligação.');
          } else if (parsed.closed) {
            conviction = 100; renderMeter();
            finishCall('🎉 Parabéns! O cliente fechou negócio na ligação!');
          } else if (parsed.noInterest) {
            conviction = 0; renderMeter();
            finishCall('💔 O cliente perdeu o interesse e encerrou a negociação.');
          }
        }
      }
    } catch (e) { /* análise é best-effort, nunca derruba a chamada */ }
    analyzerBusy = false;
  }

  // ══════════════════════════════════════
  // TELA DA CHAMADA
  // ══════════════════════════════════════
  function renderInCall() {
    const page = document.getElementById('page-seller');
    if (!page) return;

    page.innerHTML = `
      <div class="vc-screen vc-screen-live">
        <div class="vc-topbar">
          <div class="vc-status" id="vc-status"><span class="vc-status-dot"></span><span id="vc-status-text">Conectando...</span></div>
          <div class="vc-timer" id="vc-timer">00:00</div>
          ${cfg._showRealtime !== false ? `
            <div class="vc-meter" id="vc-meter" title="Interesse do cliente">
              <span class="vc-meter-label">Interesse</span>
              <div class="vc-meter-bar"><div class="vc-meter-fill" id="vc-meter-fill" style="width:${conviction}%"></div></div>
              <span class="vc-meter-value" id="vc-meter-value">${conviction}%</span>
            </div>` : ''}
        </div>

        <div class="vc-stage">
          <div class="vc-avatar-wrap" id="vc-avatar-wrap">
            <div class="vc-ring vc-ring-1"></div>
            <div class="vc-ring vc-ring-2"></div>
            <div class="vc-avatar">${cfg.customerEmoji || '👤'}</div>
          </div>
          <div class="vc-client-name">${esc(cfg.customerName)}</div>
          <div class="vc-client-role">${esc(cfg.customerRole)} — ${esc(cfg.customerCompany)}</div>
          <div class="vc-you-talking" id="vc-you-talking">🎙️ Você está falando...</div>
        </div>

        <div class="vc-captions" id="vc-captions" style="${captionsOn ? '' : 'display:none'}"></div>
        <div class="vc-banner" id="vc-banner" style="display:none"></div>

        <div class="vc-controls">
          <button class="vc-ctrl" id="vc-mute-btn" onclick="VoiceCall.toggleMute()" title="Silenciar microfone">🎤<span>Mudo</span></button>
          <button class="vc-ctrl vc-ctrl-end" onclick="VoiceCall.hangup()" title="Encerrar chamada">📵<span>Encerrar</span></button>
          <button class="vc-ctrl" id="vc-cap-btn" onclick="VoiceCall.toggleCaptions()" title="Legendas">💬<span>Legendas</span></button>
        </div>
      </div>`;
    renderCaptions();
  }

  function setStatus(text, mode) {
    const t = document.getElementById('vc-status-text');
    if (t) t.textContent = text;
    const box = document.getElementById('vc-status');
    if (box) box.className = 'vc-status' + (mode === 'live' ? ' vc-status-live' : '');
  }

  function setSpeaking(on) {
    document.getElementById('vc-avatar-wrap')?.classList.toggle('vc-speaking', !!on);
  }

  function setSellerTalking(on) {
    const el = document.getElementById('vc-you-talking');
    if (el) el.style.opacity = on ? '1' : '0';
  }

  function renderMeter() {
    const fill = document.getElementById('vc-meter-fill');
    const val = document.getElementById('vc-meter-value');
    if (fill) {
      fill.style.width = conviction + '%';
      fill.style.background = conviction >= 65 ? 'var(--success)' : conviction >= 35 ? 'var(--warning)' : 'var(--danger)';
    }
    if (val) val.textContent = conviction + '%';
  }

  function renderCaptions() {
    const box = document.getElementById('vc-captions');
    if (!box) return;
    const lines = transcript.slice(-4).map(t =>
      `<div class="vc-cap-line ${t.role === 'user' ? 'vc-cap-user' : ''}"><strong>${t.role === 'user' ? 'Você' : esc(firstName(cfg.customerName))}:</strong> ${esc(t.content)}</div>`
    );
    if (liveBotText) {
      lines.push(`<div class="vc-cap-line vc-cap-live"><strong>${esc(firstName(cfg.customerName))}:</strong> ${esc(liveBotText)}</div>`);
    }
    box.innerHTML = lines.join('') || '<div class="vc-cap-line vc-cap-empty">As legendas da conversa aparecem aqui.</div>';
    box.scrollTop = box.scrollHeight;
  }

  function showBanner(text) {
    const b = document.getElementById('vc-banner');
    if (b) { b.textContent = text; b.style.display = ''; }
  }

  function tickTimer() {
    if (!callStartMs) return;
    const secs = Math.floor((Date.now() - callStartMs) / 1000);
    const el = document.getElementById('vc-timer');
    if (el) el.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

    const maxSec = (cfg.maxMinutes || 30) * 60;
    if (secs === maxSec - 60) showBanner('⏳ Falta 1 minuto para o fim do tempo da sessão.');
    if (secs >= maxSec) finishCall('⏱ Tempo máximo da sessão atingido.');
  }

  // ══════════════════════════════════════
  // CONTROLES
  // ══════════════════════════════════════
  function toggleMute() {
    micMuted = !micMuted;
    if (micStream) micStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    const btn = document.getElementById('vc-mute-btn');
    if (btn) {
      btn.classList.toggle('vc-ctrl-active', micMuted);
      btn.innerHTML = micMuted ? '🔇<span>Mudo</span>' : '🎤<span>Mudo</span>';
    }
  }

  function toggleCaptions() {
    captionsOn = !captionsOn;
    const box = document.getElementById('vc-captions');
    if (box) box.style.display = captionsOn ? '' : 'none';
    document.getElementById('vc-cap-btn')?.classList.toggle('vc-ctrl-active', !captionsOn);
  }

  // Encerrar manualmente (botão vermelho)
  function hangup() {
    if (ending) return;
    if (transcript.length < 2) {
      // Quase nada aconteceu — sai sem pontuar, sessão continua pendente
      teardown();
      persistState();
      App.navigate('seller');
      try { UI.toast('Chamada encerrada sem avaliação (conversa muito curta).', 'info'); } catch (e) {}
      return;
    }
    finishCall(null);
  }

  // Fim de chamada com avaliação (fechou, perdeu, tempo, ou manual)
  function finishCall(bannerText) {
    if (ending) return;
    ending = true;
    if (bannerText) showBanner(bannerText);
    persistState();
    // Fecha a sessão agendada na hora (venda fechada, dealbreaker, desinteresse
    // ou encerramento manual): ela some das sessões abertas e não reabre,
    // mesmo que a avaliação falhe depois.
    try {
      if (sess?.id) Storage.updateScheduledSession(sess.id, { status: 'done', doneAt: new Date().toISOString() });
    } catch (e) {}
    const durationSeconds = callStartMs ? Math.floor((Date.now() - callStartMs) / 1000) : 0;

    setTimeout(() => {
      teardown();
      renderAnalyzing();
      Seller.completeVoiceSession({
        config: cfg,
        messages: transcript.map(t => ({ role: t.role, content: t.content })),
        conviction,
        durationSeconds,
      });
    }, bannerText ? 2200 : 300);
  }

  // Queda de conexão — oferece rediscar (com contexto) ou avaliar o que já foi falado
  function dropCall(reason) {
    if (ending || !running) return;
    teardown();
    persistState();
    const page = document.getElementById('page-seller');
    if (!page) return;
    page.innerHTML = `
      <div class="vc-screen">
        <div class="vc-card">
          <div style="font-size:2.6rem;margin-bottom:0.5rem">📵</div>
          <div class="vc-client-name">${esc(reason || 'A ligação caiu.')}</div>
          <div class="vc-brief-text" style="margin-top:8px">${transcript.length >= 2 ? 'Você pode ligar de volta — o cliente lembra da conversa — ou encerrar e receber a avaliação do que já foi falado.' : 'Você pode tentar ligar novamente.'}</div>
          <div style="display:flex;gap:10px;margin-top:1.2rem;flex-wrap:wrap;justify-content:center">
            <button class="vc-dial-btn" style="margin-top:0" onclick="VoiceCall.redial()">📞 Ligar novamente</button>
            ${transcript.length >= 2 ? `<button class="btn btn-ghost" onclick="VoiceCall.finishAfterDrop()">📊 Encerrar e avaliar</button>` : `<button class="btn btn-ghost" onclick="VoiceCall.exit()">← Voltar</button>`}
          </div>
        </div>
      </div>`;
  }

  function redial() {
    sess.messages = transcript.map(t => ({ role: t.role, content: t.content }));
    sess.conviction = conviction;
    start({ session: sess, config: cfg });
    dial();
  }

  function finishAfterDrop() {
    renderAnalyzing();
    Seller.completeVoiceSession({
      config: cfg,
      messages: transcript.map(t => ({ role: t.role, content: t.content })),
      conviction,
      durationSeconds: 0,
    });
  }

  function renderAnalyzing() {
    const page = document.getElementById('page-seller');
    if (!page) return;
    page.innerHTML = `
      <div class="vc-screen">
        <div class="vc-card">
          <div style="font-size:2.6rem;margin-bottom:0.75rem">🧠</div>
          <div class="vc-client-name">Analisando a ligação...</div>
          <div class="vc-brief-text" style="margin-top:8px">A IA está avaliando sua performance de voz e calculando a pontuação.</div>
        </div>
      </div>`;
  }

  function exit() {
    teardown();
    App.navigate('seller');
  }

  // Há chamada (ou conexão) viva? Usado pelo roteador para nunca deixar
  // áudio tocando fora da tela da sessão.
  function isActive() {
    return running || !!pc || !!micStream;
  }

  // Derruba a chamada silenciosamente (navegação/logout no meio da ligação):
  // salva o progresso para permitir religar e libera microfone/áudio.
  function abort() {
    if (!isActive()) return;
    try { persistState(); } catch (e) {}
    ending = false;
    teardown();
  }

  // ══════════════════════════════════════
  // INFRA
  // ══════════════════════════════════════
  function persistState() {
    if (!sess?.id) return;
    try {
      Storage.updateScheduledSession(sess.id, {
        messages: transcript.map(t => ({ role: t.role, content: t.content })),
        conviction,
        tricks: 0,
        criteriaScores: null,
      });
    } catch (e) {}
  }

  function teardown() {
    running = false;
    dialSeq++; // invalida qualquer dial()/connect em andamento
    stopRingback();
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    window.removeEventListener('beforeunload', beforeUnloadGuard);
    try { dc?.close(); } catch (e) {}
    try { pc?.close(); } catch (e) {}
    try { micStream?.getTracks().forEach(t => t.stop()); } catch (e) {}
    if (audioEl) { try { audioEl.pause(); audioEl.srcObject = null; } catch (e) {} }
    pc = null; dc = null; micStream = null; audioEl = null;
  }

  function beforeUnloadGuard(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  // Ringback 425Hz — cadência brasileira 1s tocando / 4s silêncio
  function startRingback() {
    try {
      stopRingback();
      ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        if (!ringCtx) return;
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.frequency.value = 425;
        gain.gain.value = 0.06;
        osc.connect(gain); gain.connect(ringCtx.destination);
        osc.start();
        osc.stop(ringCtx.currentTime + 1.0);
      };
      beep();
      ringInt = setInterval(beep, 5000);
      // Nunca toca por mais de 20s (a essa altura ou conectou ou caiu)
      setTimeout(stopRingback, 20000);
    } catch (e) {}
  }

  function stopRingback() {
    if (ringInt) { clearInterval(ringInt); ringInt = null; }
    if (ringCtx) { try { ringCtx.close(); } catch (e) {} ringCtx = null; }
  }

  function friendlyError(e) {
    const m = e?.message || String(e);
    if (m === 'API_KEY_INVALID') return 'Chave da OpenAI inválida — avise seu gestor.';
    if (m.startsWith('HTTP_4')) return 'A conta OpenAI configurada não tem acesso ao modo de voz em tempo real.';
    return 'Verifique sua internet e tente novamente.';
  }

  function firstName(n) { return String(n || '').split(' ')[0]; }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { start, dial, hangup, toggleMute, toggleCaptions, redial, finishAfterDrop, exit, isActive, abort };
})();

window.VoiceCall = VoiceCall;
