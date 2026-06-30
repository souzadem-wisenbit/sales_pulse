// ================================================
// SALESPULSE — Sessões Agendadas (Manager)
// ================================================

const Sessoes = (() => {

  // ══════════════════════════════════════
  // RENDER MAIN SECTION
  // ══════════════════════════════════════
  async function render(container) {
    const scheduled = Storage.getScheduledSessions();

    let sellers = [];
    let clients = [];

    if (API.isBackendEnabled()) {
      try {
        const users = await API.request('/api/users');
        sellers = users.filter(u => u.role === 'seller');
      } catch (e) {
        sellers = Storage.getSellers();
      }
      try {
        clients = await API.request('/api/clients');
      } catch (e) {
        clients = Storage.getClients();
      }
    } else {
      sellers = Storage.getSellers();
      clients = Storage.getClients();
    }

    const pending = scheduled.filter(s => s.status === 'pending');
    const done    = scheduled.filter(s => s.status === 'done');

    container.innerHTML = `
      <div class="section-header">
        <div>
          <h2 class="section-title">📅 Sessões Agendadas</h2>
          <p class="section-subtitle">Crie e gerencie sessões de treinamento individuais para cada vendedor</p>
        </div>
        <button class="btn btn-primary" onclick="Sessoes.openCreateModal()">
          ＋ Nova Sessão
        </button>
      </div>

      <!-- Stats row -->
      <div class="grid grid-3 mb-6" style="gap:var(--sp-4)">
        <div class="metric-card">
          <div class="metric-icon">⏳</div>
          <div class="metric-content">
            <div class="metric-value">${pending.length}</div>
            <div class="metric-label">Pendentes</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">✅</div>
          <div class="metric-content">
            <div class="metric-value">${done.length}</div>
            <div class="metric-label">Concluídas</div>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">👥</div>
          <div class="metric-content">
            <div class="metric-value">${new Set(scheduled.map(s => s.sellerId)).size}</div>
            <div class="metric-label">Vendedores envolvidos</div>
          </div>
        </div>
      </div>

      <!-- Pending sessions -->
      <div class="card mb-6">
        <div class="flex flex-between mb-4">
          <h3>⏳ Pendentes (${pending.length})</h3>
        </div>
        ${pending.length === 0
          ? `<div style="text-align:center;padding:var(--sp-8);color:var(--text-muted)">
               <div style="font-size:2rem;margin-bottom:var(--sp-3)">📭</div>
               <div>Nenhuma sessão pendente. Crie uma para um vendedor!</div>
             </div>`
          : `<div style="display:flex;flex-direction:column;gap:var(--sp-3)">
               ${pending.map(s => renderSessionCard(s, sellers, clients)).join('')}
             </div>`
        }
      </div>

      <!-- Done sessions -->
      ${done.length > 0 ? `
        <div class="card">
          <div class="flex flex-between mb-4">
            <h3 style="color:var(--text-muted)">✅ Concluídas (${done.length})</h3>
            <button class="btn btn-ghost btn-sm" onclick="Sessoes.clearDone()">Limpar histórico</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:var(--sp-3)">
            ${done.slice(0, 10).map(s => renderSessionCard(s, sellers, clients, true)).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Create/Edit Modal -->
      <div class="modal-overlay" id="sessao-modal">
        <div class="modal" style="max-width:540px">
          <div class="flex flex-between mb-5">
            <h3 id="sessao-modal-title">Nova Sessão de Treinamento</h3>
            <button class="btn btn-ghost btn-icon" onclick="Sessoes.closeModal()">✕</button>
          </div>
          <div id="sessao-modal-body"></div>
        </div>
      </div>
    `;

    updateBadge();
  }

  function renderSessionCard(s, sellers, clients, isDone = false) {
    const seller = sellers.find(v => String(v.id || v._id) === String(s.sellerId || s.seller_id));
    const client = clients.find(c => String(c.id || c._id) === String(s.clientId || s.client_id));
    const sellerName = seller ? seller.name : '(vendedor removido)';
    const clientName = client ? client.name : '(cliente removido)';
    const clientEmoji = client ? (client.emoji || '👤') : '👤';

    const timeLabel = s.responseTimeSec > 0
      ? `⏱ ${Math.floor(s.responseTimeSec / 60)}min para responder`
      : '⏱ Sem limite de tempo';

    const createdAt = new Date(s.createdAt).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    const dueLabel = s.dueAt
      ? `📆 Prazo: ${new Date(s.dueAt).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`
      : '';

    const isOverdue = s.dueAt && new Date(s.dueAt) < new Date() && s.status === 'pending';

    const approachLabel = (s.salesApproach === 'passive')
      ? '💬 Venda Passiva'
      : '📞 Prospecção Ativa';

    return `
      <div class="sessao-card ${isDone ? 'sessao-done' : ''} ${isOverdue ? 'sessao-overdue' : ''}">
        <div class="sessao-card-left">
          <div class="sessao-avatar">${seller ? seller.name[0].toUpperCase() : '?'}</div>
          <div class="sessao-info">
            <div class="sessao-seller-name">${escHtml(sellerName)}</div>
            <div class="sessao-client-row">
              <span>${clientEmoji}</span>
              <span class="sessao-client-name">${escHtml(clientName)}</span>
              ${client ? `<span class="sessao-client-role">${escHtml(client.role || '')} · ${escHtml(client.company || '')}</span>` : ''}
            </div>
            <div class="sessao-meta">
              <span class="sessao-tag">${approachLabel}</span>
              <span class="sessao-tag">${timeLabel}</span>
              ${dueLabel ? `<span class="sessao-tag ${isOverdue ? 'sessao-tag-danger' : ''}">${dueLabel}</span>` : ''}
              ${s.notes ? `<span class="sessao-tag">📝 ${escHtml(s.notes.slice(0,40))}${s.notes.length>40?'...':''}</span>` : ''}
              <span class="sessao-tag" style="color:var(--text-muted)">Criada ${createdAt}</span>
            </div>
          </div>
        </div>
        ${!isDone ? `
          <div class="sessao-actions">
            <button class="btn btn-sm btn-ghost" onclick="Sessoes.notifySeller('${s.id}')" title="Renotificar vendedor">🔔</button>
            <button class="btn btn-sm btn-ghost" onclick="Sessoes.markDone('${s.id}')" title="Marcar como concluída">✅</button>
            <button class="btn btn-sm btn-danger" onclick="Sessoes.deleteSession('${s.id}')" title="Remover">🗑</button>
          </div>
        ` : `
          <div style="font-size:0.78rem;color:var(--success);font-weight:700;flex-shrink:0">✅ Concluída</div>
        `}
      </div>
    `;
  }

  // ══════════════════════════════════════
  // CREATE MODAL
  // ══════════════════════════════════════
  async function openCreateModal() {
    let sellers = [];
    let clients = [];
    
    if (API.isBackendEnabled()) {
      try {
        const users = await API.request('/api/users');
        sellers = users.filter(u => u.role === 'seller');
        try {
          clients = await API.request('/api/clients');
        } catch(e) {
          clients = Storage.getClients();
        }
      } catch (err) {
        sellers = Storage.getSellers();
        clients = Storage.getClients();
      }
    } else {
      sellers = Storage.getSellers();
      clients = Storage.getClients();
    }

    const currentUser = Auth.getUser();
    if (currentUser?.role === 'manager') {
      sellers = sellers.filter(u => String(u.managerId) === String(currentUser.id) || String(u.manager_id) === String(currentUser.id));
    }

    const body = document.getElementById('sessao-modal-body');
    const title = document.getElementById('sessao-modal-title');
    if (!body || !title) return;

    title.textContent = 'Nova Sessão de Treinamento';

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:var(--sp-4)">

        <!-- Vendedor -->
        <div class="form-group">
          <label class="form-label">👤 Vendedor *</label>
          <select class="form-input" id="ss-seller">
            <option value="">— Selecione o vendedor —</option>
            ${sellers.map(s => `<option value="${s.id || s._id}">${escHtml(s.name)} (${escHtml(s.email)})</option>`).join('')}
          </select>
        </div>

        <!-- Cliente -->
        <div class="form-group">
          <label class="form-label">${'👔'} Cliente (Persona) *</label>
          <select class="form-input" id="ss-client">
            <option value="">— Selecione o cliente —</option>
            ${clients.map(c => `<option value="${c.id || c._id}">${c.emoji||'👤'} ${escHtml(c.name)} · ${escHtml(c.company||'')} (${c.difficulty||'medium'})</option>`).join('')}
          </select>
          <span class="form-hint">O vendedor aprenderá que enfrentará este cliente ao entrar no chat.</span>
        </div>

        <!-- Tipo de Abordagem -->
        <div class="form-group">
          <label class="form-label">🎯 Tipo de Abordagem *</label>
          <div style="display:flex;flex-direction:column;gap:8px">
            <label style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--r-md);cursor:pointer">
              <input type="radio" name="ss-approach" value="active" checked style="margin-top:3px">
              <div>
                <div style="font-weight:600">📞 Prospecção Ativa</div>
                <div class="form-hint" style="margin:2px 0 0">O cliente não fala nada no início — o vendedor é quem deve iniciar a abordagem com a primeira mensagem.</div>
              </div>
            </label>
            <label style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--r-md);cursor:pointer">
              <input type="radio" name="ss-approach" value="passive" style="margin-top:3px">
              <div>
                <div style="font-weight:600">💬 Venda Passiva</div>
                <div class="form-hint" style="margin:2px 0 0">O cliente já teve contato prévio com a empresa e envia a primeira mensagem — o vendedor responde e conduz a venda.</div>
              </div>
            </label>
          </div>
        </div>

        <!-- Tempo para responder -->
        <div class="form-group">
          <label class="form-label">⏱ Tempo máximo de resposta por mensagem</label>
          <select class="form-input" id="ss-response-time">
            <option value="0">Sem limite</option>
            <option value="30">30 segundos</option>
            <option value="60">1 minuto</option>
            <option value="90">1:30 min</option>
            <option value="120">2 minutos</option>
            <option value="180">3 minutos</option>
            <option value="300">5 minutos</option>
          </select>
          <span class="form-hint">Tempo que o vendedor tem para digitar cada resposta.</span>
        </div>

        <!-- Prazo para fazer a sessão -->
        <div class="form-group">
          <label class="form-label">📆 Prazo para completar (opcional)</label>
          <input type="datetime-local" class="form-input" id="ss-due-at"
            min="${new Date().toISOString().slice(0,16)}">
          <span class="form-hint">Se não definido, não há prazo automático.</span>
        </div>

        <!-- Observações -->
        <div class="form-group">
          <label class="form-label">📝 Observações para o vendedor (opcional)</label>
          <textarea class="form-input" id="ss-notes" rows="2"
            placeholder="Ex: foque em explorar a dor antes de apresentar o produto..."></textarea>
        </div>

        <!-- Configurações de Visibilidade -->
        <div class="form-group" style="padding:var(--sp-3);background:var(--bg-elevated);border-radius:var(--r-md);border:1px solid var(--border-subtle)">
          <div style="font-weight:600;margin-bottom:var(--sp-2)">Visibilidade para o Vendedor</div>
          
          <label class="toggle-group" style="margin-bottom:var(--sp-2)">
            <label class="toggle">
              <input type="checkbox" id="ss-realtime" checked>
              <span class="toggle-track"></span><span class="toggle-thumb"></span>
            </label>
            <div>Mostrar métricas em tempo real (Raio-X, Convencimento)</div>
          </label>
          
          <label class="toggle-group">
            <label class="toggle">
              <input type="checkbox" id="ss-report" checked>
              <span class="toggle-track"></span><span class="toggle-thumb"></span>
            </label>
            <div>Mostrar relatório final e nota da sessão</div>
          </label>
        </div>

        <div class="flex gap-3 justify-end mt-2">
          <button class="btn btn-ghost" onclick="Sessoes.closeModal()">Cancelar</button>
          <button class="btn btn-primary" onclick="Sessoes.saveSession()">📅 Agendar Sessão</button>
        </div>
      </div>
    `;

    document.getElementById('sessao-modal').classList.add('active');
  }

  function closeModal() {
    document.getElementById('sessao-modal')?.classList.remove('active');
  }

  // ══════════════════════════════════════
  // SAVE
  // ══════════════════════════════════════
  async function saveSession() {
    const sellerId       = document.getElementById('ss-seller')?.value;
    const clientId       = document.getElementById('ss-client')?.value;
    const salesApproach  = document.querySelector('input[name="ss-approach"]:checked')?.value || 'active';
    const responseTimeSec= parseInt(document.getElementById('ss-response-time')?.value || '0');
    const dueAt          = document.getElementById('ss-due-at')?.value;
    const notes          = document.getElementById('ss-notes')?.value?.trim();
    const showRealtime   = document.getElementById('ss-realtime')?.checked ?? true;
    const showReport     = document.getElementById('ss-report')?.checked ?? true;

    if (!sellerId) { UI.toast('Selecione o vendedor.', 'error'); return; }
    if (!clientId) { UI.toast('Selecione o cliente.', 'error'); return; }

    try {
      const created = await Storage.addScheduledSession({
        sellerId,
        clientId,
        salesApproach,
        responseTimeSec,
        dueAt: dueAt || null,
        notes,
        showRealtime,
        showReport
      });

      // Auto-notify (pass the created session ID so the notification links to the right session)
      notifySeller_internal(sellerId, clientId, notes, created?.id);

      closeModal();
      UI.toast('Sessão agendada com sucesso! 📅', 'success');
      Manager.refreshSection('sessoes');
    } catch(e) {
      UI.toast('Erro ao agendar sessão.', 'error');
      console.error(e);
    }
  }

  // ══════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════
  function notifySeller(sessionId) {
    const s = Storage.getScheduledSessions().find(x => x.id === sessionId);
    if (!s) return;
    notifySeller_internal(s.sellerId, s.clientId, s.notes, sessionId);
    Storage.updateScheduledSession(sessionId, { notified: true, notifiedAt: new Date().toISOString() });
    UI.toast('Notificação enviada ao vendedor! 🔔', 'success');
  }

  function notifySeller_internal(sellerId, clientId, notes, scheduledSessionId) {
    // Store notification in a seller-readable key
    const notifKey = 'sbp_notif_' + sellerId;
    const client = Storage.getClients().find(c => c.id === clientId);
    const notifs = JSON.parse(localStorage.getItem(notifKey) || '[]');

    // Resolve sessionId: use the one passed in, or find the latest pending one
    const resolvedSessionId = scheduledSessionId ||
      Storage.getScheduledSessions().find(s => s.sellerId === sellerId && s.clientId === clientId && s.status === 'pending')?.id;

    notifs.unshift({
      id:        'n_' + Date.now(),
      sessionId: resolvedSessionId,  // Link to the actual scheduled session
      clientId,
      clientName: client ? client.name : '(cliente)',
      clientEmoji: client ? (client.emoji || '👤') : '👤',
      notes:     notes || '',
      createdAt: new Date().toISOString(),
      read:      false,
    });
    localStorage.setItem(notifKey, JSON.stringify(notifs.slice(0, 20)));
    if (resolvedSessionId) {
      Storage.updateScheduledSession(resolvedSessionId, { notified: true });
    }
  }

  function markDone(sessionId) {
    Storage.updateScheduledSession(sessionId, { status: 'done', doneAt: new Date().toISOString() });
    UI.toast('Sessão marcada como concluída ✅', 'success');
    Manager.refreshSection('sessoes');
  }

  function deleteSession(sessionId) {
    if (!confirm('Remover esta sessão agendada?')) return;
    Storage.removeScheduledSession(sessionId);
    UI.toast('Sessão removida.', 'info');
    Manager.refreshSection('sessoes');
  }

  function clearDone() {
    if (!confirm('Limpar todo o histórico de sessões concluídas?')) return;
    Storage.setScheduledSessions(Storage.getScheduledSessions().filter(s => s.status !== 'done'));
    UI.toast('Histórico limpo.', 'info');
    Manager.refreshSection('sessoes');
  }

  // ══════════════════════════════════════
  // BADGE COUNT
  // ══════════════════════════════════════
  function updateBadge() {
    const pending = Storage.getScheduledSessions().filter(s => s.status === 'pending').length;
    const badge = document.getElementById('mgr-sessoes-badge');
    if (badge) {
      badge.textContent = pending;
      badge.style.display = pending > 0 ? '' : 'none';
    }
  }

  // ══════════════════════════════════════
  // SELLER NOTIFICATION PANEL (called from Seller.init)
  // ══════════════════════════════════════
  function getSellerNotifications(sellerId) {
    try {
      return JSON.parse(localStorage.getItem('sbp_notif_' + sellerId) || '[]');
    } catch { return []; }
  }

  function markNotificationRead(sellerId, notifId) {
    const key = 'sbp_notif_' + sellerId;
    const notifs = getSellerNotifications(sellerId).map(n =>
      n.id === notifId ? { ...n, read: true } : n
    );
    localStorage.setItem(key, JSON.stringify(notifs));
  }

  function renderSellerNotificationBanner(sellerId) {
    const notifs = getSellerNotifications(sellerId).filter(n => !n.read);
    if (notifs.length === 0) return '';

    return notifs.map(n => `
      <div class="seller-notif-banner" id="notif-${n.id}">
        <span style="font-size:1.3rem">🔔</span>
        <div style="flex:1">
          <div style="font-weight:700;font-size:0.9rem">Sessão agendada pelo seu gestor!</div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:2px">
            Você vai treinar com <strong>${n.clientEmoji} ${escHtml(n.clientName)}</strong>
            ${n.notes ? `· <em>${escHtml(n.notes)}</em>` : ''}
            — Inicie pelo card abaixo.
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="Sessoes.dismissNotif('${sellerId}','${n.id}')" style="align-self:flex-start">✕</button>
      </div>
    `).join('');
  }

  function dismissNotif(sellerId, notifId) {
    markNotificationRead(sellerId, notifId);
    document.getElementById('notif-' + notifId)?.remove();
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return {
    render,
    openCreateModal,
    closeModal,
    saveSession,
    notifySeller,
    markDone,
    deleteSession,
    clearDone,
    updateBadge,
    getSellerNotifications,
    renderSellerNotificationBanner,
    dismissNotif,
  };
})();

window.Sessoes = Sessoes;
