// ================================================
// SALESPULSE — Storage Manager
// ================================================

const Storage = (() => {
  const PREFIX = 'sbp_';

  const keys = {
    AUTH:               PREFIX + 'auth',
    CONFIG:             PREFIX + 'config',
    SESSIONS:           PREFIX + 'sessions',
    SCENARIOS:          PREFIX + 'scenarios',
    SETTINGS:           PREFIX + 'settings',
    WINNING_PHRASES:    PREFIX + 'winning_phrases',
  };

  let _cache = {
    clients: [],
    products: [],
    scheduled_sessions: [],
    sellers: []
  };
  let _isReady = false;
  let _hydrating = null;

  async function hydrate() {
    // Guard de concorrência: vários gatilhos (login, navegação, foco da aba)
    // podem chamar hydrate ao mesmo tempo — reaproveita a mesma promessa.
    if (_hydrating) return _hydrating;
    _hydrating = (async () => {
      try {
        if (!window.API || !window.API.isBackendEnabled()) return;

        const auth = getAuth();
        if (!auth) return;

        if (typeof API.syncDown === 'function') await API.syncDown();

        const [clients, products, sched, users] = await Promise.all([
          API.listClients(),
          API.listProducts(),
          API.listScheduledSessions(),
          API.listUsers()
        ]);
        // Só sobrescreve o cache quando a API devolve dados válidos, evitando
        // zerar a lista por uma resposta nula/parcial.
        if (Array.isArray(clients)) _cache.clients = clients;
        if (Array.isArray(products)) _cache.products = products;
        if (Array.isArray(sched)) _cache.scheduled_sessions = sched;
        if (Array.isArray(users)) _cache.sellers = users.filter(u => u.role === 'seller');
        _isReady = true;
      } catch(e) {
        console.error('[STORAGE] Hydration error', e);
      } finally {
        _hydrating = null;
      }
    })();
    return _hydrating;
  }

  function get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch { return false; }
  }

  function remove(key) {
    localStorage.removeItem(key);
  }

  // ── Auth ──
  function getAuth()        { return get(keys.AUTH); }
  function setAuth(data)    { return set(keys.AUTH, data); }
  function clearAuth()      { remove(keys.AUTH); }

  // ── Config (active training scenario) ──
  function getConfig()      { return get(keys.CONFIG) || defaultConfig(); }
  function setConfig(data)  { return set(keys.CONFIG, { ...defaultConfig(), ...data }); }
  function defaultConfig() {
    return {
      name: 'Simulação Rápida',
      difficulty: 'medium',
      timeLimit: 15,
      voiceEnabled: false,
      product: {
        name: 'Produto Genérico',
        price: 'R$ 0,00',
        benefits: [],
        objections: []
      }
    };
  }

  // 🛒 Sellers 🛒 (Cache via API)
  function getAllSellers()  { return _cache.sellers; }
  function getSellers() {
    let sellers = getAllSellers();
    const auth = getAuth();
    if (auth) {
      const user = auth.user || auth;
      if (user.role === 'manager') {
        sellers = sellers.filter(s => s.manager_id === user.id || s.managerId === user.id);
      }
    }
    return sellers;
  }
  
  async function addSeller(seller) {
    const created = await API.createUser(seller);
    if(created) _cache.sellers.unshift(created);
    return created;
  }
  
  async function updateSeller(id, updates) {
    await API.updateUser(id, updates);
    _cache.sellers = _cache.sellers.map(s => s.id === id ? { ...s, ...updates } : s);
  }

  async function removeSeller(id) {
    await API.deleteUser(id);
    _cache.sellers = _cache.sellers.filter(s => s.id !== id);
  }

  // Allow external refresh of sellers cache (called after create/update)
  function _refreshSellers(sellers) {
    _cache.sellers = sellers || [];
  }

  // ── Sessions (localStorage for in-progress + API for reports) ──
  function getSessions()    { return get(keys.SESSIONS) || []; }
  function setSessions(arr) { return set(keys.SESSIONS, arr); }

  // Fetch sessions from API (for cross-device reports)
  async function getSessionsFromAPI() {
    try {
      if (!window.API || !window.API.isBackendEnabled()) return getSessions();
      const rows = await API.get ? API.request('/api/sessions') : null;
      if (rows && Array.isArray(rows)) return rows;
      return getSessions();
    } catch(e) {
      console.warn('[STORAGE] getSessionsFromAPI failed, using local', e);
      return getSessions();
    }
  }

  function saveSession(session) {
    const sessions = getSessions();
    session.id = session.id || ('ses_' + Date.now());
    session.createdAt = session.createdAt || new Date().toISOString();
    sessions.unshift(session);
    if (sessions.length > 200) sessions.splice(200);
    setSessions(sessions);
    return session;
  }

  function updateSession(id, updates) {
    const sessions = getSessions().map(s => s.id === id ? { ...s, ...updates } : s);
    setSessions(sessions);
  }

  function getSessionsBySeller(sellerId) {
    return getSessions().filter(s => s.sellerId === sellerId || s.seller_id === sellerId);
  }

  // ── Scenarios ──
  function getScenarios()     { return get(keys.SCENARIOS) || []; }
  function setScenarios(arr)  { return set(keys.SCENARIOS, arr); }

  function saveScenario(scenario) {
    const scenarios = getScenarios();
    if (scenario.id) {
      const idx = scenarios.findIndex(s => s.id === scenario.id);
      if (idx >= 0) scenarios[idx] = scenario;
    } else {
      scenario.id = 'sc_' + Date.now();
      scenario.createdAt = new Date().toISOString();
      scenarios.push(scenario);
    }
    setScenarios(scenarios);
    return scenario;
  }

  function removeScenario(id) {
    setScenarios(getScenarios().filter(s => s.id !== id));
  }

  // ── Settings ──
  function getSettings()     { return get(keys.SETTINGS) || {}; }
  function setSettings(data) { return set(keys.SETTINGS, { ...getSettings(), ...data }); }

  // ── Clients ──
  function getClients()     { return _cache.clients; }
  
  async function addClient(client) {
    const created = await API.createClient(client);
    if(created) _cache.clients.unshift(created);
    return created;
  }
  
  async function updateClient(id, updates) {
    await API.updateClient(id, updates);
    _cache.clients = _cache.clients.map(c => c.id === id ? { ...c, ...updates } : c);
  }

  async function removeClient(id) {
    await API.deleteClient(id);
    _cache.clients = _cache.clients.filter(c => c.id !== id);
  }

  // ── Products ──
  function getProducts()     { return _cache.products; }
  
  async function addProduct(product) {
    const created = await API.createProduct(product);
    if(created) _cache.products.unshift(created);
    return created;
  }

  async function updateProduct(id, updates) {
    await API.updateProduct(id, updates);
    _cache.products = _cache.products.map(p => p.id === id ? { ...p, ...updates } : p);
  }

  async function removeProduct(id) {
    await API.deleteProduct(id);
    _cache.products = _cache.products.filter(p => p.id !== id);
  }

  // ── Scheduled Sessions ──
  function getScheduledSessions() { return _cache.scheduled_sessions; }
  
  function getScheduledSessionsForSeller(sellerId) {
    // Só sessões realmente ABERTAS: concluída (dealbreaker, venda fechada ou
    // avaliação) não pode voltar para a lista nem ser reaberta pelo vendedor.
    return _cache.scheduled_sessions.filter(s =>
      String(s.sellerId) === String(sellerId) && s.status !== 'cancelled' && s.status !== 'done');
  }

  async function addScheduledSession(data) {
    const created = await API.createScheduledSession(data);
    if (created) {
      // Normaliza a resposta antes de entrar no cache: sem status a sessão
      // nova não cai em "pendentes" nem "concluídas" e some da tela do
      // gestor até o próximo hydrate.
      if (!created.status) created.status = 'pending';
      if (!created.createdAt) created.createdAt = created.created_at || new Date().toISOString();
      if (created.sellerId === undefined && created.seller_id !== undefined) created.sellerId = created.seller_id;
      if (created.clientId === undefined && created.client_id !== undefined) created.clientId = created.client_id;
      _cache.scheduled_sessions.unshift(created);
    }
    return created;
  }

  async function updateScheduledSession(id, updates) {
    await API.updateScheduledSession(id, updates);
    _cache.scheduled_sessions = _cache.scheduled_sessions.map(s => s.id === id ? { ...s, ...updates } : s);
  }

  async function removeScheduledSession(id) {
    await API.deleteScheduledSession(id);
    _cache.scheduled_sessions = _cache.scheduled_sessions.filter(s => s.id !== id);
  }

  function defaultProduct() {
    return {
      name:       'Novo Produto',
      category:   'Software',
      price:      'R$ 0,00',
      description: '',
      benefits:   [],
      objections: [],
      clientesAtribuidos:   [],
      vendedoresAtribuidos: [],
    };
  }

  function defaultClient() {
    return {
      name: 'Novo Cliente',
      role: 'Gerente',
      company: 'Empresa XYZ',
      emoji: '👨‍💼',
      industry: 'Tecnologia',
      description: '',
      customBehavior: '', 
      archetype: null,
      hiddenAgenda: null,
      marketSegment: 'generico',
      hostileMode: false,
      hostileCompetitors: [],
      sessionConstraints: {
        extremeHaste: false,
        shortSession: false,
        interruptions: false,
        longResistance: false,
      },
      humanidade: 50,
      formalidade: 70,
      nivelErros: 10,
      nivelGirias: 20,
      sotaqueRegiao: 'neutro',
      velocidadeResposta: 'normal',
      emotividade: 40,
      nivelTecnico: 40,
      objetividade: 60,
      usaAbreviacoes: false,
      usaMaiusculas: false,
      usaEmojis: false,
      fazPerguntas: true,
      skepticism: 60,
      urgency: 40,
      priceSensitivity: 65,
      productKnowledge: 35,
      negotiationWill: 50,
      trickFrequency: 40,
      trickTypes: [],
      vendedoresAtribuidos: []
    };
  }

  // ── Winning Phrases ──
  function getWinningPhrases() { return get(keys.WINNING_PHRASES) || []; }
  function addWinningPhrase(phraseObj) {
    const phrases = getWinningPhrases();
    phrases.unshift({ ...phraseObj, id: 'win_' + Date.now(), createdAt: new Date().toISOString() });
    set(keys.WINNING_PHRASES, phrases);
  }

  return {
    hydrate,
    getAuth, setAuth, clearAuth,
    getConfig, setConfig, defaultConfig,
    getAllSellers, getSellers, addSeller, updateSeller, removeSeller, _refreshSellers,
    getSessions, setSessions, saveSession, updateSession, getSessionsBySeller, getSessionsFromAPI,
    getScenarios, saveScenario, removeScenario,
    getSettings, setSettings,
    getClients, addClient, updateClient, removeClient, defaultClient,
    getProducts, addProduct, updateProduct, removeProduct, defaultProduct,
    getScheduledSessions, getScheduledSessionsForSeller, addScheduledSession, updateScheduledSession, removeScheduledSession,
    getWinningPhrases, addWinningPhrase
  };

})();

// `const` no topo do arquivo NÃO vira propriedade de `window` — só uma
// variável global lexical. Várias partes do app checam `window.Storage`
// antes de chamar hydrate(), e essa checagem sempre falhava silenciosamente,
// fazendo o cache nunca recarregar do backend (F5 sempre voltava vazio).
window.Storage = Storage;
