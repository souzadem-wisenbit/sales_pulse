// ================================================
// SALESPULSE — Ditado por voz em QUALQUER campo de texto
// ================================================
// Um microfone flutuante único acompanha o campo que está em foco. Clicou
// (ou Ctrl+M), fala; ao parar, o texto transcrito entra no cursor.
//
// Por que um botão flutuante em vez de um <button> dentro de cada campo:
// injetar markup em dezenas de formulários exigiria envolver cada input num
// wrapper posicionado — quebra CSS existente e some com campos criados
// dinamicamente. O botão flutuante é posicionado por getBoundingClientRect,
// funciona em campo que nasceu agora e não toca no DOM dos formulários.
// ================================================

const VoiceInput = (() => {

  const MAX_MS = 90000;            // trava de segurança: 90s por ditado
  const SILENCE_STOP_MS = 2200;    // para sozinho após esse silêncio
  const MIN_BLOB_BYTES = 1200;     // menor que isso = clique sem fala

  let btn = null;
  let hint = null;
  let target = null;               // campo que receberá o texto
  let recorder = null;
  let chunks = [];
  let stream = null;
  let state = 'idle';              // idle | recording | transcribing
  let maxTimer = null;
  let audioCtx = null;
  let silenceTimer = null;
  let rafId = null;

  // Campos que já têm microfone próprio (não duplicar o controle)
  const SKIP_IDS = new Set(['chat-input']);
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', '']);

  function isEligible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (SKIP_IDS.has(el.id)) return false;
    if (el.dataset && el.dataset.noDictation !== undefined) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase());
    return false;
  }

  function getApiKey() {
    try {
      return (window.Storage && (Storage.getConfig().openaiKey || (Storage.getSettings() || {}).openaiKey)) || null;
    } catch (e) { return null; }
  }

  // ── UI ──

  function ensureUI() {
    if (btn) return;
    const style = document.createElement('style');
    style.textContent = `
      .vi-mic { position: fixed; z-index: 99999; width: 30px; height: 30px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.16); background: rgba(20,20,32,0.92); color: #b9b9d0;
        font-size: 0.85rem; line-height: 1; cursor: pointer; display: none; align-items: center;
        justify-content: center; padding: 0; box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        transition: transform 0.12s ease, background 0.18s ease, color 0.18s ease, opacity 0.18s ease; }
      .vi-mic:hover { transform: scale(1.08); background: rgba(108,99,255,0.9); color: #fff; }
      .vi-mic.vi-rec { background: #ff4757; color: #fff; border-color: rgba(255,71,87,0.7);
        animation: viPulse 1.1s ease-in-out infinite; }
      .vi-mic.vi-busy { background: rgba(108,99,255,0.85); color: #fff; cursor: progress; }
      .vi-mic .vi-spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3);
        border-top-color: #fff; display: block; animation: viSpin 0.7s linear infinite; }
      @keyframes viPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,71,87,0.55); } 50% { box-shadow: 0 0 0 7px rgba(255,71,87,0); } }
      @keyframes viSpin { to { transform: rotate(360deg); } }
      .vi-hint { position: fixed; z-index: 99999; display: none; padding: 5px 10px; border-radius: 8px;
        background: rgba(20,20,32,0.96); border: 1px solid rgba(255,255,255,0.14); color: #e8e8f0;
        font-size: 0.72rem; font-weight: 600; white-space: nowrap; pointer-events: none;
        box-shadow: 0 6px 18px rgba(0,0,0,0.4); font-family: inherit; }
      @media (max-width: 640px) { .vi-mic { width: 34px; height: 34px; } }
    `;
    document.head.appendChild(style);

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vi-mic';
    btn.title = 'Ditar por voz (Ctrl+M)';
    btn.innerHTML = '🎤';
    // mousedown com preventDefault: sem isso o clique tira o foco do campo
    // antes do handler rodar e o texto não teria onde entrar.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
    document.body.appendChild(btn);

    hint = document.createElement('div');
    hint.className = 'vi-hint';
    document.body.appendChild(hint);
  }

  function place() {
    if (!target || !btn) return;
    if (!document.body.contains(target)) { hide(); return; }
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { hide(); return; }
    // Fora da tela (rolagem): esconde para não flutuar solto
    if (r.bottom < 0 || r.top > window.innerHeight) { btn.style.display = 'none'; hint.style.display = 'none'; return; }
    const size = btn.offsetWidth || 30;
    const isArea = (target.tagName || '').toLowerCase() === 'textarea';
    const top = isArea ? r.bottom - size - 6 : r.top + (r.height - size) / 2;
    btn.style.left = `${Math.round(r.right - size - 7)}px`;
    btn.style.top = `${Math.round(top)}px`;
    btn.style.display = 'flex';
    if (state !== 'idle') {
      hint.style.left = `${Math.round(Math.max(8, r.right - size - 7 - hint.offsetWidth - 8))}px`;
      hint.style.top = `${Math.round(top + (size - (hint.offsetHeight || 24)) / 2)}px`;
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }

  function hide() {
    if (state !== 'idle') return; // gravando: mantém visível até terminar
    target = null;
    if (btn) btn.style.display = 'none';
    if (hint) hint.style.display = 'none';
  }

  function setState(next, hintText) {
    state = next;
    if (!btn) return;
    btn.classList.toggle('vi-rec', next === 'recording');
    btn.classList.toggle('vi-busy', next === 'transcribing');
    btn.innerHTML = next === 'transcribing' ? '<span class="vi-spin"></span>' : (next === 'recording' ? '⏹' : '🎤');
    btn.title = next === 'recording' ? 'Parar e transcrever (Esc cancela)' : 'Ditar por voz (Ctrl+M)';
    if (hint) hint.textContent = hintText || '';
    place();
  }

  // ── Gravação ──

  async function start() {
    if (state !== 'idle' || !target) return;
    if (!getApiKey()) {
      window.UI?.toast?.('Configure a chave da OpenAI nas Configurações para usar o ditado.', 'error');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      window.UI?.toast?.('Não consegui acessar o microfone. Verifique a permissão do navegador.', 'error');
      return;
    }
    chunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      stopStream();
      window.UI?.toast?.('Seu navegador não suporta gravação de áudio.', 'error');
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onRecordingStop;
    recorder.start();
    setState('recording', '🎙 Falando... clique para parar');
    maxTimer = setTimeout(stop, MAX_MS);
    watchSilence();
  }

  // Para sozinho quando a pessoa termina de falar — ninguém quer voltar
  // ao mouse para encerrar um ditado.
  function watchSilence() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let spokeOnce = false;
      const tick = () => {
        if (state !== 'recording') return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        const speaking = peak > 6;
        if (speaking) {
          spokeOnce = true;
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        } else if (spokeOnce && !silenceTimer) {
          silenceTimer = setTimeout(stop, SILENCE_STOP_MS);
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } catch (e) { /* sem VAD: o usuário para no clique */ }
  }

  function stop() {
    if (state !== 'recording') return;
    clearTimers();
    setState('transcribing', '✍️ Transcrevendo...');
    try { recorder.stop(); } catch (e) { stopStream(); setState('idle'); }
  }

  function cancel() {
    if (state === 'idle') return;
    clearTimers();
    chunks = [];
    try { recorder?.stop(); } catch (e) {}
    stopStream();
    setState('idle');
  }

  function clearTimers() {
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }

  function stopStream() {
    try { stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
    stream = null;
    recorder = null;
  }

  async function onRecordingStop() {
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    chunks = [];
    stopStream();
    if (!blob || blob.size < MIN_BLOB_BYTES) { setState('idle'); return; }
    try {
      const text = await transcribe(blob);
      if (text) insertText(text);
      else window.UI?.toast?.('Não entendi o áudio. Tente falar mais perto do microfone.', 'warning');
    } catch (e) {
      console.warn('[VoiceInput] transcrição falhou', e?.message);
      window.UI?.toast?.('Falha ao transcrever o áudio. Tente novamente.', 'error');
    }
    setState('idle');
    try { target?.focus(); } catch (e) {}
  }

  async function transcribe(blob) {
    const fd = new FormData();
    fd.append('file', blob, 'ditado.webm');
    fd.append('model', 'gpt-4o-mini-transcribe');
    fd.append('language', 'pt');
    fd.append('temperature', '0');
    // O rótulo do campo entra como contexto: melhora nomes e jargão do domínio
    fd.append('prompt', `Ditado em português do Brasil para o campo "${fieldLabel(target)}" de um sistema de vendas. Transcreva fielmente, com pontuação.`);
    let res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${getApiKey()}` }, body: fd,
    });
    if (!res.ok) {
      // Conta sem acesso ao modelo novo: cai para o whisper-1
      const fd2 = new FormData();
      fd2.append('file', blob, 'ditado.webm');
      fd2.append('model', 'whisper-1');
      fd2.append('language', 'pt');
      res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${getApiKey()}` }, body: fd2,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    }
    const data = await res.json();
    return (data.text || '').trim();
  }

  function fieldLabel(el) {
    if (!el) return '';
    const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
    const label = byFor || el.closest('.form-group')?.querySelector('.form-label, label');
    return (label?.textContent || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  // Insere no cursor, preservando o que já estava escrito, e avisa a
  // aplicação (oninput/onchange) — vários formulários dependem disso.
  function insertText(text) {
    if (!target) return;
    const el = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const needsSpace = before && !/\s$/.test(before) ? ' ' : '';
    const insert = needsSpace + text;
    el.value = before + insert + after;
    const caret = start + insert.length;
    try { el.setSelectionRange(caret, caret); } catch (e) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function toggle() {
    if (state === 'recording') stop();
    else if (state === 'idle') start();
  }

  // ── Ligação com a página ──

  function init() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return; // navegador sem suporte
    ensureUI();

    document.addEventListener('focusin', (e) => {
      if (state !== 'idle') return; // gravando: não troca de campo no meio
      if (e.target === btn) return;
      if (isEligible(e.target)) { target = e.target; place(); }
      else hide();
    });
    document.addEventListener('focusout', (e) => {
      if (state !== 'idle') return;
      // Deixa o clique no próprio botão acontecer antes de sumir
      setTimeout(() => { if (document.activeElement !== target && document.activeElement !== btn) hide(); }, 120);
    });

    // Acompanha rolagem, redimensionamento e mudanças de layout
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    setInterval(() => { if (target) place(); }, 400);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state !== 'idle') { e.preventDefault(); cancel(); return; }
      // Ctrl+M / Cmd+M: dita no campo focado sem tirar a mão do teclado
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
        const el = document.activeElement;
        if (isEligible(el)) { e.preventDefault(); target = el; place(); toggle(); }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { start, stop, cancel, isRecording: () => state === 'recording' };
})();

window.VoiceInput = VoiceInput;
