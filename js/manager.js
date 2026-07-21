// ================================================
// SALESPULSE — Manager Dashboard
// ================================================

const Manager = (() => {

  let activeSection = 'clients';
  let tempConfig = {};
  let editingSellerId = null;
  let editingClientId = null;
  let clientModalTab = 'perfil';

  // ══════════════════════════════════════
  // INIT
  // ══════════════════════════════════════
  function init() {
    // Auth is already validated by App router before calling Manager.init()
    const user = Auth.getUser();
    if (!user || (user.role !== 'manager' && user.role !== 'superadmin')) {
      Auth.logout();
      return;
    }
    document.getElementById('mgr-user-name').textContent = user.name;
    document.getElementById('mgr-user-role').textContent = user.role === 'superadmin' ? 'Super Admin' : 'Gestor';
    document.getElementById('mgr-user-avatar-text').textContent = user.name[0].toUpperCase();

    if (user.role === 'superadmin') {
      document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = '');
    } else {
      document.querySelectorAll('.superadmin-only').forEach(el => el.style.display = 'none');
    }

    // Load config into temp
    tempConfig = { ...Storage.getConfig() };

    renderSection('clients');
    setupNavigation();
    updateNotificationBadge();

    // Garante que a chave da OpenAI configurada localmente esteja também no
    // backend (necessária para transcrição de voz no servidor e para que os
    // vendedores recebam a chave via sync). É idempotente e silencioso.
    ensureApiKeyOnBackend();

    // Mantém os dados sincronizados entre dispositivos: ao voltar para a aba,
    // recarrega do backend e re-renderiza a seção atual.
    setupAutoRefresh();
  }

  let _autoRefreshBound = false;
  async function ensureApiKeyOnBackend() {
    try {
      const cfg = Storage.getConfig();
      const key = cfg.openaiKey || (Storage.getSettings() || {}).openaiKey;
      if (key && window.API && API.isBackendEnabled() && API.saveAiSettings) {
        await API.saveAiSettings(key, cfg.openaiModel || 'gpt-4o-mini');
      }
    } catch (e) { /* silencioso */ }
  }

  function setupAutoRefresh() {
    if (_autoRefreshBound) return;
    _autoRefreshBound = true;
    let lastRefresh = 0;
    const refresh = async () => {
      if (document.hidden) return;
      // Não re-renderiza com um modal aberto (evita destruir formulário em edição).
      if (document.querySelector('#page-manager .modal-overlay.active')) return;
      const now = Date.now();
      if (now - lastRefresh < 4000) return; // evita rajadas
      lastRefresh = now;
      try {
        if (window.Storage && typeof Storage.hydrate === 'function') {
          await Storage.hydrate();
          // Não re-renderiza a seção de Configurações (pode ter input não salvo, ex: chave da API).
          if (activeSection !== 'settings' &&
              document.getElementById('page-manager')?.classList.contains('active') &&
              !document.querySelector('#page-manager .modal-overlay.active')) {
            renderSection(activeSection);
          }
        }
      } catch (e) { /* silencioso */ }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
  }

  function setupNavigation() {
    document.querySelectorAll('#page-manager .nav-item[data-section]').forEach(item => {
      item.addEventListener('click', async () => {
        const section = item.dataset.section;
        document.querySelectorAll('#page-manager .nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Re-sincroniza com o backend ao trocar de seção, para sempre exibir
        // dados atualizados (clientes/produtos/vendedores criados em outro
        // dispositivo aparecem aqui sem precisar recarregar a página).
        try {
          if (window.Storage && typeof Storage.hydrate === 'function') await Storage.hydrate();
        } catch (e) { /* mantém cache atual em caso de falha */ }

        renderSection(section);

        // Fechar menu mobile se estiver aberto
        document.getElementById('manager-sidebar')?.classList.remove('open');
        document.getElementById('manager-sidebar-backdrop')?.classList.remove('active');
      });
    });
  }

  function updateNotificationBadge() {
    const sessions = Storage.getSessions();
    const badge = document.getElementById('mgr-sessions-badge');
    if (badge) badge.textContent = sessions.length;
  }

  // ══════════════════════════════════════
  // SECTION ROUTING
  // ══════════════════════════════════════
  function renderSection(section) {
    activeSection = section;
    const content = document.getElementById('manager-content');
    const title = document.getElementById('mgr-page-title');
    const sub = document.getElementById('mgr-page-sub');

    const sectionDefs = {
      clients:   { title: 'Clientes Potenciais', sub: 'Crie e gerencie perfis de clientes para treinamento', render: renderClientsSection },
      managers:  { title: 'Gestores', sub: 'Gerencie a equipe de gestores', render: renderManagersSection },
      sellers:   { title: 'Vendedores', sub: 'Gerencie a equipe e acompanhe o cadastro', render: renderSellersSection },
      products:  { title: 'Produtos', sub: 'Cadastre produtos e atribua-os a clientes e vendedores', render: renderProductsSection },
      sessoes:   { title: 'Sess\u00f5es Agendadas', sub: 'Crie sess\u00f5es de treinamento individuais para cada vendedor', render: (c) => Sessoes.render(c) },
      livecoach: { title: 'Live Coach \u2014 Chamadas Reais', sub: 'Perfis aprendidos pela IA e hist\u00f3rico de chamadas reais dos vendedores', render: renderLiveCoachSection },
      settings:  { title: 'Configura\u00e7\u00f5es', sub: 'API, conta e prefer\u00eancias do sistema', render: renderSettingsSection },
    };

    const def = sectionDefs[section] || sectionDefs.clients;
    if (title) title.textContent = def.title;
    if (sub) sub.textContent = def.sub;

    content.innerHTML = '';
    content.style.animation = 'none';
    setTimeout(() => {
      content.style.animation = 'fadeInUp 0.4s var(--ease-out)';
      def.render(content);
    }, 10);
  }

  // Re-render the currently active section (used by sub-modules like Sessoes)
  function refreshSection(section) {
    renderSection(section || activeSection);
  }

  // ══════════════════════════════════════
  // CONFIG SECTION
  // ══════════════════════════════════════
  function renderConfigSection(container) {
    container.innerHTML = `
      <div class="flex flex-between mb-6">
        <div></div>
        <div class="flex gap-3">
          <button class="btn btn-secondary btn-sm" onclick="Manager.resetConfig()">↺ Restaurar Padrão</button>
          <button class="btn btn-primary" onclick="Manager.saveConfig()">💾 Salvar Configurações</button>
        </div>
      </div>

      <!-- PRODUCT -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon purple">📦</div>
          <div>
            <div class="config-section-title">Produto / Serviço</div>
            <div class="config-section-desc">O que o vendedor vai tentar vender</div>
          </div>
        </div>
        <div class="config-grid">
          <div class="form-group">
            <label class="form-label">Nome do Produto</label>
            <input type="text" class="form-input" id="cfg-product-name" value="${escHtml(tempConfig.productName)}" placeholder="Ex: Sistema ERP Pro">
          </div>
          <div class="form-group">
            <label class="form-label">Preço / Proposta</label>
            <input type="text" class="form-input" id="cfg-product-price" value="${escHtml(tempConfig.productPrice)}" placeholder="Ex: R$ 1.500/mês">
          </div>
          <div class="form-group config-full">
            <label class="form-label">Descrição do Produto</label>
            <textarea class="form-textarea" id="cfg-product-desc" rows="3" placeholder="Descreva o produto, seus diferenciais e proposta de valor...">${escHtml(tempConfig.productDescription || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Principais Benefícios <span class="text-muted fs-xs">(Enter para adicionar)</span></label>
            <div class="tags-container" id="benefits-container" onclick="this.querySelector('.tags-input').focus()">
              ${(tempConfig.productBenefits || []).map(b => `<span class="tag">${escHtml(b)}<span class="tag-remove" onclick="Manager.removeTag(this,'benefits')">×</span></span>`).join('')}
              <input type="text" class="tags-input" placeholder="Adicionar benefício..." onkeydown="Manager.handleTagInput(event,'benefits')">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Objeções Esperadas <span class="text-muted fs-xs">(Enter para adicionar)</span></label>
            <div class="tags-container" id="objections-container" onclick="this.querySelector('.tags-input').focus()">
              ${(tempConfig.productObjections || []).map(o => `<span class="tag" style="background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)">${escHtml(o)}<span class="tag-remove" onclick="Manager.removeTag(this,'objections')">×</span></span>`).join('')}
              <input type="text" class="tags-input" placeholder="Adicionar objeção..." onkeydown="Manager.handleTagInput(event,'objections')">
            </div>
          </div>
        </div>
      </div>

      <!-- CUSTOMER PERSONA -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon teal">🎭</div>
          <div>
            <div class="config-section-title">Persona do Cliente</div>
            <div class="config-section-desc">Quem é o cliente que o vendedor vai enfrentar</div>
          </div>
        </div>
        <div class="config-grid">
          <div class="form-group">
            <label class="form-label">Nome do Cliente</label>
            <input type="text" class="form-input" id="cfg-customer-name" value="${escHtml(tempConfig.customerName)}" placeholder="Ex: Ricardo Mendes">
          </div>
          <div class="form-group">
            <label class="form-label">Emoji / Avatar</label>
            <input type="text" class="form-input" id="cfg-customer-emoji" value="${tempConfig.customerEmoji || '👨‍💼'}" placeholder="👨‍💼">
          </div>
          <div class="form-group">
            <label class="form-label">Estilo de Comunicação</label>
            <select class="form-select" id="cfg-customer-style">
              <option value="formal" ${tempConfig.customerStyle === 'formal' ? 'selected' : ''}>Formal & Profissional</option>
              <option value="casual" ${tempConfig.customerStyle === 'casual' ? 'selected' : ''}>Casual & Descontraído</option>
              <option value="technical" ${tempConfig.customerStyle === 'technical' ? 'selected' : ''}>Técnico & Analítico</option>
              <option value="aggressive" ${tempConfig.customerStyle === 'aggressive' ? 'selected' : ''}>Direto & Impaciente</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Setor / Indústria</label>
            <input type="text" class="form-input" id="cfg-scenario-industry" value="${escHtml(tempConfig.scenarioIndustry || '')}" placeholder="Ex: Tecnologia, Saúde, Varejo...">
          </div>
        </div>
      </div>

      <!-- DIFFICULTY -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon orange">⚡</div>
          <div>
            <div class="config-section-title">Nível de Dificuldade</div>
            <div class="config-section-desc">Quão difícil será convencer este cliente</div>
          </div>
        </div>
        <div class="difficulty-grid">
          ${['easy','medium','hard','expert'].map(d => `
            <div class="diff-card ${d} ${tempConfig.difficulty === d ? 'selected' : ''}" onclick="Manager.setDifficulty('${d}')">
              <div class="diff-icon">${{easy:'😊',medium:'🤔',hard:'😤',expert:'🔥'}[d]}</div>
              <div class="diff-name">${{easy:'Fácil',medium:'Médio',hard:'Difícil',expert:'Expert'}[d]}</div>
              <div class="diff-desc">${{
                easy:'Cliente receptivo e aberto',
                medium:'Cético mas razoável',
                hard:'Muito exigente e resistente',
                expert:'Praticamente impossível'
              }[d]}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- BEHAVIOR SLIDERS -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon purple">🧠</div>
          <div>
            <div class="config-section-title">Perfil Comportamental</div>
            <div class="config-section-desc">Ajuste fino das características psicológicas do cliente</div>
          </div>
        </div>
        <div class="behavior-grid">
          ${[
            ['skepticism',        'Ceticismo',             'Quanto o cliente desconfia e questiona', 'var(--danger)'],
            ['urgency',           'Urgência de Compra',    'Quanta pressa o cliente tem para decidir', 'var(--teal)'],
            ['priceSensitivity',  'Sensibilidade a Preço', 'Quanto preço influencia a decisão', 'var(--warning)'],
            ['productKnowledge',  'Conhecimento do Mercado','Familiaridade com o produto e alternativas', 'var(--accent)'],
            ['negotiationWill',   'Disposição p/ Negociar','Abertura para discutir condições', 'var(--success)'],
          ].map(([key, label, desc, color]) => `
            <div class="behavior-item">
              <div class="range-group">
                <div class="range-header">
                  <span class="range-label">${label}</span>
                  <span class="range-value" id="val-${key}">${tempConfig[key] || 50}</span>
                </div>
                <div class="text-muted fs-xs mb-4">${desc}</div>
                <input type="range" class="range-slider" id="cfg-${key}"
                  min="0" max="100" value="${tempConfig[key] || 50}"
                  style="accent-color:${color}"
                  oninput="document.getElementById('val-${key}').textContent=this.value">
                <div class="flex flex-between fs-xs text-muted mt-2">
                  <span>${['skepticism','priceSensitivity'].includes(key) ? 'Confiante' : ['urgency','negotiationWill'].includes(key) ? 'Baixa' : 'Baixo'}</span>
                  <span>${['skepticism','priceSensitivity'].includes(key) ? 'Muito Cético' : ['urgency','negotiationWill'].includes(key) ? 'Alta' : 'Alto'}</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- TRICKS / OBSTRUCTIONS -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon red">🃏</div>
          <div>
            <div class="config-section-title">Sistema de Truques & Objeções</div>
            <div class="config-section-desc">O cliente usará estas táticas para testar o vendedor</div>
          </div>
        </div>
        <div class="config-grid">
          <div class="form-group config-full">
            <div class="range-group">
              <div class="range-header">
                <span class="range-label">Frequência de Truques</span>
                <span class="range-value" id="val-trickFrequency">${tempConfig.trickFrequency || 40}</span>
              </div>
              <input type="range" class="range-slider" id="cfg-trickFrequency"
                min="0" max="100" value="${tempConfig.trickFrequency || 40}"
                oninput="document.getElementById('val-trickFrequency').textContent=this.value">
              <div class="flex flex-between fs-xs text-muted mt-2">
                <span>Raramente</span><span>Constantemente</span>
              </div>
            </div>
          </div>
          <div class="form-group config-full">
            <label class="form-label">Tipos de Objeções Habilitados</label>
            <div class="grid-2" style="margin-top:var(--sp-3)">
              ${[
                ['price',        '💰', 'Objeção de Preço',         '"Está muito caro..."'],
                ['competitor',   '🏆', 'Concorrência',             '"O concorrente X faz por menos..."'],
                ['authority',    '🤝', 'Falta de Autoridade',      '"Preciso consultar meu sócio..."'],
                ['doubt',        '🤔', 'Dúvida de Eficácia',       '"Como sei que funciona?"'],
                ['urgency',      '⏰', 'Urgência Falsa',           '"Preciso pensar mais..."'],
                ['doubt_company','🏢', 'Dúvida sobre a Empresa',   '"Nunca ouvi falar de vocês..."'],
              ].map(([val, icon, label, example]) => `
                <label class="toggle-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
                  <label class="toggle">
                    <input type="checkbox" value="${val}" class="trick-type-check" ${(tempConfig.trickTypes||[]).includes(val)?'checked':''}>
                    <span class="toggle-track"></span>
                    <span class="toggle-thumb"></span>
                  </label>
                  <div>
                    <div style="font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:var(--sp-2)">${icon} ${label}</div>
                    <div class="text-muted fs-xs">${example}</div>
                  </div>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Gatilhos de Convencimento <span class="text-muted fs-xs">(Enter)</span></label>
            <div class="tags-container" id="triggers-container" onclick="this.querySelector('.tags-input').focus()">
              ${(tempConfig.buyingTriggers||[]).map(t=>`<span class="tag" style="background:rgba(46,213,115,0.12);border-color:rgba(46,213,115,0.3);color:var(--success)">${escHtml(t)}<span class="tag-remove" onclick="Manager.removeTag(this,'triggers')">×</span></span>`).join('')}
              <input type="text" class="tags-input" placeholder="O que convence..." onkeydown="Manager.handleTagInput(event,'triggers')">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Dealbreakers <span class="text-muted fs-xs">(Enter)</span></label>
            <div class="tags-container" id="dealbreakers-container" onclick="this.querySelector('.tags-input').focus()">
              ${(tempConfig.dealbreakers||[]).map(d=>`<span class="tag" style="background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)">${escHtml(d)}<span class="tag-remove" onclick="Manager.removeTag(this,'dealbreakers')">×</span></span>`).join('')}
              <input type="text" class="tags-input" placeholder="O que destrói a venda..." onkeydown="Manager.handleTagInput(event,'dealbreakers')">
            </div>
          </div>
        </div>
      </div>

      <!-- SCORING WEIGHTS -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon green">🎯</div>
          <div>
            <div class="config-section-title">Critérios de Avaliação</div>
            <div class="config-section-desc">Pesos de cada critério na pontuação final (total deve ser 100)</div>
          </div>
        </div>
        <div class="behavior-grid">
          ${[
            ['rapport',         'Rapport & Abertura',             15],
            ['discovery',       'Levantamento de Necessidades',   20],
            ['value',           'Apresentação de Valor',          20],
            ['objections',      'Manejo de Objeções',             25],
            ['closing',         'Técnicas de Fechamento',         15],
            ['professionalism', 'Profissionalismo',               5],
          ].map(([key, label, def]) => `
            <div class="range-group">
              <div class="range-header">
                <span class="range-label">${label}</span>
                <span class="range-value" id="wval-${key}">${(tempConfig.weights||{})[key]||def}%</span>
              </div>
              <input type="range" class="range-slider" id="cfg-weight-${key}"
                min="0" max="40" value="${(tempConfig.weights||{})[key]||def}"
                oninput="document.getElementById('wval-${key}').textContent=this.value+'%'">
            </div>
          `).join('')}
        </div>

        <div class="divider"></div>
        <div class="config-grid">
          <div class="form-group">
            <label class="form-label">Pontuação Mínima para Aprovação</label>
            <div class="range-group">
              <div class="range-header">
                <span class="range-label">Mínimo para passar</span>
                <span class="range-value" id="val-passingScore">${tempConfig.passingScore||60}</span>
              </div>
              <input type="range" class="range-slider" id="cfg-passingScore"
                min="30" max="90" value="${tempConfig.passingScore||60}"
                oninput="document.getElementById('val-passingScore').textContent=this.value">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Tempo Máximo (minutos)</label>
            <div class="range-group">
              <div class="range-header">
                <span class="range-label">Duração da sessão</span>
                <span class="range-value" id="val-maxMinutes">${tempConfig.maxMinutes||30}</span>
              </div>
              <input type="range" class="range-slider" id="cfg-maxMinutes"
                min="5" max="60" value="${tempConfig.maxMinutes||30}"
                oninput="document.getElementById('val-maxMinutes').textContent=this.value">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Dicas para o Vendedor</label>
            <label class="toggle-group" style="gap:var(--sp-3)">
              <label class="toggle">
                <input type="checkbox" id="cfg-hintsEnabled" ${tempConfig.hintsEnabled?'checked':''}>
                <span class="toggle-track"></span>
                <span class="toggle-thumb"></span>
              </label>
              <div>
                <div style="font-size:0.88rem;font-weight:600">Habilitar sugestões durante a conversa</div>
                <div class="text-muted fs-xs">Mostra chips com dicas de resposta</div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div class="flex gap-3" style="justify-content:flex-end;margin-top:var(--sp-4)">
        <button class="btn btn-secondary" onclick="Manager.resetConfig()">↺ Restaurar Padrão</button>
        <button class="btn btn-primary btn-lg" onclick="Manager.saveConfig()">💾 Salvar Configurações</button>
      </div>
    `;
  }

  // ══════════════════════════════════════
  // CONFIG SAVE/LOAD
  // ══════════════════════════════════════
  function saveConfig() {
    const updates = {
      productName:        document.getElementById('cfg-product-name')?.value || tempConfig.productName,
      productPrice:       document.getElementById('cfg-product-price')?.value || tempConfig.productPrice,
      productDescription: document.getElementById('cfg-product-desc')?.value || '',
      productBenefits:    getTagValues('benefits-container'),
      productObjections:  getTagValues('objections-container'),
      customerName:       document.getElementById('cfg-customer-name')?.value || tempConfig.customerName,
      customerEmoji:      document.getElementById('cfg-customer-emoji')?.value || '👨‍💼',
      customerStyle:      document.getElementById('cfg-customer-style')?.value || 'formal',
      scenarioIndustry:   document.getElementById('cfg-scenario-industry')?.value || '',
      skepticism:         parseInt(document.getElementById('cfg-skepticism')?.value || 60),
      urgency:            parseInt(document.getElementById('cfg-urgency')?.value || 40),
      priceSensitivity:   parseInt(document.getElementById('cfg-priceSensitivity')?.value || 70),
      productKnowledge:   parseInt(document.getElementById('cfg-productKnowledge')?.value || 40),
      negotiationWill:    parseInt(document.getElementById('cfg-negotiationWill')?.value || 50),
      trickFrequency:     parseInt(document.getElementById('cfg-trickFrequency')?.value || 40),
      trickTypes:         Array.from(document.querySelectorAll('.trick-type-check:checked')).map(c => c.value),
      buyingTriggers:     getTagValues('triggers-container'),
      dealbreakers:       getTagValues('dealbreakers-container'),
      passingScore:       parseInt(document.getElementById('cfg-passingScore')?.value || 60),
      maxMinutes:         parseInt(document.getElementById('cfg-maxMinutes')?.value || 30),
      hintsEnabled:       document.getElementById('cfg-hintsEnabled')?.checked ?? true,
      weights: {
        rapport:         parseInt(document.getElementById('cfg-weight-rapport')?.value || 15),
        discovery:       parseInt(document.getElementById('cfg-weight-discovery')?.value || 20),
        value:           parseInt(document.getElementById('cfg-weight-value')?.value || 20),
        objections:      parseInt(document.getElementById('cfg-weight-objections')?.value || 25),
        closing:         parseInt(document.getElementById('cfg-weight-closing')?.value || 15),
        professionalism: parseInt(document.getElementById('cfg-weight-professionalism')?.value || 5),
      },
    };

    tempConfig = { ...tempConfig, ...updates };
    Storage.setConfig(tempConfig);
    UI.toast('✅ Configurações salvas com sucesso!', 'success');
  }

  function resetConfig() {
    if (!confirm('Restaurar configurações padrão? Isso apagará suas customizações.')) return;
    tempConfig = Storage.defaultConfig();
    Storage.setConfig(tempConfig);
    renderSection('config');
    UI.toast('Configurações restauradas.', 'info');
  }

  function setDifficulty(level) {
    tempConfig.difficulty = level;
    document.querySelectorAll('.diff-card').forEach(c => c.classList.remove('selected'));
    document.querySelector(`.diff-card.${level}`)?.classList.add('selected');

    // Auto-adjust sliders based on difficulty
    const presets = {
      easy:   { skepticism:25, urgency:65, priceSensitivity:35, productKnowledge:20, negotiationWill:70, trickFrequency:15 },
      medium: { skepticism:55, urgency:40, priceSensitivity:65, productKnowledge:45, negotiationWill:55, trickFrequency:40 },
      hard:   { skepticism:75, urgency:25, priceSensitivity:80, productKnowledge:65, negotiationWill:40, trickFrequency:65 },
      expert: { skepticism:92, urgency:15, priceSensitivity:85, productKnowledge:85, negotiationWill:20, trickFrequency:85 },
    };
    const p = presets[level];
    if (p) {
      Object.entries(p).forEach(([key, val]) => {
        const el = document.getElementById(`cfg-${key}`);
        const valEl = document.getElementById(`val-${key}`);
        if (el) { el.value = val; tempConfig[key] = val; }
        if (valEl) valEl.textContent = val;
      });
    }
  }

  // ══════════════════════════════════════
  // TAG INPUT HELPERS
  // ══════════════════════════════════════
  function handleTagInput(event, containerKey) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const input = event.target;
    const val = input.value.trim();
    if (!val) return;

    const container = document.getElementById(`${containerKey}-container`);
    if (!container) return;

    const colorMap = {
      benefits:    'background:rgba(108,99,255,0.12);border-color:rgba(108,99,255,0.3);color:var(--accent-light)',
      objections:  'background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)',
      triggers:    'background:rgba(46,213,115,0.12);border-color:rgba(46,213,115,0.3);color:var(--success)',
      dealbreakers:'background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)',
    };

    const style = colorMap[containerKey] || '';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.style.cssText = style;
    tag.innerHTML = `${escHtml(val)}<span class="tag-remove" onclick="Manager.removeTag(this,'${containerKey}')">×</span>`;
    container.insertBefore(tag, input);
    input.value = '';
  }

  function removeTag(el, containerKey) {
    el.closest('.tag')?.remove();
  }

  function getTagValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.tag')).map(t => {
      const clone = t.cloneNode(true);
      clone.querySelectorAll('.tag-remove').forEach(r => r.remove());
      return clone.textContent.trim();
    }).filter(Boolean);
  }

  async function fetchSellersForUI() {
    try {
      if (API.isBackendEnabled()) {
        const users = await API.request('/api/users');
        const sellers = users.filter(u => u.role === 'seller');
        const currentUser = Auth.getUser();
        if (currentUser?.role === 'manager') {
          return sellers.filter(s => s.manager_id === currentUser.id || s.managerId === currentUser.id);
        }
        return sellers;
      }
    } catch(err) {}
    return Storage.getSellers();
  }

  // ══════════════════════════════════════
  // CLIENTS SECTION
  // ══════════════════════════════════════
  async function renderClientsSection(container) {
    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;
    const clients = Storage.getClients();
    const sellers = await fetchSellersForUI();

    container.innerHTML = `
      <div class="flex flex-between mb-6">
        <div class="text-secondary" style="font-size:0.88rem">${clients.length} cliente${clients.length !== 1 ? 's' : ''} cadastrado${clients.length !== 1 ? 's' : ''}</div>
        <button class="btn btn-primary" onclick="Manager.openClientModal()" id="btn-new-client">+ Novo Cliente</button>
      </div>

      ${clients.length === 0 ? `
        <div class="card empty-state" style="padding:var(--sp-16)">
          <div class="empty-state-icon" style="font-size:3rem">🎭</div>
          <div class="empty-state-title">Nenhum cliente cadastrado</div>
          <div class="empty-state-desc">Crie perfis de clientes com personalidade, estilo de comunicação e comportamento personalizados. Atribua-os a vendedores para treinamento específico.</div>
          <button class="btn btn-primary" onclick="Manager.openClientModal()">+ Criar Primeiro Cliente</button>
        </div>
      ` : `
        <div class="clients-grid">
          ${clients.map(client => {
            const assignedSellers = sellers.filter(s => (client.vendedoresAtribuidos || []).includes(s.id));
            const diffColors = { easy: 'var(--success)', medium: 'var(--warning)', hard: 'var(--danger)', expert: '#ff006e' };
            const diffEmoji = { easy: '😊', medium: '🤔', hard: '😤', expert: '🔥' };
            const diffLabel = { easy: 'Fácil', medium: 'Médio', hard: 'Difícil', expert: 'Expert' };
            const sotaqueLabel = {
              neutro: '🗣️ Neutro', nordeste: '🌵 Nordeste', sulista: '🧉 Sulista',
              carioca: '🌊 Carioca', mineiro: '⛰️ Mineiro', baiano: '☀️ Baiano',
              'interior-sp': '🌾 Interior SP', gaucho: '🐂 Gaúcho'
            };
            return `
              <div class="client-card">
                <div class="client-card-header">
                  <div class="client-avatar">${escHtml(client.emoji || '👤')}</div>
                  <div class="client-info">
                    <div class="client-name">${escHtml(client.name)}</div>
                    <div class="client-role">${escHtml(client.role)} · ${escHtml(client.company)}</div>
                  </div>
                  <div class="flex gap-2" style="flex-shrink:0">
                    <button class="btn btn-sm btn-ghost" onclick="Manager.openClientModal('${client.id}')" title="Editar">✏️</button>
                    <button class="btn btn-sm btn-ghost" onclick="Manager.deleteClient('${client.id}')" title="Excluir">🗑️</button>
                  </div>
                </div>

                <div class="client-badges">
                  <span class="badge badge-muted" style="color:${diffColors[client.difficulty] || 'var(--warning)'}">
                    ${diffEmoji[client.difficulty] || '🤔'} ${diffLabel[client.difficulty] || 'Médio'}
                  </span>
                  <span class="badge badge-muted">${sotaqueLabel[client.sotaqueRegiao] || '🗣️ Neutro'}</span>
                  ${client.gender ? `<span class="badge badge-muted">${client.gender === 'female' ? '👩 Feminino' : '👨 Masculino'}</span>` : ''}
                  ${client.voice ? `<span class="badge badge-muted">🎙 ${escHtml(((AIEngine.VOICE_CATALOG || []).find(v => v.id === client.voice) || {}).name || client.voice)}</span>` : ''}
                  ${client.customBehavior ? `<span class="badge" style="background:linear-gradient(135deg,rgba(108,99,255,0.2),rgba(0,212,170,0.15));border:1px solid rgba(108,99,255,0.35);color:#a8a4ff">🧠 Comportamento livre</span>` : ''}
                  ${client.usaEmojis ? '<span class="badge badge-muted">😊 Emojis</span>' : ''}
                  ${client.usaGirias || client.nivelGirias > 50 ? '<span class="badge badge-muted">🤙 Gírias</span>' : ''}
                  ${client.nivelErros > 40 ? '<span class="badge badge-muted">✍️ Erros</span>' : ''}
                </div>

                <div class="client-sliders-preview">
                  ${[
                    ['Formal', client.formalidade ?? 70],
                    ['Humano', client.humanidade ?? 50],
                    ['Cético', client.skepticism ?? 60],
                  ].map(([label, val]) => `
                    <div class="client-slider-mini">
                      <span>${label}</span>
                      <div class="mini-progress-bar">
                        <div style="width:${val}%;background:var(--accent);border-radius:2px;height:4px"></div>
                      </div>
                      <span>${val}</span>
                    </div>
                  `).join('')}
                </div>

                <div class="divider" style="margin:var(--sp-4) 0"></div>


              </div>
            `;
          }).join('')}
        </div>
      `}

      <!-- Client Modal -->
      <div class="modal-overlay" id="client-modal">
        <div class="modal" style="max-width:680px;width:100%">
          <div class="flex flex-between" style="margin-bottom:var(--sp-5)">
            <h3 id="client-modal-title">Novo Cliente</h3>
            <button class="btn btn-ghost btn-icon" onclick="Manager.closeClientModal()">✕</button>
          </div>

          <!-- Tabs -->
          <div class="modal-tabs" id="client-modal-tabs">
            <div class="modal-tab active" onclick="Manager.switchClientTab('perfil')" id="ctab-perfil">👤 Perfil</div>
            <div class="modal-tab" onclick="Manager.switchClientTab('comunicacao')" id="ctab-comunicacao">💬 Comunicação</div>
            <div class="modal-tab" onclick="Manager.switchClientTab('comportamento')" id="ctab-comportamento">🧠 Comportamento</div>
          </div>

          <!-- TAB: PERFIL -->
          <div class="modal-tab-content" id="ctabcontent-perfil">
            <div class="config-grid">
              <div class="form-group">
                <label class="form-label">Nome do Cliente</label>
                <input type="text" class="form-input" id="cli-name" placeholder="Ex: Ricardo Mendes">
              </div>
              <div class="form-group">
                <label class="form-label">Emoji / Avatar</label>
                <input type="text" class="form-input" id="cli-emoji" placeholder="👨‍💼" style="font-size:1.4rem;text-align:center">
              </div>

              <div class="form-group">
                <label class="form-label">Gênero</label>
                <select class="form-select" id="cli-gender">
                  <option value="">🤖 Automático (deduz pelo nome/emoji)</option>
                  <option value="male">👨 Masculino</option>
                  <option value="female">👩 Feminino</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">🎙 Voz na ligação</label>
                <div style="display:flex;gap:8px;align-items:center">
                  <select class="form-select" id="cli-voice" style="flex:1;min-width:0">
                    <option value="">✨ Automática (melhor voz pelo gênero)</option>
                    <optgroup label="Vozes femininas">
                      ${(AIEngine.VOICE_CATALOG || []).filter(v => v.gender === 'female').map(v => `<option value="${v.id}">👩 ${v.name} — ${v.desc}</option>`).join('')}
                    </optgroup>
                    <optgroup label="Vozes masculinas">
                      ${(AIEngine.VOICE_CATALOG || []).filter(v => v.gender === 'male').map(v => `<option value="${v.id}">👨 ${v.name} — ${v.desc}</option>`).join('')}
                    </optgroup>
                  </select>
                  <button type="button" class="btn btn-ghost btn-sm" id="cli-voice-preview-btn" onclick="Manager.previewClientVoice()" title="Ouvir uma prévia da voz selecionada" style="flex-shrink:0">▶ Prévia</button>
                </div>
                <div class="text-muted fs-xs" style="margin-top:4px">Usada no treinamento por voz. "Automática" escolhe a voz mais natural do gênero do cliente.</div>
              </div>

              <div class="form-group">
                <label class="form-label">Setor / Indústria</label>
                <input type="text" class="form-input" id="cli-industry" placeholder="Ex: Tecnologia, Saúde...">
              </div>
              <div class="form-group">
                <label class="form-label">Nível de Dificuldade</label>
                <select class="form-select" id="cli-difficulty">
                  <option value="easy">😊 Fácil — Cliente receptivo</option>
                  <option value="medium" selected>🤔 Médio — Cético mas razoável</option>
                  <option value="hard">😤 Difícil — Muito exigente</option>
                  <option value="expert">🔥 Expert — Praticamente impossível</option>
                </select>
              </div>
              <div class="form-group config-full">
                <label class="form-label">Descrição / Contexto</label>
                <textarea class="form-textarea" id="cli-description" rows="3" placeholder="Descreva o perfil, contexto de vida ou trabalho deste cliente..."></textarea>
              </div>

              <div class="form-group config-full" style="margin-top:var(--sp-2)">
                <label class="form-label" style="display:flex;align-items:center;gap:8px">
                  🧠 Comportamento em Linguagem Natural
                  <span style="background:linear-gradient(135deg,#6c63ff,#00d4aa);color:white;font-size:0.65rem;font-weight:700;padding:2px 8px;border-radius:100px;letter-spacing:0.5px">PRIORIDADE MÁXIMA</span>
                </label>
                <textarea class="form-textarea" id="cli-customBehavior" rows="4"
                  placeholder="Descreva aqui em texto livre como este cliente deve se comportar. Exemplos:\n• 'Este cliente é um médico que já teve uma experiência ruim com software e fica agressivo quando mencionam integrações'\n• 'Faz perguntas sobre LGPD em todo momento, é extremamente cuidadoso com dados'\n• 'Só se anima se o vendedor mencionar ROI em percentual. Fica entediado com discurso técnico.'\n\nEsta instrução tem prioridade sobre arquétipo, dificuldade e todos os outros parâmetros."></textarea>
                <div style="font-size:0.72rem;color:#5a5a7a;margin-top:6px">💡 Se preenchido, este campo sobrepõe arquétipos, nível de dificuldade e todos os outros parâmetros de comportamento.</div>
              </div>
            </div>
          </div>

          <!-- TAB: COMUNICAÇÃO -->
          <div class="modal-tab-content" id="ctabcontent-comunicacao" style="display:none">
            <div style="margin-bottom:var(--sp-5)">
              <div class="comm-params-grid">

                <!-- Humanidade -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">🧑</span>
                    <div>
                      <div class="comm-param-title">Humanidade</div>
                      <div class="comm-param-desc">Quão humano e emocional é o jeito de falar</div>
                    </div>
                    <span class="range-value" id="cval-humanidade">50</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-humanidade" min="0" max="100" value="50" style="accent-color:#6c63ff" oninput="document.getElementById('cval-humanidade').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>🤖 Robótico</span><span>❤️ Muito humano</span></div>
                </div>

                <!-- Formalidade -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">👔</span>
                    <div>
                      <div class="comm-param-title">Formalidade</div>
                      <div class="comm-param-desc">Nível de formalidade na linguagem</div>
                    </div>
                    <span class="range-value" id="cval-formalidade">70</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-formalidade" min="0" max="100" value="70" style="accent-color:#2ed573" oninput="document.getElementById('cval-formalidade').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>😎 Muito informal</span><span>🎩 Extremamente formal</span></div>
                </div>

                <!-- Erros Gramaticais -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">✍️</span>
                    <div>
                      <div class="comm-param-title">Erros Gramaticais</div>
                      <div class="comm-param-desc">Frequência de erros de ortografia e gramática</div>
                    </div>
                    <span class="range-value" id="cval-nivelErros">10</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-nivelErros" min="0" max="100" value="10" style="accent-color:#ff4757" oninput="document.getElementById('cval-nivelErros').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>📚 Perfeito</span><span>💀 Muitos erros</span></div>
                </div>

                <!-- Gírias -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">🤙</span>
                    <div>
                      <div class="comm-param-title">Uso de Gírias</div>
                      <div class="comm-param-desc">Frequência de gírias e expressões populares</div>
                    </div>
                    <span class="range-value" id="cval-nivelGirias">20</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-nivelGirias" min="0" max="100" value="20" style="accent-color:#ffa502" oninput="document.getElementById('cval-nivelGirias').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>📖 Sem gírias</span><span>🔥 Repleto de gírias</span></div>
                </div>

                <!-- Emotividade -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">😤</span>
                    <div>
                      <div class="comm-param-title">Emotividade</div>
                      <div class="comm-param-desc">Quanto deixa as emoções transparecerem</div>
                    </div>
                    <span class="range-value" id="cval-emotividade">40</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-emotividade" min="0" max="100" value="40" style="accent-color:#ff6b81" oninput="document.getElementById('cval-emotividade').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>🧊 Frio/Racional</span><span>🌋 Muito emocional</span></div>
                </div>

                <!-- Objetividade -->
                <div class="comm-param-card">
                  <div class="comm-param-header">
                    <span class="comm-param-icon">🎯</span>
                    <div>
                      <div class="comm-param-title">Objetividade</div>
                      <div class="comm-param-desc">Vai direto ao ponto ou é prolixo/evasivo</div>
                    </div>
                    <span class="range-value" id="cval-objetividade">60</span>
                  </div>
                  <input type="range" class="range-slider" id="cli-objetividade" min="0" max="100" value="60" style="accent-color:#1e90ff" oninput="document.getElementById('cval-objetividade').textContent=this.value">
                  <div class="flex flex-between fs-xs text-muted mt-2"><span>🌀 Muito prolixo</span><span>⚡ Super direto</span></div>
                </div>

              </div>

              <!-- Selects row -->
              <div class="config-grid" style="margin-top:var(--sp-5)">
                <div class="form-group">
                  <label class="form-label">🗺️ Sotaque / Região</label>
                  <select class="form-select" id="cli-sotaqueRegiao">
                    <option value="neutro">🗣️ Neutro (sem sotaque)</option>
                    <option value="nordeste">🌵 Nordestino — xôra, aí, sô, véi</option>
                    <option value="carioca">🌊 Carioca — cara, mermão, oxe, massa</option>
                    <option value="mineiro">⛰️ Mineiro — uai, trem, sô, por favor</option>
                    <option value="baiano">☀️ Baiano — oxente, mermão, mainha, arretado</option>
                    <option value="sulista">🧉 Sulista — bah, tchê, né brother, tri</option>
                    <option value="gaucho">🐂 Gaúcho — bah tchê, guri, prenda, pila</option>
                    <option value="interior-sp">🌾 Interior SP — uai, sô, moço, véinho</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">⏱️ Velocidade de Resposta</label>
                  <select class="form-select" id="cli-velocidadeResposta">
                    <option value="rapido">⚡ Rápido e impulsivo</option>
                    <option value="normal" selected>⚖️ Normal / equilibrado</option>
                    <option value="lento">🐢 Lento / pensativo / hesitante</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">🎓 Nível Técnico</label>
                  <select class="form-select" id="cli-nivelTecnico">
                    <option value="10">🙋 Leigo — não entende nada do setor</option>
                    <option value="35" selected>📚 Intermediário — tem noção básica</option>
                    <option value="65">🔬 Avançado — conhece bem o mercado</option>
                    <option value="90">🧠 Especialista — sabe mais que você</option>
                  </select>
                </div>
              </div>

              <!-- Toggles -->
              <div style="margin-top:var(--sp-5)">
                <div class="form-label" style="margin-bottom:var(--sp-3)">⚡ Características Especiais de Linguagem</div>
                <div class="comm-toggles-grid">
                  ${[
                    ['cli-usaAbreviacoes', 'usaAbreviacoes', '📱', 'Usa Abreviações', 'vc, tb, pq, n sei, msm, hj, blz'],
                    ['cli-usaMaiusculas',  'usaMaiusculas',  '📢', 'Grita em CAPS',    'Usa CAPS LOCK para expressar irritação'],
                    ['cli-usaEmojis',      'usaEmojis',      '😊', 'Usa Emojis',       'Envia emojis nas mensagens'],
                    ['cli-fazPerguntas',   'fazPerguntas',   '❓', 'Faz Muitas Perguntas', 'Questiona e pede esclarecimentos muito'],
                  ].map(([id, key, icon, title, desc]) => `
                    <label class="toggle-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
                      <label class="toggle">
                        <input type="checkbox" id="${id}" class="cli-toggle">
                        <span class="toggle-track"></span>
                        <span class="toggle-thumb"></span>
                      </label>
                      <div>
                        <div style="font-size:0.85rem;font-weight:600">${icon} ${title}</div>
                        <div class="text-muted fs-xs">${desc}</div>
                      </div>
                    </label>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: COMPORTAMENTO -->
          <div class="modal-tab-content" id="ctabcontent-comportamento" style="display:none">
            <div class="behavior-grid">
              ${[
                ['cli-skepticism',       'Ceticismo',              'Quanto desconfia e questiona',         'var(--danger)',  'Confiante', 'Muito cético'],
                ['cli-urgency',          'Urgência de Compra',     'Quanta pressa tem para decidir',       'var(--teal)',    'Baixa',     'Alta'],
                ['cli-priceSensitivity', 'Sensibilidade a Preço',  'Quanto preço influencia a decisão',    'var(--warning)', 'Baixa',     'Alta'],
                ['cli-productKnowledge', 'Conhecimento do Mercado','Familiaridade com produto/alternativas','var(--accent)',  'Baixo',     'Alto'],
                ['cli-negotiationWill',  'Disposição p/ Negociar', 'Abertura para discutir condições',     'var(--success)', 'Inflexível','Aberto'],
              ].map(([id, label, desc, color, low, high]) => `
                <div class="behavior-item">
                  <div class="range-group">
                    <div class="range-header">
                      <span class="range-label">${label}</span>
                      <span class="range-value" id="bval-${id.replace('cli-','')}">50</span>
                    </div>
                    <div class="text-muted fs-xs mb-4">${desc}</div>
                    <input type="range" class="range-slider" id="${id}" min="0" max="100" value="50"
                      style="accent-color:${color}"
                      oninput="document.getElementById('bval-${id.replace('cli-','')}').textContent=this.value">
                    <div class="flex flex-between fs-xs text-muted mt-2">
                      <span>${low}</span><span>${high}</span>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>

            <div class="divider" style="margin:var(--sp-6) 0"></div>

            <div class="form-label" style="margin-bottom:var(--sp-3)">🃏 Tipos de Objeções Habilitados</div>
            <div class="grid-2" style="margin-top:var(--sp-3)">
              ${[
                ['cli-trick-price',        'price',       '💰', 'Objeção de Preço',       '"Está muito caro..."'],
                ['cli-trick-competitor',   'competitor',  '🏆', 'Concorrência',           '"O concorrente X faz por menos..."'],
                ['cli-trick-authority',    'authority',   '🤝', 'Falta de Autoridade',    '"Preciso consultar meu sócio..."'],
                ['cli-trick-doubt',        'doubt',       '🤔', 'Dúvida de Eficácia',     '"Como sei que funciona?"'],
                ['cli-trick-urgency',      'urgency',     '⏰', 'Urgência Falsa',         '"Preciso pensar mais..."'],
                ['cli-trick-dbtcompany',   'doubt_company','🏢','Dúvida sobre a Empresa', '"Nunca ouvi falar de vocês..."'],
              ].map(([id, val, icon, label, example]) => `
                <label class="toggle-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
                  <label class="toggle">
                    <input type="checkbox" value="${val}" class="cli-trick-check" id="${id}">
                    <span class="toggle-track"></span>
                    <span class="toggle-thumb"></span>
                  </label>
                  <div>
                    <div style="font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:var(--sp-2)">${icon} ${label}</div>
                    <div class="text-muted fs-xs">${example}</div>
                  </div>
                </label>
              `).join('')}
            </div>

            <div style="margin-top:var(--sp-5)">
              <div class="range-group">
                <div class="range-header">
                  <span class="range-label">Frequência de Objeções</span>
                  <span class="range-value" id="bval-cli-trickFreq">40</span>
                </div>
                <input type="range" class="range-slider" id="cli-trickFrequency" min="0" max="100" value="40"
                  oninput="document.getElementById('bval-cli-trickFreq').textContent=this.value">
                <div class="flex flex-between fs-xs text-muted mt-2"><span>Raramente</span><span>Constantemente</span></div>
              </div>
            </div>
          </div>

          <!-- TAB: AGENDA (Nova) -->
          <div class="modal-tab-content" id="ctabcontent-agenda" style="display:none">

            <!-- Arquétipo Comportamental -->
            <div class="config-section" style="margin-bottom:var(--sp-5)">
              <div class="config-section-header" style="margin-bottom:var(--sp-3)">
                <div class="config-section-icon purple">🎭</div>
                <div>
                  <div class="config-section-title">Arquétipo Comportamental</div>
                  <div class="config-section-desc">Personalidade dominante que muda o tom completo da conversa</div>
                </div>
              </div>
              <div class="archetype-grid">
                ${Object.entries(AIEngine.ARCHETYPES).map(([key, def]) => `
                  <div class="archetype-card" data-archetype="${key}" onclick="Manager.selectArchetype('${key}')">
                    <div class="archetype-emoji">${{
                      desconfiado:'🕵️', pragmatico:'⚡', ansioso:'😰', tecnico:'🔬',
                      sarcastico:'😏', apressado:'💨', detalhista:'🔎', emocional:'❤️',
                      sonhador:'✨', autoritario:'👔', humilde:'🙏', comparador:'⚖️'
                    }[key]||'🎭'}</div>
                    <div class="archetype-name">${def.label}</div>
                  </div>
                `).join('')}
                <div class="archetype-card archetype-none" data-archetype="" onclick="Manager.selectArchetype('')">
                  <div class="archetype-emoji">🚫</div>
                  <div class="archetype-name">Nenhum</div>
                </div>
              </div>
            </div>



            <!-- Modo Mercado Hostil -->
            <div style="margin-bottom:var(--sp-5)">
              <label class="toggle-group" style="padding:var(--sp-4);background:rgba(255,71,87,0.06);border-radius:var(--r-md);border:1px solid rgba(255,71,87,0.2);gap:var(--sp-3)">
                <label class="toggle">
                  <input type="checkbox" id="cli-hostileMode" class="cli-toggle">
                  <span class="toggle-track"></span>
                  <span class="toggle-thumb"></span>
                </label>
                <div>
                  <div style="font-size:0.88rem;font-weight:700;color:var(--danger)">🔥 Modo Mercado Hostil</div>
                  <div class="text-muted fs-xs">Cliente compara concorrentes, pressiona desconto, questiona ROI e levanta dúvida interna</div>
                </div>
              </label>
              <div class="form-group" style="margin-top:var(--sp-3)">
                <label class="form-label">Concorrentes Mencionados (Enter para adicionar)</label>
                <div class="tags-container" id="cli-competitors-container" onclick="this.querySelector('.tags-input').focus()">
                  <input type="text" class="tags-input" placeholder="Ex: Salesforce, HubSpot..." onkeydown="Manager.handleTagInput(event,'cli-competitors')">
                </div>
              </div>
            </div>

            <!-- Restrições de Sessão -->
            <div>
              <div class="form-label" style="margin-bottom:var(--sp-3)">⚡ Restrições de Sessão</div>
              <div class="comm-toggles-grid">
                ${[
                  ['cli-extremeHaste', 'extremeHaste', '⚡', 'Pressa Extrema', 'Timer 2x mais rápido, cliente impaciente'],
                  ['cli-shortSession', 'shortSession', '⏱', 'Sessão Curta', 'Máximo de 10 mensagens do vendedor'],
                  ['cli-interruptions', 'interruptions', '📣', 'Com Interrupções', 'Cliente interrompe aleatoriamente'],
                  ['cli-longResistance','longResistance', '🧱', 'Resistência Longa', 'Cliente resiste por mais tempo antes de ceder'],
                ].map(([id, key, icon, title, desc]) => `
                  <label class="toggle-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
                    <label class="toggle">
                      <input type="checkbox" id="${id}" class="cli-toggle">
                      <span class="toggle-track"></span>
                      <span class="toggle-thumb"></span>
                    </label>
                    <div>
                      <div style="font-size:0.85rem;font-weight:600">${icon} ${title}</div>
                      <div class="text-muted fs-xs">${desc}</div>
                    </div>
                  </label>
                `).join('')}
              </div>
            </div>
          </div>

          <!-- Footer buttons -->
          <div class="flex gap-3" style="margin-top:var(--sp-6);justify-content:flex-end;border-top:1px solid var(--border-subtle);padding-top:var(--sp-5)">
            <button class="btn btn-ghost" onclick="Manager.closeClientModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="Manager.saveClient()">💾 Salvar Cliente</button>
          </div>
        </div>
      </div>
    `;
  }

  function openClientModal(id) {
    editingClientId = id || null;
    clientModalTab = 'perfil';
    const modal = document.getElementById('client-modal');
    const title = document.getElementById('client-modal-title');
    if (!modal) return;

    // Reset tab
    switchClientTab('perfil');

    if (id) {
      const client = Storage.getClients().find(c => c.id === id);
      if (client) {
        title.textContent = 'Editar Cliente';
        setVal('cli-name', client.name);
        setVal('cli-emoji', client.emoji || '👨‍💼');
        setVal('cli-gender', client.gender || '');
        setVal('cli-voice', client.voice || '');
        setVal('cli-difficulty', client.difficulty || 'medium');
        setVal('cli-description', client.description || '');
        setVal('cli-customBehavior', client.customBehavior || '');
        setSlider('cli-humanidade', 'cval-humanidade', client.humanidade ?? 50);
        setSlider('cli-formalidade', 'cval-formalidade', client.formalidade ?? 70);
        setSlider('cli-nivelErros', 'cval-nivelErros', client.nivelErros ?? 10);
        setSlider('cli-nivelGirias', 'cval-nivelGirias', client.nivelGirias ?? 20);
        setSlider('cli-emotividade', 'cval-emotividade', client.emotividade ?? 40);
        setSlider('cli-objetividade', 'cval-objetividade', client.objetividade ?? 60);
        setVal('cli-sotaqueRegiao', client.sotaqueRegiao || 'neutro');
        setVal('cli-velocidadeResposta', client.velocidadeResposta || 'normal');
        setVal('cli-nivelTecnico', String(client.nivelTecnico || 35));
        setCheck('cli-usaAbreviacoes', !!client.usaAbreviacoes);
        setCheck('cli-usaMaiusculas', !!client.usaMaiusculas);
        setCheck('cli-usaEmojis', !!client.usaEmojis);
        setCheck('cli-fazPerguntas', client.fazPerguntas !== false);
        setSlider('cli-skepticism', 'bval-cli-skepticism', client.skepticism ?? 60);
        setSlider('cli-urgency', 'bval-cli-urgency', client.urgency ?? 40);
        setSlider('cli-priceSensitivity', 'bval-cli-priceSensitivity', client.priceSensitivity ?? 65);
        setSlider('cli-productKnowledge', 'bval-cli-productKnowledge', client.productKnowledge ?? 35);
        setSlider('cli-negotiationWill', 'bval-cli-negotiationWill', client.negotiationWill ?? 50);
        setSlider('cli-trickFrequency', 'bval-cli-trickFreq', client.trickFrequency ?? 40);
        document.querySelectorAll('.cli-trick-check').forEach(cb => {
          cb.checked = (client.trickTypes || []).includes(cb.value);
        });
        document.querySelectorAll('.cli-seller-check').forEach(cb => {
          cb.checked = (client.vendedoresAtribuidos || []).includes(cb.value);
        });
        // NEW: Agenda tab
        selectArchetype(client.archetype || '');
        setVal('cli-marketSegment', client.marketSegment || 'generico');
        setVal('cli-hiddenAgenda', client.hiddenAgenda || '');
        setCheck('cli-hostileMode', !!client.hostileMode);
        setCheck('cli-extremeHaste', !!client.sessionConstraints?.extremeHaste);
        setCheck('cli-shortSession', !!client.sessionConstraints?.shortSession);
        setCheck('cli-interruptions', !!client.sessionConstraints?.interruptions);
        setCheck('cli-longResistance', !!client.sessionConstraints?.longResistance);
        // Competitors tags
        const cc = document.getElementById('cli-competitors-container');
        if (cc) {
          cc.querySelectorAll('.tag').forEach(t => t.remove());
          const inp = cc.querySelector('.tags-input');
          (client.hostileCompetitors || []).forEach(comp => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.cssText = 'background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)';
            tag.innerHTML = `${escHtml(comp)}<span class="tag-remove" onclick="Manager.removeTag(this,'cli-competitors')">\u00d7</span>`;
            cc.insertBefore(tag, inp);
          });
        }
      }
    } else {
      title.textContent = 'Novo Cliente';
      setVal('cli-name', ''); setVal('cli-emoji', '👨‍💼');
      setVal('cli-gender', ''); setVal('cli-voice', '');
      setVal('cli-difficulty', 'medium');
      setVal('cli-description', '');
      setVal('cli-customBehavior', '');
      setSlider('cli-humanidade', 'cval-humanidade', 50);
      setSlider('cli-formalidade', 'cval-formalidade', 70);
      setSlider('cli-nivelErros', 'cval-nivelErros', 10);
      setSlider('cli-nivelGirias', 'cval-nivelGirias', 20);
      setSlider('cli-emotividade', 'cval-emotividade', 40);
      setSlider('cli-objetividade', 'cval-objetividade', 60);
      setVal('cli-sotaqueRegiao', 'neutro');
      setVal('cli-velocidadeResposta', 'normal');
      setVal('cli-nivelTecnico', '35');
      setCheck('cli-usaAbreviacoes', false); setCheck('cli-usaMaiusculas', false);
      setCheck('cli-usaEmojis', false); setCheck('cli-fazPerguntas', true);
      setSlider('cli-skepticism', 'bval-cli-skepticism', 60);
      setSlider('cli-urgency', 'bval-cli-urgency', 40);
      setSlider('cli-priceSensitivity', 'bval-cli-priceSensitivity', 65);
      setSlider('cli-productKnowledge', 'bval-cli-productKnowledge', 35);
      setSlider('cli-negotiationWill', 'bval-cli-negotiationWill', 50);
      setSlider('cli-trickFrequency', 'bval-cli-trickFreq', 40);
      document.querySelectorAll('.cli-trick-check').forEach(cb => cb.checked = ['price','competitor','authority','doubt'].includes(cb.value));
      document.querySelectorAll('.cli-seller-check').forEach(cb => cb.checked = false);
    }

    modal.classList.add('active');
  }

  function switchClientTab(tab) {
    clientModalTab = tab;
    ['perfil', 'comunicacao', 'comportamento', 'agenda'].forEach(t => {
      const tabEl = document.getElementById(`ctab-${t}`);
      const contentEl = document.getElementById(`ctabcontent-${t}`);
      if (tabEl) tabEl.classList.toggle('active', t === tab);
      if (contentEl) contentEl.style.display = t === tab ? '' : 'none';
    });
  }

  function closeClientModal() {
    stopVoicePreview();
    document.getElementById('client-modal')?.classList.remove('active');
  }

  function stopVoicePreview() {
    if (previewAudio) {
      try { previewAudio.pause(); previewAudio.src = ''; } catch (e) {}
      previewAudio = null;
    }
  }

  async function saveClient() {
    const name = document.getElementById('cli-name')?.value.trim();
    if (!name) { UI.toast('Informe o nome do cliente.', 'error'); return; }

    const trickTypes = Array.from(document.querySelectorAll('.cli-trick-check:checked')).map(c => c.value);
    const competitors = getTagValues('cli-competitors-container');

    const data = {
      name,
      emoji:               document.getElementById('cli-emoji')?.value?.trim() || '👨‍💼',
      gender:              document.getElementById('cli-gender')?.value || null,
      voice:               document.getElementById('cli-voice')?.value || null,
      difficulty:          document.getElementById('cli-difficulty')?.value || 'medium',
      description:         document.getElementById('cli-description')?.value?.trim() || '',
      humanidade:          parseInt(document.getElementById('cli-humanidade')?.value || 50),
      formalidade:         parseInt(document.getElementById('cli-formalidade')?.value || 70),
      nivelErros:          parseInt(document.getElementById('cli-nivelErros')?.value || 10),
      nivelGirias:         parseInt(document.getElementById('cli-nivelGirias')?.value || 20),
      emotividade:         parseInt(document.getElementById('cli-emotividade')?.value || 40),
      objetividade:        parseInt(document.getElementById('cli-objetividade')?.value || 60),
      sotaqueRegiao:       document.getElementById('cli-sotaqueRegiao')?.value || 'neutro',
      velocidadeResposta:  document.getElementById('cli-velocidadeResposta')?.value || 'normal',
      nivelTecnico:        parseInt(document.getElementById('cli-nivelTecnico')?.value || 35),
      usaAbreviacoes:      document.getElementById('cli-usaAbreviacoes')?.checked || false,
      usaMaiusculas:       document.getElementById('cli-usaMaiusculas')?.checked || false,
      usaEmojis:           document.getElementById('cli-usaEmojis')?.checked || false,
      fazPerguntas:        document.getElementById('cli-fazPerguntas')?.checked ?? true,
      skepticism:          parseInt(document.getElementById('cli-skepticism')?.value || 60),
      urgency:             parseInt(document.getElementById('cli-urgency')?.value || 40),
      priceSensitivity:    parseInt(document.getElementById('cli-priceSensitivity')?.value || 65),
      productKnowledge:    parseInt(document.getElementById('cli-productKnowledge')?.value || 35),
      negotiationWill:     parseInt(document.getElementById('cli-negotiationWill')?.value || 50),
      trickFrequency:      parseInt(document.getElementById('cli-trickFrequency')?.value || 40),
      trickTypes,
      // New fields
      archetype:           document.querySelector('.archetype-card.selected')?.dataset?.archetype || null,
      hiddenAgenda:        document.getElementById('cli-hiddenAgenda')?.value || null,
      marketSegment:       document.getElementById('cli-marketSegment')?.value || 'generico',
      hostileMode:         document.getElementById('cli-hostileMode')?.checked || false,
      hostileCompetitors:  competitors,
      sessionConstraints: {
        extremeHaste: document.getElementById('cli-extremeHaste')?.checked || false,
        shortSession:  document.getElementById('cli-shortSession')?.checked || false,
        interruptions: document.getElementById('cli-interruptions')?.checked || false,
        longResistance:document.getElementById('cli-longResistance')?.checked || false,
      },
      customBehavior: document.getElementById('cli-customBehavior')?.value?.trim() || '',
    };

    try {
      if (editingClientId) {
        await Storage.updateClient(editingClientId, data);
        UI.toast('✅ Cliente atualizado!', 'success');
      } else {
        await Storage.addClient(data);
        UI.toast('✅ Cliente criado!', 'success');
      }
      closeClientModal();
      renderClientsSection(document.getElementById('manager-content'));
    } catch (e) {
      UI.toast('Erro ao salvar cliente', 'error');
    }
  }

  // ── Prévia da voz do cliente-bot (TTS) ──
  // Vozes premium do Realtime (marin/cedar) não existem na API de TTS:
  // a prévia usa a voz aproximada do catálogo e avisa o gestor.
  let previewAudio = null;
  async function previewClientVoice() {
    const btn = document.getElementById('cli-voice-preview-btn');
    const apiKey = Storage.getConfig().openaiKey || (Storage.getSettings() || {}).openaiKey;
    if (!apiKey) { UI.toast('Configure a chave da OpenAI em Configurações para ouvir a prévia.', 'warning'); return; }

    stopVoicePreview();

    const gender = document.getElementById('cli-gender')?.value || '';
    let voiceId = document.getElementById('cli-voice')?.value || '';
    if (!voiceId) voiceId = gender === 'male' ? 'cedar' : 'marin'; // automática: melhor voz por gênero
    const cat = (AIEngine.VOICE_CATALOG || []).find(v => v.id === voiceId) || {};
    const ttsVoice = cat.previewVoice || voiceId;
    const approx = !!cat.previewVoice;

    const name = document.getElementById('cli-name')?.value?.trim() || 'este cliente';
    const sample = gender === 'female' || cat.gender === 'female'
      ? `Alô, bom dia! Aqui é ${name === 'este cliente' ? 'a cliente do treinamento' : name}. É assim que eu vou soar nas ligações com os seus vendedores, tá bom?`
      : `Alô, bom dia! Aqui é ${name === 'este cliente' ? 'o cliente do treinamento' : name}. É assim que eu vou soar nas ligações com os seus vendedores, tá bom?`;

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice: ttsVoice,
          input: sample,
          instructions: 'Fale em português brasileiro, tom natural de ligação telefônica comercial.',
          response_format: 'mp3',
        }),
      });
      if (!res.ok) throw new Error('TTS_' + res.status);
      const blob = await res.blob();
      previewAudio = new Audio(URL.createObjectURL(blob));
      previewAudio.play().catch(() => {});
      if (approx) UI.toast(`Prévia aproximada — na ligação real a voz será ${cat.name} (ainda mais natural).`, 'info');
    } catch (e) {
      UI.toast('Não foi possível gerar a prévia da voz. Verifique a chave da OpenAI.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '▶ Prévia'; }
    }
  }

  async function deleteClient(id) {
    if (!confirm('Excluir este cliente? Esta ação é irreversível.')) return;
    try {
      await Storage.removeClient(id);
      UI.toast('Cliente excluído.', 'info');
      renderClientsSection(document.getElementById('manager-content'));
    } catch (e) {
      UI.toast('Erro ao excluir cliente', 'error');
    }
  }

  let assigningClientId = null;
  async function openAssignModal(clientId) {
    assigningClientId = clientId;
    const client = Storage.getClients().find(c => c.id === clientId);
    const modal = document.getElementById('assign-modal');
    const body = document.getElementById('assign-modal-body');
    if (!modal || !body || !client) return;

    modal.classList.add('active');
    body.innerHTML = '<div class="flex" style="justify-content:center;padding:2rem"><div class="spinner"></div></div>';

    try {
      let sellers = [];
      if (API.isBackendEnabled()) {
        const users = await API.request('/api/users');
        sellers = users.filter(u => u.role === 'seller');
      } else {
        sellers = Storage.getSellers();
      }

      const currentUser = Auth.getUser();
      if (currentUser?.role === 'manager') {
        sellers = sellers.filter(s => s.manager_id === currentUser.id || s.managerId === currentUser.id);
      }

      body.innerHTML = `
        <div style="margin-bottom:var(--sp-4)">
          <div style="font-size:0.92rem;color:var(--text-secondary)">Atribuindo <strong>${escHtml(client.emoji)} ${escHtml(client.name)}</strong> aos vendedores:</div>
        </div>
        <div class="flex flex-col gap-3">
          ${sellers.length === 0
            ? '<div class="text-muted">Nenhum vendedor cadastrado.</div>'
            : sellers.map(s => `
              <label class="toggle-group" style="padding:var(--sp-4);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
                <label class="toggle">
                  <input type="checkbox" value="${s.id}" class="assign-seller-check" ${(client.vendedoresAtribuidos || []).includes(s.id) ? 'checked' : ''}>
                  <span class="toggle-track"></span>
                  <span class="toggle-thumb"></span>
                </label>
                <div class="avatar" style="width:32px;height:32px;font-size:0.9rem">${s.avatar_emoji || s.avatar || (s.name ? s.name[0] : '👤')}</div>
                <div>
                  <div style="font-weight:600">${escHtml(s.name)}</div>
                  <div class="text-muted fs-xs">${escHtml(s.email)}</div>
                </div>
              </label>
            `).join('')
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = '<div class="text-error">Erro ao carregar vendedores.</div>';
    }
  }

  function closeAssignModal() {
    document.getElementById('assign-modal')?.classList.remove('active');
    assigningClientId = null;
  }

  async function saveAssignment() {
    if (!assigningClientId) return;
    const checked = Array.from(document.querySelectorAll('.assign-seller-check:checked')).map(c => c.value);
    try {
      await Storage.updateClient(assigningClientId, { vendedoresAtribuidos: checked });
      UI.toast('✅ Atribuição salva!', 'success');
      closeAssignModal();
      renderClientsSection(document.getElementById('manager-content'));
    } catch (e) {
      UI.toast('Erro ao salvar atribuição', 'error');
    }
  }

  // Helper setters
  function setVal(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  function setSlider(sliderId, valId, value) {
    const sl = document.getElementById(sliderId);
    const vl = document.getElementById(valId);
    if (sl) sl.value = value;
    if (vl) vl.textContent = value;
  }
  function setCheck(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = value;
  }

  // ══════════════════════════════════════
  // MANAGERS SECTION (superadmin only)
  // ══════════════════════════════════════
  let editingManagerId = null;

  async function renderManagersSection(container) {
    const currentUser = Auth.getUser();
    if (currentUser?.role !== 'superadmin') {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🚫</div><div class="empty-state-title">Acesso Negado</div><div class="empty-state-desc">Apenas super administradores podem gerenciar gestores.</div></div>`;
      return;
    }

    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;

    try {
      const users = await API.request('/api/users');
      const managers = users.filter(u => u.role === 'manager');

      container.innerHTML = `
        <div class="flex flex-between mb-6">
          <div class="text-secondary" style="font-size:0.88rem">${managers.length} gestor${managers.length !== 1 ? 'es' : ''} cadastrado${managers.length !== 1 ? 's' : ''}</div>
          <button class="btn btn-primary" onclick="Manager.openManagerModal()">+ Novo Gestor</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          ${managers.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">👑</div>
              <div class="empty-state-title">Nenhum gestor cadastrado</div>
              <div class="empty-state-desc">Adicione gestores para gerenciar equipes de vendedores</div>
              <button class="btn btn-primary" onclick="Manager.openManagerModal()">+ Adicionar Gestor</button>
            </div>
          ` : `
            <table class="seller-table">
              <thead>
                <tr>
                  <th>Gestor</th>
                  <th>E-mail</th>
                  <th>Status</th>
                  <th>Cadastrado em</th>
                  <th>Último login</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                ${managers.map(mgr => `
                  <tr>
                    <td>
                      <div class="flex gap-3" style="align-items:center">
                        <div class="avatar" style="width:32px;height:32px;font-size:0.9rem">${mgr.avatar_emoji || mgr.name[0]}</div>
                        <div>
                          <div style="font-weight:600;color:var(--text-primary)">${escHtml(mgr.name)}</div>
                        </div>
                      </div>
                    </td>
                    <td>${escHtml(mgr.email)}</td>
                    <td><span class="badge ${mgr.status === 'active' ? 'badge-success' : 'badge-danger'}">${mgr.status === 'active' ? 'Ativo' : 'Suspenso'}</span></td>
                    <td class="text-muted">${mgr.created_at ? new Date(mgr.created_at).toLocaleDateString('pt-BR') : '—'}</td>
                    <td class="text-muted">${mgr.last_login_at ? new Date(mgr.last_login_at).toLocaleDateString('pt-BR') : 'Nunca'}</td>
                    <td>
                      <div class="flex gap-2">
                        <button class="btn btn-sm btn-ghost" onclick="Manager.toggleManagerStatus('${mgr.id}', '${mgr.status}')" title="${mgr.status === 'active' ? 'Suspender' : 'Ativar'}">${mgr.status === 'active' ? '⏸️' : '▶️'}</button>
                        <button class="btn btn-sm btn-ghost" onclick="Manager.deleteManager('${mgr.id}')" title="Remover">🗑️</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `}
        </div>

        <!-- Manager Modal -->
        <div class="modal-overlay" id="manager-modal">
          <div class="modal">
            <h3 style="margin-bottom:var(--sp-6)" id="manager-modal-title">Novo Gestor</h3>
            <div class="flex flex-col gap-4">
              <div class="form-group">
                <label class="form-label">Nome Completo</label>
                <input type="text" class="form-input" id="manager-name" placeholder="Ex: Maria Souza">
              </div>
              <div class="form-group">
                <label class="form-label">E-mail (usado no login)</label>
                <input type="email" class="form-input" id="manager-email" placeholder="maria@empresa.com">
              </div>
              <div class="form-group">
                <label class="form-label">Senha</label>
                <input type="password" class="form-input" id="manager-password" placeholder="Mínimo 6 caracteres">
              </div>
              <div class="form-group">
                <label class="form-label">Avatar (emoji)</label>
                <input type="text" class="form-input" id="manager-avatar" placeholder="👩‍💼" style="font-size:1.5rem;text-align:center">
              </div>
              <div class="flex gap-3" style="margin-top:var(--sp-2);justify-content:flex-end">
                <button class="btn btn-ghost" onclick="Manager.closeManagerModal()">Cancelar</button>
                <button class="btn btn-primary" onclick="Manager.saveManager()">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      console.error('[MANAGERS]', err);
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Erro ao carregar gestores</div><div class="empty-state-desc">${escHtml(err.message)}</div></div>`;
    }
  }

  function openManagerModal() {
    editingManagerId = null;
    const modal = document.getElementById('manager-modal');
    if (!modal) return;
    document.getElementById('manager-modal-title').textContent = 'Novo Gestor';
    document.getElementById('manager-name').value = '';
    document.getElementById('manager-email').value = '';
    document.getElementById('manager-password').value = '';
    document.getElementById('manager-avatar').value = '';
    modal.classList.add('active');
  }

  function closeManagerModal() {
    document.getElementById('manager-modal')?.classList.remove('active');
  }

  async function saveManager() {
    const name     = document.getElementById('manager-name').value.trim();
    const email    = document.getElementById('manager-email').value.trim();
    const password = document.getElementById('manager-password').value;
    const avatar_emoji = document.getElementById('manager-avatar').value.trim() || '👩‍💼';

    if (!name || !email || !password) { UI.toast('Preencha todos os campos.', 'error'); return; }
    if (password.length < 6) { UI.toast('Senha deve ter mínimo 6 caracteres.', 'error'); return; }

    try {
      await API.request('/api/users', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, role: 'manager', avatar_emoji }),
      });
      UI.toast('Gestor cadastrado com sucesso! 👑', 'success');
      closeManagerModal();
      renderManagersSection(document.getElementById('manager-content'));
    } catch (err) {
      UI.toast(err.message || 'Erro ao criar gestor.', 'error');
    }
  }

  async function toggleManagerStatus(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    const msg = newStatus === 'suspended' ? 'Suspender este gestor?' : 'Reativar este gestor?';
    if (!confirm(msg)) return;

    try {
      await API.request(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      UI.toast(newStatus === 'suspended' ? 'Gestor suspenso.' : 'Gestor reativado.', 'info');
      renderManagersSection(document.getElementById('manager-content'));
    } catch (err) {
      UI.toast(err.message || 'Erro ao atualizar gestor.', 'error');
    }
  }

  async function deleteManager(id) {
    if (!confirm('Remover este gestor permanentemente?')) return;

    try {
      await API.request(`/api/users/${id}`, { method: 'DELETE' });
      UI.toast('Gestor removido.', 'info');
      renderManagersSection(document.getElementById('manager-content'));
    } catch (err) {
      UI.toast(err.message || 'Erro ao remover gestor.', 'error');
    }
  }

  // ══════════════════════════════════════
  // SELLERS SECTION
  // ══════════════════════════════════════
  async function renderSellersSection(container) {
    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;
    
    let sellers = [];
    try {
      if (API.isBackendEnabled()) {
        try {
          const users = await API.request('/api/users');
          sellers = users.filter(u => u.role === 'seller');
        } catch (e) {
          sellers = Storage.getSellers();
        }
      } else {
        sellers = Storage.getSellers();
      }
    } catch (e) {
      sellers = Storage.getSellers();
    }

    const currentUser = Auth.getUser();
    if (currentUser?.role === 'manager') {
      sellers = sellers.filter(u => String(u.managerId) === String(currentUser.id) || String(u.manager_id) === String(currentUser.id));
    }
    const sessions = Storage.getSessions(); // Pode ser migrado depois

    try {
      container.innerHTML = `
        <div class="flex flex-between mb-6">
          <div class="text-secondary" style="font-size:0.88rem">${sellers.length} vendedor${sellers.length !== 1 ? 'es' : ''} cadastrado${sellers.length !== 1 ? 's' : ''}</div>
          <button class="btn btn-primary" onclick="Manager.openSellerModal()">+ Novo Vendedor</button>
        </div>
        <div class="card" style="padding:0;overflow:hidden">
          ${sellers.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">👤</div>
              <div class="empty-state-title">Nenhum vendedor cadastrado</div>
              <div class="empty-state-desc">Adicione vendedores para que possam acessar o treinamento</div>
              <button class="btn btn-primary" onclick="Manager.openSellerModal()">+ Adicionar Vendedor</button>
            </div>
          ` : `
            <table class="seller-table">
              <thead>
                <tr>
                  <th>Vendedor</th>
                  <th>E-mail</th>
                  <th>Sessões</th>
                  <th>Média</th>
                  <th>Última Sessão</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                ${sellers.map(seller => {
                  const selSessions = sessions.filter(s => s.sellerId === seller.id);
                  const avgScore = selSessions.length
                    ? Math.round(selSessions.reduce((s,ss) => s + (ss.result?.total||0), 0) / selSessions.length)
                    : null;
                  const lastSession = selSessions[0];
                  return `
                    <tr>
                      <td>
                        <div class="flex gap-3" style="align-items:center">
                          <div class="avatar" style="width:32px;height:32px;font-size:0.9rem">${seller.avatar_emoji || seller.name[0]}</div>
                          <div>
                            <div style="font-weight:600;color:var(--text-primary)">${escHtml(seller.name)}</div>
                          </div>
                        </div>
                      </td>
                      <td>${escHtml(seller.email)}</td>
                      <td><span class="badge badge-accent">${selSessions.length}</span></td>
                      <td>${avgScore !== null ? `<span style="font-weight:700;color:${ScoringEngine.getScoreColor(avgScore)}">${avgScore}</span>` : '<span class="text-muted">—</span>'}</td>
                      <td class="text-muted">${lastSession ? formatDate(lastSession.createdAt) : '—'}</td>
                      <td>
                        <div class="flex gap-2">
                          <button class="btn btn-sm btn-ghost" onclick="Manager.editSeller('${seller.id}')">✏️</button>
                          <button class="btn btn-sm btn-ghost" onclick="Manager.deleteSeller('${seller.id}')">🗑️</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </div>

        <!-- Seller Modal -->
        <div class="modal-overlay" id="seller-modal">
          <div class="modal">
            <h3 style="margin-bottom:var(--sp-6)" id="seller-modal-title">Novo Vendedor</h3>
            <div class="flex flex-col gap-4">
              <div class="form-group">
                <label class="form-label">Nome Completo</label>
                <input type="text" class="form-input" id="seller-name" placeholder="Ex: João Silva">
              </div>
              <div class="form-group">
                <label class="form-label">E-mail (usado no login)</label>
                <input type="email" class="form-input" id="seller-email" placeholder="joao@empresa.com">
              </div>
              <div class="form-group">
                <label class="form-label">Senha</label>
                <input type="password" class="form-input" id="seller-password" placeholder="Mínimo 6 caracteres">
              </div>
              <div class="form-group" id="seller-manager-group" style="display:none">
                <label class="form-label">Gestor Responsável</label>
                <select class="form-input" id="seller-manager-id">
                  <option value="">Nenhum (Livre)</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Avatar (emoji)</label>
                <input type="text" class="form-input" id="seller-avatar" placeholder="👨‍💼" style="font-size:1.5rem;text-align:center">
              </div>
              <div class="flex gap-3" style="margin-top:var(--sp-2);justify-content:flex-end">
                <button class="btn btn-ghost" onclick="Manager.closeSellerModal()">Cancelar</button>
                <button class="btn btn-primary" onclick="Manager.saveSeller()">Salvar</button>
              </div>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      console.error('[SELLERS]', err);
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Erro ao carregar vendedores</div><div class="empty-state-desc">${escHtml(err.message)}</div></div>`;
    }
  }

  async function openSellerModal(id) {
    editingSellerId = id || null;
    const modal = document.getElementById('seller-modal');
    const title = document.getElementById('seller-modal-title');
    const currentUser = Auth.getUser();
    if (!modal) return;

    try {
      // Se for superadmin, busca a lista de gestores
      if (currentUser?.role === 'superadmin') {
        const users = await API.request('/api/users');
        const managers = users.filter(u => u.role === 'manager');
        const mgrSelect = document.getElementById('seller-manager-id');
        mgrSelect.innerHTML = '<option value="">Nenhum (Livre)</option>' + 
          managers.map(m => `<option value="${m.id}">${escHtml(m.name)}</option>`).join('');
        document.getElementById('seller-manager-group').style.display = 'block';
      } else {
        document.getElementById('seller-manager-group').style.display = 'none';
      }

      if (id) {
        const users = await API.request('/api/users');
        const seller = users.find(s => s.id === id);
        if (seller) {
          title.textContent = 'Editar Vendedor';
          document.getElementById('seller-name').value = seller.name;
          document.getElementById('seller-email').value = seller.email;
          document.getElementById('seller-password').value = ''; // não preenche senha existente
          document.getElementById('seller-avatar').value = seller.avatar_emoji || '👤';
          if (currentUser?.role === 'superadmin') {
            document.getElementById('seller-manager-id').value = seller.manager_id || '';
          }
        }
      } else {
        title.textContent = 'Novo Vendedor';
        document.getElementById('seller-name').value = '';
        document.getElementById('seller-email').value = '';
        document.getElementById('seller-password').value = '';
        document.getElementById('seller-avatar').value = '';
        if (currentUser?.role === 'superadmin') {
          document.getElementById('seller-manager-id').value = '';
        }
      }

      modal.classList.add('active');
    } catch(err) {
      UI.toast('Erro ao abrir modal.', 'error');
    }
  }

  function editSeller(id)         { openSellerModal(id); }
  function closeSellerModal()     { document.getElementById('seller-modal')?.classList.remove('active'); }

  async function saveSeller() {
    const name     = document.getElementById('seller-name').value.trim();
    const email    = document.getElementById('seller-email').value.trim();
    const password = document.getElementById('seller-password').value;
    const avatar_emoji = document.getElementById('seller-avatar').value.trim() || '👤';
    const currentUser = Auth.getUser();
    
    let manager_id = null;
    if (currentUser?.role === 'superadmin') {
      manager_id = document.getElementById('seller-manager-id').value || null;
    } else if (currentUser?.role === 'manager') {
      manager_id = currentUser.id;
    }

    if (!name || !email) { UI.toast('Preencha nome e email.', 'error'); return; }
    if (!editingSellerId && password.length < 6) { UI.toast('Senha deve ter mínimo 6 caracteres.', 'error'); return; }

    const btn = document.querySelector('#seller-modal .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
      if (editingSellerId) {
        const payload = { name, email, avatar_emoji, manager_id };
        if (password && password.length >= 6) payload.password = password;
        await API.request(`/api/users/${editingSellerId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        UI.toast('✅ Vendedor atualizado!', 'success');
      } else {
        await API.request('/api/users', {
          method: 'POST',
          body: JSON.stringify({ name, email, password, role: 'seller', avatar_emoji, manager_id })
        });
        UI.toast('✅ Vendedor cadastrado!', 'success');
      }
      // Refresh cache
      const users = await API.request('/api/users');
      if (users) {
        Storage._refreshSellers(users.filter(u => u.role === 'seller'));
      }
      closeSellerModal();
      renderSellersSection(document.getElementById('manager-content'));
    } catch (err) {
      console.error('[SAVE SELLER]', err);
      UI.toast(err.message || 'Erro ao salvar vendedor. Verifique os dados e tente novamente.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
    }
  }

  async function deleteSeller(id) {
    if (!confirm('Remover este vendedor?')) return;
    try {
      await API.request(`/api/users/${id}`, { method: 'DELETE' });
      UI.toast('Vendedor removido.', 'info');
      renderSellersSection(document.getElementById('manager-content'));
    } catch (err) {
      UI.toast(err.message || 'Erro ao remover vendedor.', 'error');
    }
  }


  // ══════════════════════════════════════
  // PRODUCTS SECTION
  // ══════════════════════════════════════
  let editingProductId = null;
  let productModalTab  = 'perfil';

  async function renderProductsSection(container) {
    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;
    const products = Storage.getProducts();
    const clients  = Storage.getClients();
    const sellers  = await fetchSellersForUI();

    container.innerHTML = `
      <div class="flex flex-between mb-6">
        <div class="text-secondary fs-sm">${products.length} produto${products.length !== 1 ? 's' : ''} cadastrado${products.length !== 1 ? 's' : ''}</div>
        <button class="btn btn-primary" onclick="Manager.openProductModal()">+ Novo Produto</button>
      </div>

      ${products.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-icon">📦</div>
          <div class="empty-state-title">Nenhum produto cadastrado</div>
          <div class="empty-state-desc">Cadastre produtos e atribua-os a clientes e vendedores para que apareçam nos treinamentos.</div>
          <button class="btn btn-primary" onclick="Manager.openProductModal()">+ Criar Primeiro Produto</button>
        </div>
      ` : `
        <div class="products-grid">
          ${products.map(p => {
            const clientNames  = clients.filter(c => (p.clientesAtribuidos||[]).includes(c.id)).map(c => c.name);
            const sellerNames  = sellers.filter(s => (p.vendedoresAtribuidos||[]).includes(s.id)).map(s => s.name);
            return `
              <div class="product-card">
                <div class="product-card-header">
                  <div class="flex gap-3" style="align-items:center;flex:1;min-width:0">
                    <div class="product-card-icon">📦</div>
                    <div style="min-width:0">
                      <div class="product-card-name">${escHtml(p.name)}</div>
                      <div class="product-card-category">${escHtml(p.category||'Produto')}</div>
                    </div>
                  </div>
                  <div class="flex gap-2" style="flex-shrink:0">
                    <button class="btn btn-sm btn-ghost" onclick="Manager.openProductModal('${p.id}')">✏️</button>
                    <button class="btn btn-sm btn-ghost" onclick="Manager.deleteProduct('${p.id}')">🗑️</button>
                  </div>
                </div>
                <div class="product-card-price">${escHtml(p.price||'—')}</div>
                ${p.description ? `<div class="product-card-desc">${escHtml(p.description)}</div>` : ''}

              </div>
            `;
          }).join('')}
        </div>
      `}

      <!-- Product Modal -->
      <div class="modal-overlay" id="product-modal" style="z-index:1000">
        <div class="modal" style="max-width:680px">
          <div class="flex flex-between" style="margin-bottom:var(--sp-4)">
            <h3 id="product-modal-title">Novo Produto</h3>
            <button class="btn btn-ghost btn-icon" onclick="Manager.closeProductModal()">✕</button>
          </div>

          <!-- Perfil Tab -->
          <div id="ptabcontent-perfil">
            <div class="flex flex-col gap-4">
              <div class="config-grid">
                <div class="form-group">
                  <label class="form-label">Nome do Produto</label>
                  <input type="text" class="form-input" id="prd-name" placeholder="Ex: CRM Pro, Consultoria Mensal...">
                </div>
                <div class="form-group">
                  <label class="form-label">Categoria</label>
                  <select class="form-select" id="prd-category">
                    <option value="Software">💻 Software</option>
                    <option value="SaaS">☁️ SaaS</option>
                    <option value="Hardware">🖥️ Hardware</option>
                    <option value="Consultoria">🤝 Consultoria</option>
                    <option value="Serviço">⚙️ Serviço</option>
                    <option value="Produto Físico">📦 Produto Físico</option>
                    <option value="Financeiro">💰 Financeiro</option>
                    <option value="Educação">📚 Educação</option>
                    <option value="Outro">🔹 Outro</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Preço / Proposta</label>
                  <input type="text" class="form-input" id="prd-price" placeholder="Ex: R$ 1.500/mês">
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Descrição</label>
                <textarea class="form-textarea" id="prd-description" rows="3" placeholder="Descreva o produto, seus diferenciais e proposta de valor..."></textarea>
              </div>
              <div class="form-group">
                <label class="form-label">Benefícios Principais <span class="text-muted fs-xs">(Enter para adicionar)</span></label>
                <div class="tags-container" id="prd-benefits-container" onclick="this.querySelector('.tags-input').focus()">
                  <input type="text" class="tags-input" placeholder="Adicionar benefício..." onkeydown="Manager.handleTagInput(event,'prd-benefits')">
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Objeções Esperadas <span class="text-muted fs-xs">(Enter para adicionar)</span></label>
                <div class="tags-container" id="prd-objections-container" onclick="this.querySelector('.tags-input').focus()">
                  <input type="text" class="tags-input" placeholder="Adicionar objeção..." onkeydown="Manager.handleTagInput(event,'prd-objections')">
                </div>
              </div>
            </div>
          </div>



          <div class="flex gap-3" style="margin-top:var(--sp-6);justify-content:flex-end">
            <button class="btn btn-ghost" onclick="Manager.closeProductModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="Manager.saveProduct()">💾 Salvar Produto</button>
          </div>
        </div>
      </div>
    `;
  }

  async function openProductModal(id) {
    editingProductId = id || null;
    productModalTab  = 'perfil';
    const modal = document.getElementById('product-modal');
    const title = document.getElementById('product-modal-title');
    if (!modal) return;

    modal.classList.add('active');
    switchProductTab('perfil');

    let sellers = [];
    try {
      if (API.isBackendEnabled()) {
        const users = await API.request('/api/users');
        sellers = users.filter(u => u.role === 'seller');
      } else {
        sellers = Storage.getSellers();
      }
    } catch(err) {
      sellers = Storage.getSellers();
    }
    
    // Only show sellers for this manager if current user is manager
    const currentUser = Auth.getUser();
    if (currentUser?.role === 'manager') {
      sellers = sellers.filter(s => s.manager_id === currentUser.id || s.managerId === currentUser.id);
    }

    if (id) {
      const p = Storage.getProducts().find(p => p.id === id);
      if (p) {
        title.textContent = 'Editar Produto';
        setVal('prd-name', p.name);
        setVal('prd-category', p.category || 'Software');
        setVal('prd-price', p.price || '');
        setVal('prd-description', p.description || '');
        // Benefits tags
        const bc = document.getElementById('prd-benefits-container');
        if (bc) {
          const inp = bc.querySelector('.tags-input');
          bc.querySelectorAll('.tag').forEach(t => t.remove());
          (p.benefits||[]).forEach(b => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.cssText = 'background:rgba(108,99,255,0.12);border-color:rgba(108,99,255,0.3);color:var(--accent-light)';
            tag.innerHTML = `${escHtml(b)}<span class="tag-remove" onclick="Manager.removeTag(this,'prd-benefits')">×</span>`;
            bc.insertBefore(tag, inp);
          });
        }
        // Objections tags
        const oc = document.getElementById('prd-objections-container');
        if (oc) {
          const inp = oc.querySelector('.tags-input');
          oc.querySelectorAll('.tag').forEach(t => t.remove());
          (p.objections||[]).forEach(o => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.style.cssText = 'background:rgba(255,71,87,0.12);border-color:rgba(255,71,87,0.3);color:var(--danger)';
            tag.innerHTML = `${escHtml(o)}<span class="tag-remove" onclick="Manager.removeTag(this,'prd-objections')">×</span>`;
            oc.insertBefore(tag, inp);
          });
        }
        // Atribuições
        document.querySelectorAll('.prd-client-check').forEach(cb => { cb.checked = (p.clientesAtribuidos||[]).includes(cb.value); });
      }
    } else {
      title.textContent = 'Novo Produto';
      setVal('prd-name', ''); setVal('prd-category', 'Software'); setVal('prd-price', ''); setVal('prd-description', '');
      document.getElementById('prd-benefits-container')?.querySelectorAll('.tag').forEach(t => t.remove());
      document.getElementById('prd-objections-container')?.querySelectorAll('.tag').forEach(t => t.remove());
      document.querySelectorAll('.prd-client-check').forEach(cb => cb.checked = false);
    }
    
    // Update sellers list in the DOM since we fetched them asynchronously
    const sellersList = document.getElementById('prd-sellers-list');
    if (sellersList) {
      sellersList.innerHTML = sellers.length === 0
        ? '<div class="text-muted fs-sm">Nenhum vendedor cadastrado.</div>'
        : sellers.map(s => `
          <label class="toggle-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);gap:var(--sp-3)">
            <label class="toggle">
              <input type="checkbox" value="${s.id}" class="prd-seller-check">
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
            <div class="avatar" style="width:28px;height:28px;font-size:0.85rem">${s.avatar_emoji || s.avatar || (s.name ? s.name[0] : '👤')}</div>
            <div>
              <div style="font-size:0.82rem;font-weight:600">${escHtml(s.name)}</div>
              <div class="text-muted fs-xs">${escHtml(s.email)}</div>
            </div>
          </label>
        `).join('');
        
      // Re-apply checked state for existing product
      if (id) {
        const p = Storage.getProducts().find(p => p.id === id);
        if (p) {
          document.querySelectorAll('.prd-seller-check').forEach(cb => { cb.checked = (p.vendedoresAtribuidos||[]).includes(cb.value); });
        }
      }
    }
  }

  function switchProductTab(tab) {
    productModalTab = tab;
    ['perfil'].forEach(t => {
      const tabEl     = document.getElementById(`ptab-${t}`);
      const contentEl = document.getElementById(`ptabcontent-${t}`);
      if (tabEl)     tabEl.classList.toggle('active', t === tab);
      if (contentEl) contentEl.style.display = t === tab ? '' : 'none';
    });
  }

  function closeProductModal() {
    document.getElementById('product-modal')?.classList.remove('active');
    editingProductId = null;
  }

  async function saveProduct() {
    const name = document.getElementById('prd-name')?.value.trim();
    if (!name) { UI.toast('Informe o nome do produto.', 'error'); return; }

    const data = {
      name,
      category:            document.getElementById('prd-category')?.value || 'Software',
      price:               document.getElementById('prd-price')?.value.trim() || '',
      description:         document.getElementById('prd-description')?.value.trim() || '',
      benefits:            getTagValues('prd-benefits-container'),
      objections:          getTagValues('prd-objections-container'),
    };

    try {
      if (editingProductId) {
        await Storage.updateProduct(editingProductId, data);
        UI.toast('✅ Produto atualizado!', 'success');
      } else {
        await Storage.addProduct(data);
        UI.toast('✅ Produto criado!', 'success');
      }
      closeProductModal();
      renderProductsSection(document.getElementById('manager-content'));
    } catch(e) {
      UI.toast('Erro ao salvar produto', 'error');
    }
  }

  async function deleteProduct(id) {
    if (!confirm('Excluir este produto? Esta ação é irreversível.')) return;
    try {
      await Storage.removeProduct(id);
      UI.toast('Produto excluído.', 'info');
      renderProductsSection(document.getElementById('manager-content'));
    } catch(e) {
      UI.toast('Erro ao excluir produto', 'error');
    }
  }

  // ══════════════════════════════════════
  // REPORTS SECTION
  // ══════════════════════════════════════
  async function renderReportsSection(container) {
    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;
    
    // Fetch sessions from API for cross-device consistency
    let sessions = [];
    try {
      const apiSessions = await API.request('/api/sessions');
      if (Array.isArray(apiSessions)) {
        sessions = apiSessions;
        // Also merge with local sessions (in-progress ones not yet in DB)
        const local = Storage.getSessions();
        const apiIds = new Set(sessions.map(s => s.id));
        const localOnly = local.filter(s => !apiIds.has(s.id) && s.result);
        sessions = [...sessions, ...localOnly];
      } else {
        sessions = Storage.getSessions();
      }
    } catch(e) {
      console.warn('[REPORTS] API fetch failed, using local sessions', e);
      sessions = Storage.getSessions();
    }

    const sellers  = await fetchSellersForUI();

    const totalSessions = sessions.length;
    const avgScore = totalSessions
      ? Math.round(sessions.reduce((s, ss) => s + (ss.result?.total || ss.score || 0), 0) / totalSessions)
      : 0;
    const convincedRate = totalSessions
      ? Math.round((sessions.filter(s => s.result?.convinced || s.convinced).length / totalSessions) * 100)
      : 0;

    // Last 7 session scores for mini chart
    const last7 = sessions.slice(0, 7).reverse().map(s => s.result?.total || s.score || 0);
    const maxScore = Math.max(...last7, 1);


    container.innerHTML = `
      <div class="flex flex-between mb-4">
        <h3 style="margin: 0">Visão Geral</h3>
      </div>
      <!-- Stats row -->
      <div class="grid-4 grid mb-6">
        <div class="stat-card purple-accent">
          <div class="stat-card-icon">📊</div>
          <div class="stat-card-value">${totalSessions}</div>
          <div class="stat-card-label">Total de Sessões</div>
        </div>
        <div class="stat-card teal-accent">
          <div class="stat-card-icon">⭐</div>
          <div class="stat-card-value" style="color:${ScoringEngine.getScoreColor(avgScore)}">${avgScore}</div>
          <div class="stat-card-label">Média Geral</div>
        </div>
        <div class="stat-card green-accent">
          <div class="stat-card-icon">✅</div>
          <div class="stat-card-value">${convincedRate}%</div>
          <div class="stat-card-label">Taxa de Convencimento</div>
        </div>
        <div class="stat-card orange-accent">
          <div class="stat-card-icon">👥</div>
          <div class="stat-card-value">${sellers.length}</div>
          <div class="stat-card-label">Vendedores Ativos</div>
        </div>
      </div>

      <div class="grid-2 grid mb-6">
        <!-- Mini chart -->
        <div class="chart-container">
          <div class="chart-title">📈 Últimas ${last7.length} Sessões (Pontuação)</div>
          ${last7.length === 0 ? '<div class="empty-state" style="padding:var(--sp-8)"><div class="empty-state-icon">📊</div><div class="empty-state-desc">Nenhuma sessão realizada ainda</div></div>' : `
            <div class="mini-chart">
              ${last7.map((score, i) => `
                <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
                  <div class="mini-bar" style="height:${Math.round((score/maxScore)*90)+10}px;background:${ScoringEngine.getScoreColor(score)};opacity:0.7;border-radius:4px 4px 0 0"></div>
                  <span style="font-size:0.65rem;color:var(--text-muted)">${score}</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- Top sellers -->
        <div class="chart-container">
          <div class="chart-title">🏆 Ranking de Vendedores</div>
          ${sellers.length === 0 ? '<div class="text-muted fs-sm">Nenhum vendedor cadastrado.</div>' :
            sellers.map(seller => {
              const selS = sessions.filter(s => String(s.sellerId || s.seller_id) === String(seller.id || seller._id));
              const avg = selS.length ? Math.round(selS.reduce((a,s) => a+(s.result?.total||0),0)/selS.length) : 0;
              return { seller, avg, count: selS.length };
            })
            .sort((a,b) => b.avg - a.avg)
            .map((item, i) => `
              <div class="session-row" style="cursor:default">
                <div style="font-size:1.2rem;width:24px;text-align:center">${['🥇','🥈','🥉'][i] || (i+1)+'º'}</div>
                <div class="session-info">
                  <div class="session-scenario">${escHtml(item.seller.name)}</div>
                  <div class="session-meta">${item.count} sessão${item.count!==1?'ões':''}</div>
                </div>
                <div class="session-score" style="color:${ScoringEngine.getScoreColor(item.avg)}">${item.avg || '—'}</div>
              </div>
            `).join('')
          }
        </div>
      </div>

      <!-- Session history -->
      <div class="chart-container">
        <div class="chart-title">📋 Histórico de Sessões</div>
        ${sessions.length === 0 ? `
          <div class="empty-state" style="padding:var(--sp-8)">
            <div class="empty-state-icon">📝</div>
            <div class="empty-state-title">Nenhuma sessão registrada</div>
            <div class="empty-state-desc">Quando os vendedores realizarem sessões de treinamento, elas aparecerão aqui.</div>
          </div>
        ` : sessions.slice(0, 20).map(s => {
          const seller = sellers.find(sel => String(sel.id || sel._id) === String(s.sellerId || s.seller_id));
          const badge = ScoringEngine.getBadge(s.result?.total || 0, s.result?.convinced);
          return `
            <div class="session-row" onclick="Manager.viewSessionReport('${s.id}')">
              <div class="session-score" style="color:${ScoringEngine.getScoreColor(s.result?.total||0)}">${s.result?.total || '—'}</div>
              <div class="session-info">
                <div class="session-scenario">${escHtml(s.config?.productName || 'Sessão')} — ${escHtml(s.config?.scenarioIndustry || '')}</div>
                <div class="session-meta">
                  ${seller ? escHtml(seller.name) : 'Vendedor'} • ${formatDate(s.createdAt)} • ${Math.floor((s.durationSeconds||0)/60)}min
                </div>
              </div>
              <div class="session-diff">
                <span class="badge ${s.result?.convinced ? 'badge-success' : 'badge-danger'}">${s.result?.convinced ? '✅ Convenceu' : '❌ Não Convenceu'}</span>
              </div>
              <span class="badge badge-muted" style="color:${badge.color}">${badge.emoji} ${badge.label}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ══════════════════════════════════════
  // SETTINGS SECTION
  // ══════════════════════════════════════
  // ══════════════════════════════════════
  // LIVE COACH SECTION — paginado, com busca (ranking + relatórios + coach)
  // ══════════════════════════════════════
  const LC_PAGE_SIZE = 5;
  let lcData = null;      // cache da seção: { sellers, profiles, calls, kdocs }
  let lcPage = 1;
  let lcSearch = '';
  let lcContainer = null;
  let kCoachTargetId = 'junior'; // coach que recebe os próximos uploads de metodologia
  let kPollTimer = null;         // acompanha docs em processamento

  async function renderLiveCoachSection(container) {
    lcContainer = container;
    container.innerHTML = `<div class="flex" style="justify-content:center;padding:3rem"><div class="spinner"></div></div>`;

    let sellers = [];
    let profiles = [];
    let calls = [];
    try {
      const users = (await API.request('/api/users')) || [];
      sellers = users.filter(u => u.role === 'seller');
    } catch (e) { sellers = Storage.getSellers(); }
    try { profiles = (await API.listLiveProfiles()) || []; } catch (e) { console.warn(e); }
    try { calls = (await API.listLiveCalls()) || []; } catch (e) { console.warn(e); }
    let kdocs = [];
    try { kdocs = (await API.listKnowledgeDocs()) || []; } catch (e) { console.warn(e); }

    lcData = { sellers, profiles, calls, kdocs };
    lcPage = 1;
    lcSearch = '';
    paintLiveCoach();
  }

  function lcSetPage(p) {
    lcPage = p;
    paintLiveCoach();
    document.getElementById('lc-cards-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function lcSearchInput(el) {
    lcSearch = el.value;
    lcPage = 1;
    paintLiveCoach();
    const inp = document.getElementById('lc-search');
    if (inp) { inp.focus(); const v = inp.value; inp.setSelectionRange(v.length, v.length); }
  }

  function paintLiveCoach() {
    const container = lcContainer;
    if (!container || !lcData) return;

    const currentUser = Auth.getUser();
    const isSuper = currentUser?.role === 'superadmin';

    const profByUser = {};
    lcData.profiles.forEach(p => { profByUser[p.user_id] = p; });
    const callsByUser = {};
    lcData.calls.forEach(c => { (callsByUser[c.user_id] = callsByUser[c.user_id] || []).push(c); });

    // Ranking: chamadas reais analisadas; desempate por pontos fortes
    let ranked = lcData.sellers.map(s => {
      const p = profByUser[s.id];
      const prof = p?.profile || {};
      return {
        ...s,
        callsAnalyzed: p?.calls_analyzed || 0,
        trainingsAnalyzed: p?.trainings_analyzed || 0,
        interactions: (p?.calls_analyzed || 0) + (p?.trainings_analyzed || 0),
        strengthsCount: (prof.strengths || []).length,
        weaknessesCount: (prof.weaknesses || []).length,
        hasProfile: !!prof.styleSummary,
      };
    }).sort((a, b) => (b.interactions - a.interactions) || (b.strengthsCount - a.strengthsCount));

    // Busca por nome/e-mail
    const q = lcSearch.trim().toLowerCase();
    const filtered = q
      ? ranked.filter(s => (s.name || '').toLowerCase().includes(q) || (s.email || '').toLowerCase().includes(q))
      : ranked;

    // Paginação
    const totalPages = Math.max(1, Math.ceil(filtered.length / LC_PAGE_SIZE));
    if (lcPage > totalPages) lcPage = totalPages;
    const pageItems = filtered.slice((lcPage - 1) * LC_PAGE_SIZE, lcPage * LC_PAGE_SIZE);

    const medals = ['🥇', '🥈', '🥉'];

    const coachBadge = (s) => {
      const styleOf = (s.coach_id && s.coach_id !== 'junior') ? ranked.find(o => String(o.id) === String(s.coach_id)) : null;
      if (styleOf) {
        return `<div class="coach-badge coach-badge-style" onclick="Manager.openCoachPicker('${s.id}')">
          <img src="img/avatar_generic.svg" alt="">
          <div><div class="cb-name">🧬 Estilo de ${escHtml(styleOf.name)}</div><div class="cb-sub">trocar coach</div></div>
        </div>`;
      }
      // Padrão da ferramenta: Júnior Smarzaro (sem atribuição = Júnior)
      return `<div class="coach-badge coach-badge-junior" onclick="Manager.openCoachPicker('${s.id}')">
        <img src="img/junior.jpg" alt="">
        <div><div class="cb-name">⭐ Júnior Smarzaro</div><div class="cb-sub">${s.coach_id === 'junior' ? 'Coach Master' : 'Coach padrão'} · trocar</div></div>
      </div>`;
    };

    const sellerCard = (s) => {
      const p = profByUser[s.id];
      const prof = p?.profile || {};
      const userCalls = (callsByUser[s.id] || []).slice(0, 4);
      const nCalls = p?.calls_analyzed || 0;
      return `
        <div class="config-section">
          <div class="config-section-header" style="flex-wrap:wrap;gap:var(--sp-3)">
            <div class="config-section-icon teal">${s.avatar_emoji || '🧑'}</div>
            <div style="flex:1;min-width:200px">
              <div class="config-section-title">${escHtml(s.name)}</div>
              <div class="config-section-desc">${escHtml(s.email)} · 🎧 ${nCalls} chamada${nCalls !== 1 ? 's' : ''} · 🎓 ${p?.trainings_analyzed || 0} treino${(p?.trainings_analyzed || 0) !== 1 ? 's' : ''}${p?.updated_at ? ` · perfil atualizado ${new Date(p.updated_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}` : ''}</div>
            </div>
            <div>
              <label class="form-label" style="font-size:0.68rem">🎓 Coach deste vendedor</label>
              ${coachBadge(s)}
            </div>
          </div>
          ${prof.styleSummary ? `
            <div style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--sp-4);margin-bottom:var(--sp-4)">
              <div class="fw-600 fs-sm mb-2" style="color:var(--accent-light)">🧠 Relatório do estilo de venda</div>
              <p style="font-size:0.88rem;line-height:1.65;margin:0">${escHtml(prof.styleSummary)}</p>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:var(--sp-4)">
              ${(prof.strengths || []).length ? `<div><div class="fw-600 fs-sm mb-2" style="color:var(--success)">💪 Pontos fortes</div>${prof.strengths.map(x => `<div class="fs-xs text-secondary" style="padding:3px 0;line-height:1.5">✓ ${escHtml(x)}</div>`).join('')}</div>` : ''}
              ${(prof.weaknesses || []).length ? `<div><div class="fw-600 fs-sm mb-2" style="color:var(--warning)">🎯 Pontos a melhorar</div>${prof.weaknesses.map(x => `<div class="fs-xs text-secondary" style="padding:3px 0;line-height:1.5">△ ${escHtml(x)}</div>`).join('')}</div>` : ''}
              ${(prof.languageVices || []).length ? `<div><div class="fw-600 fs-sm mb-2" style="color:var(--danger)">🗣 Vícios de linguagem</div>${prof.languageVices.map(x => `<div class="fs-xs text-secondary" style="padding:3px 0;line-height:1.5">• ${escHtml(x)}</div>`).join('')}</div>` : ''}
              ${(prof.evolutionNotes || []).length ? `<div><div class="fw-600 fs-sm mb-2" style="color:#00d4aa">📈 Evolução</div>${prof.evolutionNotes.map(x => `<div class="fs-xs text-secondary" style="padding:3px 0;line-height:1.5">↗ ${escHtml(x)}</div>`).join('')}</div>` : ''}
              ${(prof.recommendations || []).length ? `<div><div class="fw-600 fs-sm mb-2" style="color:var(--accent-light)">💡 Recomendações do coach</div>${prof.recommendations.map(x => `<div class="fs-xs text-secondary" style="padding:3px 0;line-height:1.5">→ ${escHtml(x)}</div>`).join('')}</div>` : ''}
            </div>
          ` : `<p class="text-muted fs-sm" style="margin:0">Ainda sem chamadas analisadas — o relatório completo (estilo, trejeitos, pontos fortes e fracos) aparece após a primeira chamada real com o Live Coach.</p>`}
          ${userCalls.length ? `
            <div class="fw-600 fs-sm" style="margin:var(--sp-4) 0 var(--sp-2)">📞 Últimas chamadas</div>
            ${userCalls.map(c => `
              <div style="padding:var(--sp-2) var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle);margin-bottom:6px">
                <div class="fs-xs text-muted">${new Date(c.started_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${c.segments || 0} falas · ${c.tip_count || 0} dicas${c.briefing?.industryLabel ? ` · ${escHtml(c.briefing.industryLabel)}` : ''}${c.ended_at ? '' : ' · ⏳ em andamento'}</div>
                ${(c.briefing?.products || []).length ? `<div class="fs-xs" style="margin-top:2px;color:var(--teal, #00d4aa)">📦 ${c.briefing.products.map(p => escHtml(p.name)).join(' · ')}</div>` : ''}
                ${c.summary ? `<div class="fs-xs text-secondary" style="margin-top:3px;line-height:1.5">${escHtml(c.summary)}</div>` : ''}
              </div>
            `).join('')}
          ` : ''}
        </div>
      `;
    };

    const pager = totalPages > 1 ? `
      <div style="display:flex;gap:6px;justify-content:center;align-items:center;margin-top:var(--sp-4);flex-wrap:wrap">
        <button class="btn btn-sm btn-ghost" ${lcPage <= 1 ? 'disabled' : ''} onclick="Manager.lcSetPage(${lcPage - 1})">‹ Anterior</button>
        ${Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => `
          <button class="btn btn-sm ${pg === lcPage ? 'btn-primary' : 'btn-ghost'}" onclick="Manager.lcSetPage(${pg})" style="min-width:38px">${pg}</button>
        `).join('')}
        <button class="btn btn-sm btn-ghost" ${lcPage >= totalPages ? 'disabled' : ''} onclick="Manager.lcSetPage(${lcPage + 1})">Próximo ›</button>
      </div>` : '';

    // ── Metodologia dos coaches (documentos que alimentam as dicas) ──
    const kdocs = lcData.kdocs || [];
    const baseDocs = kdocs.filter(d => !d.manager_id);
    const myDocs = kdocs.filter(d => d.manager_id);
    const baseChunks = baseDocs.reduce((a, d) => a + (d.chunk_count || 0), 0);
    const coachTargets = ranked.filter(s => s.hasProfile);
    const kStatusChip = (d) => {
      if (d.status === 'processing') return `<span style="color:var(--warning);font-size:0.72rem">⏳ processando…</span>`;
      if (d.status === 'error') return `<span style="color:var(--danger);font-size:0.72rem" title="${escHtml(d.error || '')}">⚠️ erro no processamento</span>`;
      return `<span style="color:var(--success);font-size:0.72rem">✅ ${d.chunk_count || 0} trechos</span>`;
    };
    const kCoachLabel = (d) => d.coach_id === 'junior' ? '⭐ Júnior (padrão)' : `🧬 Estilo de ${escHtml(d.coach_name || 'colega')}`;
    const knowledgeSection = `
      <div class="config-section" style="border-color:rgba(255,200,50,0.25)">
        <div class="config-section-header" style="flex-wrap:wrap;gap:var(--sp-3)">
          <div class="config-section-icon purple">📚</div>
          <div style="flex:1;min-width:220px">
            <div class="config-section-title">Metodologia dos coaches</div>
            <div class="config-section-desc">Suba PDFs, imagens ou textos com metodologia de vendas — o material vira conhecimento do coach escolhido e passa a alimentar as dicas ao vivo. A metodologia oficial do ⭐ Júnior é a base de todos e nunca é descartada: o que você enviar entra como complemento.</div>
          </div>
        </div>
        <div class="flex gap-3 flex-wrap" style="align-items:center;margin-bottom:var(--sp-4)">
          <div>
            <label class="form-label" style="font-size:0.68rem">Adicionar ao coach</label>
            <select id="k-coach-target" class="form-select" style="min-width:230px" onchange="Manager.kSetCoachTarget(this.value)">
              <option value="junior"${kCoachTargetId === 'junior' ? ' selected' : ''}>⭐ Júnior Smarzaro (padrão)</option>
              ${coachTargets.map(s => `<option value="${s.id}"${String(kCoachTargetId) === String(s.id) ? ' selected' : ''}>🧬 Estilo de ${escHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <label class="btn btn-primary" style="cursor:pointer;margin-top:14px">📤 Enviar arquivos
            <input type="file" multiple accept=".pdf,.txt,.md,.csv,image/png,image/jpeg,image/webp,image/gif" style="display:none" onchange="Manager.kUploadFiles(this)">
          </label>
        </div>
        <div style="background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--r-md);padding:var(--sp-3) var(--sp-4);margin-bottom:${myDocs.length ? 'var(--sp-3)' : '0'}">
          <details>
            <summary style="cursor:pointer;font-size:0.85rem;font-weight:600;color:#ffd76a">⭐ Base oficial do Júnior — ${baseDocs.length} documento${baseDocs.length !== 1 ? 's' : ''} · ${baseChunks} trechos indexados</summary>
            <div style="margin-top:var(--sp-2)">
              ${baseDocs.map(d => `<div class="fs-xs text-secondary" style="padding:2px 0">📄 ${escHtml(d.filename)} · ${d.chunk_count || 0} trechos</div>`).join('') || '<div class="fs-xs text-muted">Base ainda não ingerida.</div>'}
            </div>
          </details>
        </div>
        ${myDocs.map(d => `
          <div style="display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2) var(--sp-3);background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--r-md);margin-bottom:6px">
            <div style="flex:1;min-width:0">
              <div class="fs-sm" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${escHtml(d.filename)}</div>
              <div class="fs-xs text-muted">${kCoachLabel(d)} · ${new Date(d.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} ${kStatusChip(d)}</div>
            </div>
            <button class="btn btn-sm btn-ghost" title="Excluir documento" onclick="Manager.kDeleteDoc('${d.id}', '${escHtml(d.filename).replace(/'/g, '')}')">🗑</button>
          </div>
        `).join('')}
      </div>`;

    container.innerHTML = `
      <div class="api-config-info mb-6">
        <strong>🎧 Live Coach:</strong> seus vendedores iniciam o assistente durante chamadas reais. A IA transcreve, envia dicas ao vivo moldadas pelo briefing da chamada e aprende o estilo de cada um. O coach padrão de todos é o ⭐ Júnior Smarzaro, com a metodologia oficial dele embarcada — ou atribua o estilo aprendido de um colega da equipe.
      </div>
      ${knowledgeSection}
      ${isSuper ? `
      <div class="config-section" style="border-color:rgba(0,212,170,0.3)">
        <div class="config-section-header">
          <div class="config-section-icon purple">🧪</div>
          <div>
            <div class="config-section-title">Laboratório de Testes <span class="badge badge-teal" style="font-size:0.65rem;margin-left:6px">Gestor Master</span></div>
            <div class="config-section-desc">Valide o Live Coach sozinho: um cliente-robô com voz neural lê um roteiro de vendas em outra aba enquanto você responde como vendedor.</div>
          </div>
        </div>
        <div class="flex gap-3 flex-wrap">
          <button class="btn btn-teal" onclick="window.open('testlab.html','_blank')">🧪 Abrir Simulador de Cliente</button>
          <button class="btn btn-primary" onclick="LiveCoach.open()">🎧 Iniciar Live Coach</button>
        </div>
      </div>
      ` : ''}
      ${ranked.length === 0 ? `
        <div class="card empty-state" style="padding:var(--sp-16)">
          <div class="empty-state-icon" style="font-size:3rem">🎧</div>
          <div class="empty-state-title">Nenhum vendedor na sua equipe ainda</div>
          <div class="empty-state-desc">Cadastre vendedores na aba Vendedores — o ranking e os relatórios do Live Coach deles aparecem aqui.</div>
        </div>
      ` : `
        <div class="config-section" style="border-color:rgba(108,99,255,0.3)">
          <div class="config-section-header">
            <div class="config-section-icon purple">🏆</div>
            <div>
              <div class="config-section-title">Ranking da sua equipe</div>
              <div class="config-section-desc">Top ${Math.min(5, filtered.length)} por chamadas reais analisadas pelo Live Coach</div>
            </div>
          </div>
          ${filtered.slice(0, 5).map((s, i) => `
            <div style="display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3);border-radius:var(--r-md);margin-bottom:6px;background:${i === 0 && s.interactions > 0 ? 'linear-gradient(135deg, rgba(255,200,50,0.08), var(--bg-elevated))' : 'var(--bg-elevated)'};border:1px solid ${i === 0 && s.interactions > 0 ? 'rgba(255,200,50,0.3)' : 'var(--border-subtle)'}">
              <div style="font-size:1.3rem;width:36px;text-align:center">${s.interactions > 0 && medals[i] ? medals[i] : `<span style="font-size:0.85rem;color:var(--text-muted)">${i + 1}º</span>`}</div>
              <div style="flex:1">
                <div class="fw-600" style="font-size:0.9rem">${escHtml(s.name)}${s.coach_id === 'junior' ? ' <span style="color:#ffd76a;font-size:0.7rem">⭐ Júnior Smarzaro</span>' : ''}</div>
                <div class="fs-xs text-muted">🎧 ${s.callsAnalyzed} chamada${s.callsAnalyzed !== 1 ? 's' : ''} real${s.callsAnalyzed !== 1 ? 'is' : ''} · 🎓 ${s.trainingsAnalyzed} treino${s.trainingsAnalyzed !== 1 ? 's' : ''}</div>
              </div>
              ${s.hasProfile ? `
                <span class="badge badge-success" style="font-size:0.65rem">💪 ${s.strengthsCount}</span>
                <span class="badge badge-warning" style="font-size:0.65rem">🎯 ${s.weaknessesCount}</span>
              ` : '<span class="fs-xs text-muted">sem perfil ainda</span>'}
            </div>
          `).join('')}
        </div>

        <div id="lc-cards-top" style="display:flex;gap:10px;align-items:center;margin-bottom:var(--sp-4);flex-wrap:wrap">
          <input id="lc-search" class="form-input" placeholder="🔎 Buscar vendedor por nome ou e-mail..." value="${escHtml(lcSearch)}" oninput="Manager.lcSearchInput(this)" style="max-width:300px">
          <span class="fs-xs text-muted">${filtered.length} vendedor${filtered.length !== 1 ? 'es' : ''}${totalPages > 1 ? ` · página ${lcPage} de ${totalPages}` : ''}</span>
          <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="Manager.refreshSection('livecoach')">↺ Atualizar</button>
        </div>
        ${pageItems.length === 0 ? `<div class="card empty-state" style="padding:var(--sp-10)"><div class="empty-state-desc">Nenhum vendedor encontrado para "${escHtml(lcSearch)}".</div></div>` : pageItems.map(sellerCard).join('')}
        ${pager}
      `}
    `;
  }

  // Atribui o coach escolhido pelo gestor ao vendedor
  // ══════════════════════════════════════
  // COACH PICKER — modal de cards premium (foto + bio) para escolher o
  // coach de cada vendedor: ⭐ Júnior Smarzaro (Coach Master, o PADRÃO da
  // ferramenta) ou o estilo aprendido de qualquer colega da equipe.
  // ══════════════════════════════════════
  let coachPickerSellerId = null;

  function openCoachPicker(sellerId) {
    coachPickerSellerId = sellerId;
    const seller = lcData?.sellers?.find(x => String(x.id) === String(sellerId));
    if (!seller) return;

    const profByUser = {};
    (lcData?.profiles || []).forEach(p => { profByUser[p.user_id] = p; });
    const teammates = (lcData?.sellers || [])
      .filter(o => String(o.id) !== String(sellerId) && profByUser[o.id]?.profile?.styleSummary)
      .map(o => ({ ...o, strengthsCount: (profByUser[o.id]?.profile?.strengths || []).length }));

    const isSel = (id) => String(seller.coach_id || '') === String(id || '');

    let modal = document.getElementById('coach-picker-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'coach-picker-modal';
      modal.className = 'modal-overlay';
      document.body.appendChild(modal);
    }

    modal.innerHTML = `
      <style>
        .cp-modal { max-width: 860px; }
        .cp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; margin-top: var(--sp-5); }
        .cp-card { position: relative; border-radius: 18px; padding: 20px 18px; cursor: pointer; border: 1.5px solid rgba(255,255,255,0.09); background: linear-gradient(160deg, rgba(255,255,255,0.035), rgba(255,255,255,0.01)); transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; text-align: center; }
        .cp-card:hover { transform: translateY(-4px); border-color: rgba(108,99,255,0.4); box-shadow: 0 12px 28px rgba(0,0,0,0.35); }
        .cp-card.cp-selected { border-color: #00d4aa; box-shadow: 0 0 0 2px rgba(0,212,170,0.35), 0 12px 28px rgba(0,0,0,0.35); }
        .cp-card.cp-junior { border-color: rgba(255,200,50,0.45); background: linear-gradient(160deg, rgba(255,200,50,0.09), rgba(255,255,255,0.01)); }
        .cp-card.cp-junior:hover { border-color: rgba(255,200,50,0.85); box-shadow: 0 12px 32px rgba(255,180,30,0.22); }
        .cp-card.cp-junior.cp-selected { border-color: #ffd25c; box-shadow: 0 0 0 2px rgba(255,200,50,0.55), 0 12px 32px rgba(255,180,30,0.25); }
        .cp-check { position: absolute; top: 10px; right: 10px; width: 22px; height: 22px; border-radius: 50%; background: #00d4aa; color: #04140b; display: none; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 900; }
        .cp-junior .cp-check { background: #ffd25c; }
        .cp-selected .cp-check { display: flex; }
        .cp-avatar { width: 76px; height: 76px; border-radius: 50%; object-fit: cover; margin: 0 auto 12px; display: block; border: 2px solid rgba(255,255,255,0.12); background: #14141f; }
        .cp-card.cp-junior .cp-avatar { border-color: rgba(255,200,50,0.7); box-shadow: 0 0 18px rgba(255,200,50,0.3); }
        .cp-card.cp-default .cp-avatar { object-fit: contain; padding: 14px; background: #0d0d18; }
        .cp-badge { display: inline-block; font-size: 0.6rem; font-weight: 800; letter-spacing: 1px; padding: 3px 10px; border-radius: 100px; margin-bottom: 8px; background: linear-gradient(135deg, #ffd25c, #ffa500); color: #2a1a00; }
        .cp-name { font-weight: 800; font-size: 0.95rem; color: #f2f2fa; margin-bottom: 4px; }
        .cp-role { font-size: 0.72rem; color: #8a8aad; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .cp-bio { font-size: 0.78rem; line-height: 1.5; color: #b9b9d0; }
        .cp-stat { font-size: 0.72rem; color: #7dead0; margin-top: 6px; }
      </style>
      <div class="modal cp-modal">
        <div class="flex flex-between" style="margin-bottom:var(--sp-2)">
          <h3>🎓 Escolher Coach — ${escHtml(seller.name)}</h3>
          <button class="btn btn-ghost btn-icon" onclick="Manager.closeCoachPicker()">✕</button>
        </div>
        <p class="text-muted fs-sm" style="margin:0">Todos os coaches seguem as mesmas regras de ouro (conexão antes da venda, munição concreta, foco no produto certo) — a diferença é o estilo e a persona. A metodologia oficial do Júnior é sempre a base; documentos enviados em 📚 Metodologia complementam o coach escolhido.</p>
        <div class="cp-grid">
          <div class="cp-card cp-junior ${isSel('junior') || !seller.coach_id ? 'cp-selected' : ''}" onclick="Manager.selectCoach('junior')">
            <span class="cp-check">✓</span>
            <span class="cp-badge">⭐ COACH MASTER · PADRÃO</span>
            <img class="cp-avatar" src="img/junior.jpg" alt="Júnior Smarzaro">
            <div class="cp-name">Júnior Smarzaro</div>
            <div class="cp-role">Alta Performance Comercial</div>
            <div class="cp-bio">Júnior Smarzaro é um dos maiores especialistas em alta performance comercial do Brasil, reconhecido por transformar equipes comuns em máquinas de vendas por meio de técnicas práticas, mudança de comportamento e execução de excelência. Coach padrão da ferramenta, com toda a metodologia oficial dele embarcada.</div>
          </div>

          ${teammates.map(t => `
            <div class="cp-card ${isSel(t.id) ? 'cp-selected' : ''}" onclick="Manager.selectCoach('${t.id}')">
              <span class="cp-check">✓</span>
              <img class="cp-avatar" src="img/avatar_generic.svg" alt="">
              <div class="cp-name">Estilo de ${escHtml(t.name)}</div>
              <div class="cp-role">Colega de Equipe</div>
              <div class="cp-bio">Coach moldado no perfil de vendas aprendido de ${escHtml(t.name.split(' ')[0])} ao longo de chamadas e treinos reais.</div>
              <div class="cp-stat">💪 ${t.strengthsCount} pontos fortes mapeados</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    modal.classList.add('active');
  }

  function closeCoachPicker() {
    document.getElementById('coach-picker-modal')?.classList.remove('active');
  }

  // ── Metodologia dos coaches: upload e gestão de documentos ──
  function kSetCoachTarget(v) { kCoachTargetId = v || 'junior'; }

  async function kRefreshDocs() {
    if (!lcData) return;
    try { lcData.kdocs = (await API.listKnowledgeDocs()) || []; } catch (e) { return; }
    paintLiveCoach();
    // Docs ainda processando (extração + indexação rodam no servidor): repinta sozinho
    if (kPollTimer) { clearTimeout(kPollTimer); kPollTimer = null; }
    if ((lcData.kdocs || []).some(d => d.status === 'processing')) {
      kPollTimer = setTimeout(kRefreshDocs, 4000);
    }
  }

  async function kUploadFiles(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    let sent = 0;
    for (const f of files) {
      try {
        await API.uploadKnowledgeDoc(f, kCoachTargetId);
        sent++;
      } catch (e) {
        UI.toast(`Erro em ${f.name}: ${e.message}`, 'error');
      }
    }
    if (sent) UI.toast(`📚 ${sent} arquivo${sent !== 1 ? 's' : ''} enviado${sent !== 1 ? 's' : ''} — processando metodologia...`, 'success');
    kRefreshDocs();
  }

  async function kDeleteDoc(id, name) {
    if (!confirm(`Excluir "${name}" da metodologia do coach?`)) return;
    try {
      await API.deleteKnowledgeDoc(id);
      UI.toast('🗑 Documento removido', 'success');
      kRefreshDocs();
    } catch (e) {
      UI.toast('Erro ao excluir documento', 'error');
    }
  }

  async function selectCoach(coachId) {
    const sellerId = coachPickerSellerId;
    if (!sellerId) return;
    try {
      await API.assignCoach(sellerId, coachId || 'junior');
      const cached = lcData?.sellers?.find(x => String(x.id) === String(sellerId));
      if (cached) cached.coach_id = coachId || 'junior';
      UI.toast(coachId === 'junior' ? '⭐ Júnior Smarzaro atribuído como Coach Master!' : '✅ Coach atualizado!', 'success');
      closeCoachPicker();
      paintLiveCoach();
    } catch (e) {
      console.error(e);
      UI.toast('Erro ao atribuir coach', 'error');
    }
  }

  function renderSettingsSection(container) {
    const settings = Storage.getSettings();
    const config = Storage.getConfig();

    container.innerHTML = `
      <!-- API Config -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon purple">🔑</div>
          <div>
            <div class="config-section-title">Configuração da IA</div>
            <div class="config-section-desc">Chave de API e modelo OpenAI</div>
          </div>
        </div>
        <div class="api-config-info mb-6">
          <strong>Como obter sua API Key:</strong> Acesse <a href="https://platform.openai.com/api-keys" target="_blank" style="color:var(--accent)">platform.openai.com/api-keys</a>, crie uma chave de API e cole abaixo. A chave é armazenada localmente e usada para todas as sessões de treinamento.
        </div>
        <div class="config-grid">
          <div class="form-group config-full">
            <label class="form-label">OpenAI API Key</label>
            <input type="password" class="form-input" id="cfg-api-key"
              value="${config.openaiKey || settings.openaiKey || ''}"
              placeholder="sk-proj-... (sua chave de API)">
          </div>
          <div class="form-group">
            <label class="form-label">Modelo de IA</label>
            <select class="form-select" id="cfg-ai-model">
              <option value="gpt-4o-mini" ${(config.openaiModel||'gpt-4o-mini')==='gpt-4o-mini'?'selected':''}>GPT-4o Mini (Rápido e econômico)</option>
              <option value="gpt-4o" ${config.openaiModel==='gpt-4o'?'selected':''}>GPT-4o (Mais inteligente)</option>
              <option value="gpt-4-turbo" ${config.openaiModel==='gpt-4-turbo'?'selected':''}>GPT-4 Turbo</option>
            </select>
          </div>
          <div class="form-group" style="align-self:flex-end">
            <button class="btn btn-teal" onclick="Manager.saveApiSettings()">💾 Salvar API</button>
          </div>
        </div>
      </div>

      <!-- Manager Account -->
      <div class="config-section">
        <div class="config-section-header">
          <div class="config-section-icon teal">👤</div>
          <div>
            <div class="config-section-title">Conta do Gestor</div>
            <div class="config-section-desc">Credenciais de acesso ao painel de gestão</div>
          </div>
        </div>
        <div class="config-grid">
          <div class="form-group">
            <label class="form-label">Nome</label>
            <input type="text" class="form-input" id="mgr-acc-name" value="${escHtml(settings.managerAccount?.name || 'Administrador')}">
          </div>
          <div class="form-group">
            <label class="form-label">E-mail (login)</label>
            <input type="email" class="form-input" id="mgr-acc-email" value="${escHtml(settings.managerAccount?.email || 'admin@empresa.com')}">
          </div>
          <div class="form-group">
            <label class="form-label">Nova Senha</label>
            <input type="password" class="form-input" id="mgr-acc-pass" placeholder="Deixe vazio para não alterar">
          </div>
          <div class="form-group" style="align-self:flex-end">
            <button class="btn btn-primary" onclick="Manager.saveManagerAccount()">💾 Salvar Conta</button>
          </div>
        </div>
      </div>

      <!-- Danger Zone -->
      <div class="config-section" style="border-color:rgba(255,71,87,0.2)">
        <div class="config-section-header">
          <div class="config-section-icon red">⚠️</div>
          <div>
            <div class="config-section-title" style="color:var(--danger)">Zona de Perigo</div>
            <div class="config-section-desc">Ações irreversíveis</div>
          </div>
        </div>
        <div class="flex gap-3 flex-wrap">
          <button class="btn btn-danger" onclick="Manager.clearAllSessions()">🗑️ Limpar Histórico de Sessões</button>
          <button class="btn btn-danger" onclick="Manager.resetAllData()">💣 Resetar Todos os Dados</button>
        </div>
      </div>
    `;
  }

  async function saveApiSettings() {
    const key   = document.getElementById('cfg-api-key')?.value?.trim();
    const model = document.getElementById('cfg-ai-model')?.value || 'gpt-4o-mini';
    const config = Storage.getConfig();
    Storage.setConfig({ ...config, openaiKey: key, openaiModel: model });
    Storage.setSettings({ openaiKey: key, openaiModel: model });
    if (window.API && API.isBackendEnabled() && API.saveAiSettings) {
      try { await API.saveAiSettings(key, model); }
      catch (e) { UI.toast('⚠️ Chave salva localmente, mas falhou ao sincronizar para os vendedores.', 'warning'); return; }
    }
    UI.toast('✅ Configurações de API salvas!', 'success');
  }

  function saveManagerAccount() {
    const name     = document.getElementById('mgr-acc-name').value.trim();
    const email    = document.getElementById('mgr-acc-email').value.trim();
    const password = document.getElementById('mgr-acc-pass').value;
    const settings = Storage.getSettings();

    const updatedMgr = { ...settings.managerAccount, name, email };
    if (password) updatedMgr.password = password;
    Storage.setSettings({ managerAccount: updatedMgr });
    UI.toast('Conta atualizada!', 'success');
  }

  function clearAllSessions() {
    if (!confirm('Limpar todo o histórico de sessões? Esta ação é irreversível.')) return;
    Storage.setSessions([]);
    UI.toast('Histórico limpo.', 'info');
  }

  function resetAllData() {
    if (!confirm('⚠️ ATENÇÃO: Isso apagará TODOS os dados (vendedores, sessões, configurações). Tem certeza?')) return;
    if (!confirm('Última confirmação: apagar tudo?')) return;
    localStorage.clear();
    location.reload();
  }

  // ══════════════════════════════════════
  // ARCHETYPE SELECTOR
  // ══════════════════════════════════════
  function selectArchetype(key) {
    document.querySelectorAll('.archetype-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.archetype === (key || ''));
    });
  }


  // ══════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════
  function generateFakeReports() {
    let sellers = Storage.getSellers ? Storage.getSellers() : [];
    if (sellers.length === 0) {
      sellers = [
        { id: 'sel_fake1', name: 'Ana Souza', email: 'ana@example.com', role: 'seller', createdAt: new Date(Date.now() - 30 * 86400000).toISOString() },
        { id: 'sel_fake2', name: 'Carlos Silva', email: 'carlos@example.com', role: 'seller', createdAt: new Date(Date.now() - 25 * 86400000).toISOString() },
        { id: 'sel_fake3', name: 'Beatriz Costa', email: 'beatriz@example.com', role: 'seller', createdAt: new Date(Date.now() - 20 * 86400000).toISOString() },
        { id: 'sel_fake4', name: 'Rafael Santos', email: 'rafael@example.com', role: 'seller', createdAt: new Date(Date.now() - 15 * 86400000).toISOString() },
        { id: 'sel_fake5', name: 'Juliana Almeida', email: 'juliana@example.com', role: 'seller', createdAt: new Date(Date.now() - 10 * 86400000).toISOString() }
      ];
      if (Storage.setSellers) Storage.setSellers(sellers);
    }
    
    const products = ['Plano Premium SaaS', 'Consultoria Estratégica', 'Licença Corporativa', 'Automação de Vendas', 'Treinamento InCompany'];
    const industries = ['Tecnologia', 'Varejo', 'Saúde', 'Indústria', 'Educação', 'Serviços Financeiros'];
    const names = ['Ricardo Mendes', 'Juliana Costa', 'Marcos Paulo', 'Fernanda Lima', 'Roberto Alves', 'Camila Rocha', 'André Nunes', 'Sofia Martins', 'Lucas Ferreira', 'Patrícia Gomes'];
    
    const badges = [
      { min: 90, level: 'badge-success', emoji: '🏆', label: 'Mestre da Persuasão' },
      { min: 75, level: 'badge-primary', emoji: '⭐', label: 'Ótimo Trabalho' },
      { min: 60, level: 'badge-warning', emoji: '🌱', label: 'Em Desenvolvimento' },
      { min: 0,  level: 'badge-danger',  emoji: '⚠️', label: 'Precisa Melhorar' }
    ];

    const fakeSessions = [];
    const numSessions = 25;
    
    for (let i = 0; i < numSessions; i++) {
      const seller = sellers[Math.floor(Math.random() * sellers.length)];
      const product = products[Math.floor(Math.random() * products.length)];
      const industry = industries[Math.floor(Math.random() * industries.length)];
      const customer = names[Math.floor(Math.random() * names.length)];
      
      const daysAgo = Math.floor(Math.random() * 30);
      const createdAt = new Date(Date.now() - daysAgo * 86400000 - Math.random() * 86400000).toISOString();
      const durationSeconds = Math.floor(Math.random() * 900) + 180; // 3 to 18 mins
      
      const isGood = Math.random() > 0.3; // 70% chance of being a good session
      const discovery = isGood ? Math.floor(Math.random() * 20) + 80 : Math.floor(Math.random() * 40) + 40;
      const handling = isGood ? Math.floor(Math.random() * 20) + 80 : Math.floor(Math.random() * 40) + 40;
      const closing = isGood ? Math.floor(Math.random() * 20) + 80 : Math.floor(Math.random() * 40) + 40;
      
      const total = Math.round((discovery + handling + closing) / 3);
      const convinced = total >= 70 && Math.random() > 0.2; // Mostly convinced if > 70
      const badge = badges.find(b => total >= b.min);

      fakeSessions.push({
        id: 'ses_fake_' + i + '_' + Date.now(),
        sellerId: seller.id,
        createdAt: createdAt,
        durationSeconds: durationSeconds,
        config: { productName: product, customerName: customer, scenarioIndustry: industry },
        result: {
          total: total,
          convinced: convinced,
          badge: { level: badge.level, emoji: badge.emoji, label: badge.label },
          scores: { discovery, handling, closing }
        }
      });
    }
    
    // Sort so recent is first
    fakeSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    fakeSessions.forEach(s => Storage.saveSession(s));
    refreshSection('reports');
    if (window.UI) UI.toast('25 relatórios fictícios gerados com sucesso!', 'success');
  }

  function viewSessionReport(sessionId) {
    const session = Storage.getSessions().find(s => s.id === sessionId);
    if (!session || !session.result) {
      UI.toast('Relatório não encontrado ou incompleto', 'error');
      return;
    }
    
    document.getElementById('page-manager').style.display = 'none';
    document.getElementById('page-results').style.display = 'block';
    
    if (window.Results && typeof window.Results.render === 'function') {
      window.Results.render(session.result, sessionId);
    }
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  return {
    init,
    renderSection,
    refreshSection,
    saveConfig, resetConfig, setDifficulty,
    handleTagInput, removeTag,
    openSellerModal, editSeller, closeSellerModal, saveSeller, deleteSeller,
    openManagerModal, closeManagerModal, saveManager, deleteManager, toggleManagerStatus,
    saveApiSettings, saveManagerAccount, clearAllSessions, resetAllData,
    openClientModal, closeClientModal, saveClient, deleteClient, previewClientVoice,
    switchClientTab,
    openAssignModal, closeAssignModal, saveAssignment,
    openProductModal, closeProductModal, saveProduct, deleteProduct,
    switchProductTab,
    selectArchetype,
    viewSessionReport, generateFakeReports,
    openCoachPicker, closeCoachPicker, selectCoach, lcSetPage, lcSearchInput,
    kSetCoachTarget, kUploadFiles, kDeleteDoc, kRefreshDocs,
  };
})();

window.Manager = Manager;
