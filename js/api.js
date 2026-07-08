// ================================================
// SALESPULSE — API Client (Single-Tenant)
// Handles backend communication.
// Falls back gracefully if backend is not reachable.
// ================================================

const API = (() => {
  const TIMEOUT_MS = 60000;
  const MAX_RETRIES = 2;

  // A URL base é configurável. Se vazia, usa rotas relativas (Vercel/mesmo domínio).
  // Se null, o backend é desabilitado e tudo usa localStorage.
  // Auto-detect: on Azure use relative URLs (same origin), otherwise try local dev server
  let _backendUrl = (() => {
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3001'; 
      }
      return ''; // Use relative URLs for Azure, Ngrok, and everything else
    }
    return null; // fallback: backend disabled
  })();

  function configure(url) {
    _backendUrl = url;
  }

  function getBaseUrl() {
    return _backendUrl;
  }

  function isBackendEnabled() {
    return _backendUrl !== null;
  }

  function getToken() {
    try { return JSON.parse(localStorage.getItem('sbp_auth'))?.token || null; }
    catch { return null; }
  }

  function buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return res;
    } catch (err) {
      clearTimeout(id);
      if (err.name === 'AbortError') throw new Error('TIMEOUT');
      throw err;
    }
  }

  async function post(path, body, retries = MAX_RETRIES) {
    const base = getBaseUrl();
    if (base === null) return null;

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (res.status === 401) throw new Error('AUTH_ERROR');
          if (res.status === 429) throw new Error('RATE_LIMIT');
          throw new Error(err.message || err.error || `HTTP_${res.status}`);
        }

        return await res.json();
      } catch (err) {
        lastError = err;
        if (['AUTH_ERROR', 'RATE_LIMIT'].includes(err.message)) break;
        if (attempt < retries) await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError;
  }

  // Acrescenta um parâmetro único para forçar o navegador a buscar dados
  // frescos em toda requisição GET (impede cache de listas desatualizadas).
  function cacheBust(path) {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}_=${Date.now()}`;
  }

  async function get(path) {
    const base = getBaseUrl();
    if (base === null) return null;
    const res = await fetchWithTimeout(`${base}${cacheBust(path)}`, {
      method: 'GET',
      headers: buildHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('AUTH_ERROR');
      throw new Error(err.message || err.error || `HTTP_${res.status}`);
    }
    return await res.json();
  }

  async function put(path, body) {
    const base = getBaseUrl();
    if (base === null) return null;
    const res = await fetchWithTimeout(`${base}${path}`, {
      method: 'PUT',
      headers: buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('AUTH_ERROR');
      throw new Error(err.message || err.error || `HTTP_${res.status}`);
    }
    return await res.json();
  }

  async function del(path) {
    const base = getBaseUrl();
    if (base === null) return null;
    const res = await fetchWithTimeout(`${base}${path}`, {
      method: 'DELETE',
      headers: buildHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('AUTH_ERROR');
      throw new Error(err.message || err.error || `HTTP_${res.status}`);
    }
    if (res.status === 204) return null;
    return await res.json();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── API Methods ──────────────────────────────────

  async function login(email, password) {
    if (!isBackendEnabled()) return null;
    const data = await post('/api/auth/login', { email, password }, 0);
    if (data && data.token) {
      const auth = Storage.getAuth() || {};
      Storage.setAuth({ ...auth, token: data.token });
    }
    return data;
  }

  // User Management
  async function listUsers() {
    if (!isBackendEnabled()) return null;
    return await get('/api/users');
  }

  async function createUser({ name, email, password, role, avatar_emoji }) {
    if (!isBackendEnabled()) return null;
    return await post('/api/users', { name, email, password, role: role || 'seller', avatar_emoji: avatar_emoji || '👤' }, 0);
  }

  async function updateUser(id, data) {
    if (!isBackendEnabled()) return null;
    return await put(`/api/users/${id}`, data);
  }

  async function deleteUser(id) {
    if (!isBackendEnabled()) return null;
    return await del(`/api/users/${id}`);
  }

  // Session & AI
  async function startSession({ userId, config, systemPrompt }) {
    if (!isBackendEnabled()) return null;
    return await post('/api/sessions', {
      user_id:       userId,
      config:        sanitizeConfig(config),
      system_prompt: systemPrompt,
    });
  }

  async function sendMessage({ sessionId, messages, systemPrompt, config }) {
    if (!isBackendEnabled()) return null;
    return await post(`/api/sessions/${sessionId}/message`, {
      messages:      messages.map(m => ({ role: m.role, content: m.content })),
      system_prompt: systemPrompt,
      config:        sanitizeConfig(config),
    });
  }

  async function endSession(sessionId, finalData) {
    if (!isBackendEnabled()) return null;
    return await put(`/api/sessions/${sessionId}/end`, finalData);
  }

  async function evaluateSession(sessionId, evaluationData) {
    if (!isBackendEnabled()) return null;
    return await post(`/api/sessions/${sessionId}/evaluate`, evaluationData);
  }

  async function getCoachTip(sessionId, messages, systemPrompt) {
    if (!isBackendEnabled()) return null;
    return await post(`/api/sessions/${sessionId}/coach`, { messages, system_prompt: systemPrompt });
  }

  async function transcribeAudio(formData) {
    if (!isBackendEnabled()) return null;
    const base = getBaseUrl();
    const res = await fetchWithTimeout(`${base}/api/sessions/transcribe`, {
      method: 'POST',
      headers: buildHeaders(), // Não usar 'Content-Type': 'application/json' pois é FormData
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Erro na transcrição de áudio');
    }
    return await res.json();
  }

  function sanitizeConfig(config) {
    const copy = { ...config };
    delete copy.openaiKey;
    return copy;
  }

  // Generic request for direct fetch calls
  async function request(path, options = {}) {
    const base = getBaseUrl();
    if (base === null) throw new Error('Backend não configurado');
    const method = (options.method || 'GET').toUpperCase();
    const url = method === 'GET' ? cacheBust(path) : path;
    const res = await fetchWithTimeout(`${base}${url}`, {
      ...options,
      cache: method === 'GET' ? 'no-store' : (options.cache || 'default'),
      headers: { ...buildHeaders(), ...(options.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || err.message || `HTTP_${res.status}`);
    }
    if (res.status === 204) return null;
    return await res.json();
  }

  // Client Management
  async function listClients() { return await get('/api/clients'); }
  async function createClient(data) { return await post('/api/clients', data, 0); }
  async function updateClient(id, data) { return await put(`/api/clients/${id}`, data); }
  async function deleteClient(id) { return await del(`/api/clients/${id}`); }

  // Product Management
  async function listProducts() { return await get('/api/products'); }
  async function createProduct(data) { return await post('/api/products', data, 0); }
  async function updateProduct(id, data) { return await put(`/api/products/${id}`, data); }
  async function deleteProduct(id) { return await del(`/api/products/${id}`); }

  // Scheduled Sessions
  async function listScheduledSessions() { return await get('/api/scheduled_sessions'); }
  async function createScheduledSession(data) { return await post('/api/scheduled_sessions', data, 0); }
  async function updateScheduledSession(id, data) { return await put(`/api/scheduled_sessions/${id}`, data); }
  async function deleteScheduledSession(id) { return await del(`/api/scheduled_sessions/${id}`); }

  // Live Coach (chamadas reais)
  async function createLiveCall(briefing) { return await post('/api/live_calls', { briefing: briefing || {} }, 0); }
  async function updateLiveCall(id, data) { return await put(`/api/live_calls/${id}`, data); }
  async function listLiveCalls() { return await get('/api/live_calls'); }
  async function getLiveCall(id) { return await get(`/api/live_calls/${id}`); }
  async function listLiveProfiles() { return await get('/api/live_profiles'); }
  async function getLiveProfile(userId) { return await get(`/api/live_profiles/${userId}`); }
  async function saveLiveProfile(userId, profile) { return await put(`/api/live_profiles/${userId}`, { profile }); }
  async function assignCoach(userId, coachId) { return await put(`/api/live_profiles/${userId}/coach`, { coachId }); }

  // AI Settings (OpenAI key shared across all devices/users via backend)
  async function getAiSettings() {
    if (!isBackendEnabled()) return null;
    return await get('/api/sync');
  }

  async function saveAiSettings(openaiKey, openaiModel) {
    if (!isBackendEnabled()) return null;
    return await post('/api/sync', { openaiKey, openaiModel }, 0);
  }

  // Pulls the shared OpenAI key/model from the backend into local storage,
  // so sellers logging in on a different browser than the manager still get it.
  async function syncDown() {
    if (!isBackendEnabled()) return;
    try {
      const data = await getAiSettings();
      if (data && (data.openaiKey || data.openaiModel)) {
        const config = Storage.getConfig();
        const settings = Storage.getSettings();
        const openaiKey = data.openaiKey || config.openaiKey || settings.openaiKey;
        const openaiModel = data.openaiModel || config.openaiModel || settings.openaiModel;
        Storage.setConfig({ ...config, openaiKey, openaiModel });
        Storage.setSettings({ ...settings, openaiKey, openaiModel });
      }
    } catch (e) {
      console.warn('[API] syncDown failed', e);
    }
  }

  return {
    configure,
    isBackendEnabled,
    request,
    login,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    startSession,
    sendMessage,
    endSession,
    evaluateSession,
    getCoachTip,
    transcribeAudio,
    listClients,
    createClient,
    updateClient,
    deleteClient,
    listProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    listScheduledSessions,
    createScheduledSession,
    updateScheduledSession,
    deleteScheduledSession,
    getAiSettings,
    saveAiSettings,
    syncDown,
    createLiveCall,
    updateLiveCall,
    listLiveCalls,
    getLiveCall,
    listLiveProfiles,
    getLiveProfile,
    saveLiveProfile,
    assignCoach,
  };

})();

// Mesma observação de storage.js: `const API` não é `window.API` por padrão.
window.API = API;
