'use strict';
/* SalesPulse Mission Control — frontend (roda dentro da janela Electron). */

// ===== Infra =====
const state = {
  instances: [],
  statuses: {},   // instanceId -> {health, latencyMs, azure}
  view: 'fleet',  // 'fleet' | 'instance'
  instId: null,
  tab: 'overview',
  timers: [],
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.hint = data.hint || null;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function relTime(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 0) return 'agora';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const dd = Math.floor(h / 24);
  if (dd === 1) return 'ontem';
  if (dd < 30) return `há ${dd} dias`;
  return fmtDate(d);
}

function fmtDur(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

function el(id) { return document.getElementById(id); }
const main = () => el('main');

// ===== Sidebar =====
function renderSidebar() {
  el('nav-fleet').className = `nav-item ${state.view === 'fleet' ? 'active' : ''}`;
  el('nav-instances').innerHTML = state.instances.map((inst) => {
    const st = state.statuses[inst.id];
    const cls = !st ? 'unknown' : st.health === 'online' ? 'online' : 'offline';
    const active = state.view === 'instance' && state.instId === inst.id;
    return `
      <div class="nav-item ${active ? 'active' : ''}" onclick="showInstance('${inst.id}')">
        <span class="status ${cls}"><span class="dot"></span></span>
        <span class="co-name">${esc(inst.company)}</span>
      </div>`;
  }).join('') || '<div class="nav-item" style="cursor:default;color:var(--text-3)">nenhuma registrada</div>';
}

// ===== Carregamento base =====
async function loadInstances() {
  state.instances = await api('/instances');
  renderSidebar();
}

async function refreshStatuses() {
  try {
    const list = await api('/fleet/status');
    for (const s of list) state.statuses[s.id] = s;
    renderSidebar();
    if (state.view === 'fleet') renderFleet();
    if (state.view === 'instance') renderInstHeaderStatus();
  } catch (err) { /* az/health fora do ar não derruba a UI */ }
}

// ===== Frota =====
function showFleet() {
  clearTimers();
  state.view = 'fleet';
  state.instId = null;
  renderSidebar();
  renderFleet();
  state.timers.push(setInterval(refreshStatuses, 30000));
  refreshStatuses();
}

function statusLabel(st) {
  if (!st) return '<span class="status unknown"><span class="dot"></span>verificando…</span>';
  if (st.health === 'online') {
    return `<span class="status online"><span class="dot"></span>online · ${st.latencyMs}ms</span>`;
  }
  if (st.health === 'offline') return '<span class="status offline"><span class="dot"></span>offline</span>';
  return `<span class="status warn"><span class="dot"></span>${esc(st.health)}</span>`;
}

function renderFleet() {
  const sts = Object.values(state.statuses);
  const online = sts.filter((s) => s.health === 'online').length;
  const offline = sts.filter((s) => s.health && s.health !== 'online').length;

  main().innerHTML = `
    <div class="view-header">
      <h2>Frota</h2>
      <span class="sub">${state.instances.length} instância(s) · 1 empresa por instância</span>
      <div class="spacer"></div>
      <button class="btn small" onclick="refreshStatuses()">🔄 Atualizar status</button>
    </div>
    <div class="kpi-row">
      <div class="kpi"><div class="label">Instâncias</div><div class="value">${state.instances.length}</div></div>
      <div class="kpi"><div class="label">Online</div><div class="value">${online} <small>de ${state.instances.length}</small></div></div>
      <div class="kpi"><div class="label">Com problema</div><div class="value">${offline}</div></div>
    </div>
    <div class="fleet-grid">
      ${state.instances.map(instCard).join('')}
      <div class="inst-card add" onclick="openProvisionModal()">
        <div style="font-size:22px">➕</div>
        <div>Nova instância (nova empresa)</div>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <h3>Usuários por empresa</h3>
      <div id="fleet-users"><div class="empty">Carregando usuários de todas as instâncias…</div></div>
    </div>`;
  loadFleetUsers();
}

async function loadFleetUsers() {
  try {
    const groups = await api('/fleet/users');
    const box = el('fleet-users');
    if (!box) return;
    if (!groups.length) { box.innerHTML = '<div class="empty">Nenhuma instância registrada.</div>'; return; }
    box.innerHTML = `
      <div class="table-wrap" style="border:none"><table>
        <thead><tr><th>Usuário</th><th>Empresa</th><th>Instância</th><th>Papel</th><th>Status</th><th>Último login</th><th>Sessões</th></tr></thead>
        <tbody>
          ${groups.map((g) => {
            const companyCell = `<span class="prim">🏢 ${esc(g.company)}</span>`;
            const instCell = `<span class="mono">${esc(g.appName || '')}</span>`;
            if (!g.ok) {
              return `<tr><td><span class="status warn"><span class="dot"></span>banco indisponível — ${esc(String(g.error).slice(0, 50))}</span></td>
                <td>${companyCell}</td><td>${instCell}</td><td colspan="4"></td></tr>`;
            }
            if (!g.users.length) {
              return `<tr><td class="muted">nenhum usuário</td><td>${companyCell}</td><td>${instCell}</td><td colspan="4"></td></tr>`;
            }
            return g.users.map((u) => `
              <tr class="clickable" onclick="showInstance('${g.instanceId}', 'users')">
                <td><span class="prim">${esc(u.avatar_emoji || '👤')} ${esc(u.name)}</span> <span class="sec">${esc(u.email)}</span></td>
                <td>${companyCell}</td>
                <td>${instCell}</td>
                <td><span class="badge role-${esc(u.role)}">${roleLabel(u.role)}</span></td>
                <td><span class="badge st-${esc(u.status)}">${u.status === 'active' ? '✓ ativo' : '⏸ ' + esc(u.status)}</span></td>
                <td>${relTime(u.last_login_at)}</td>
                <td>${u.sessions_count}</td>
              </tr>`).join('');
          }).join('')}
        </tbody>
      </table></div>`;
  } catch (err) {
    const box = el('fleet-users');
    if (box) box.innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

function instCard(inst) {
  const st = state.statuses[inst.id];
  const az = st && st.azure && !st.azure.error ? st.azure : null;
  return `
    <div class="inst-card" onclick="showInstance('${inst.id}')">
      <div class="co">${esc(inst.company)} ${statusLabel(st)}</div>
      <div class="app-name">${esc(inst.appName)}</div>
      <div class="meta">
        <span>☁️ ${az ? `${esc(az.state)} · ${esc(az.location)}` : '—'}</span>
        <span>${!inst.hasDb ? '🗄️ sem banco!'
          : st && st.db === 'down' ? '<span class="status warn"><span class="dot"></span>banco fora do ar</span>'
          : st && st.db === 'ok' ? '🗄️ banco ok'
          : '🗄️ ' + esc(inst.dbHost || '')}</span>
      </div>
      <div class="links" onclick="event.stopPropagation()">
        <a class="btn small" href="${esc(inst.url)}" target="_blank">Abrir app ↗</a>
        <a class="btn small" href="${esc(inst.scmUrl)}" target="_blank">Kudu ↗</a>
        <button class="btn small" onclick="showInstance('${inst.id}')">Painel →</button>
      </div>
    </div>`;
}

// ===== Instância =====
function currentInst() {
  return state.instances.find((i) => i.id === state.instId);
}

function showInstance(id, tab) {
  clearTimers();
  state.view = 'instance';
  state.instId = id;
  state.tab = tab || 'overview';
  renderSidebar();
  renderInstanceShell();
  renderTab();
}

function renderInstanceShell() {
  const inst = currentInst();
  if (!inst) return showFleet();
  const TABS = [
    ['overview', '📊 Visão geral'],
    ['company', '🏢 Empresa'],
    ['users', '👥 Usuários'],
    ['clients', '🎭 Clientes'],
    ['products', '📦 Produtos'],
    ['scheduled', '📅 Agendadas'],
    ['sessions', '💬 Conversas'],
    ['livecalls', '🎧 Live Coach'],
    ['logs', '📜 Logs'],
    ['config', '⚙️ Config'],
  ];
  main().innerHTML = `
    <div class="view-header">
      <button class="icon-btn" onclick="showFleet()" title="Voltar">←</button>
      <h2>${esc(inst.company)}</h2>
      <span class="sub mono">${esc(inst.appName)}</span>
      <span id="inst-status">${statusLabel(state.statuses[inst.id])}</span>
      <div class="spacer"></div>
      <a class="btn small" href="${esc(inst.url)}" target="_blank">Abrir app ↗</a>
      <button class="btn small danger" onclick="restartInstance()">⟳ Reiniciar app</button>
    </div>
    <div class="tabs">
      ${TABS.map(([key, label]) =>
        `<div class="tab ${state.tab === key ? 'active' : ''}" onclick="switchTab('${key}')">${label}</div>`).join('')}
    </div>
    <div id="tab-body"><div class="empty">Carregando…</div></div>`;
}

function renderInstHeaderStatus() {
  const node = el('inst-status');
  if (node && state.instId) node.innerHTML = statusLabel(state.statuses[state.instId]);
}

const TABKEYS = ['overview', 'company', 'users', 'clients', 'products', 'scheduled', 'sessions', 'livecalls', 'logs', 'config'];

function switchTab(tab) {
  clearTimers();
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab')[TABKEYS.indexOf(tab)]?.classList.add('active');
  renderTab();
}

function renderTab() {
  const body = el('tab-body');
  if (body) body.innerHTML = '<div class="empty">Carregando…</div>';
  ({
    overview: renderOverview,
    company: renderCompany,
    users: renderUsers,
    clients: renderClients,
    products: renderProducts,
    scheduled: renderScheduled,
    sessions: renderSessions,
    livecalls: renderLiveCalls,
    logs: renderLogs,
    config: renderConfig,
  }[state.tab] || renderOverview)();
}

function tabError(err) {
  const body = el('tab-body');
  if (!body) return;
  const isPaused = /tenant\/user .* not found|Tenant or user not found/i.test(err.message);
  if (isPaused) {
    body.innerHTML = `
      <div class="card" style="max-width:680px;margin:30px auto;text-align:center;border-color:rgba(250,178,25,.4)">
        <div style="font-size:40px;margin-bottom:10px">😴</div>
        <h3 style="text-transform:none;font-size:16px;color:var(--text-1);letter-spacing:0">Banco de dados pausado no Supabase</h3>
        <p style="margin:12px 0;line-height:1.6">O app desta empresa está no ar, mas o projeto Supabase foi
          <b>pausado por inatividade</b> (plano free pausa após ~1 semana sem uso) — por isso logins e dados
          não funcionam agora.</p>
        <p style="margin-bottom:16px;line-height:1.6"><b>Como resolver:</b> abra o dashboard do Supabase,
          entre no projeto e clique em <b>"Restore project"</b> (leva ~2 min). Depois volte aqui.</p>
        <div style="display:flex;gap:10px;justify-content:center">
          <a class="btn primary" href="https://supabase.com/dashboard" target="_blank">Abrir Supabase Dashboard ↗</a>
          <button class="btn" onclick="renderTab()">🔄 Tentar de novo</button>
        </div>
        <p class="muted" style="margin-top:14px;font-size:12px">Para nunca mais pausar: plano Pro, ou me peça
          para configurar um ping diário que mantém o projeto acordado.</p>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div class="error-box">⚠️ ${esc(err.message)}</div>
    ${err.hint ? `<div class="card" style="max-width:720px">💡 ${esc(err.hint)}
      <div style="margin-top:10px"><button class="btn small" onclick="renderTab()">🔄 Tentar de novo</button></div></div>` : ''}`;
}

// ----- Visão geral -----
async function renderOverview() {
  try {
    const ov = await api(`/instances/${state.instId}/overview`);
    const c = ov.counts;
    el('tab-body').innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><div class="label">Usuários</div><div class="value">${c.users_total}</div>
          <div class="hint">${c.managers} gestor(es) · ${c.sellers} vendedor(es)${c.users_inactive ? ` · ${c.users_inactive} inativo(s)` : ''}</div></div>
        <div class="kpi"><div class="label">Online agora</div><div class="value">${ov.online.length}</div>
          <div class="hint">atividade nos últimos 5 min</div></div>
        <div class="kpi"><div class="label">Sessões hoje</div><div class="value">${c.sessions_today} <small>de ${c.sessions_total}</small></div>
          <div class="hint">${c.sessions_open} em andamento</div></div>
        <div class="kpi"><div class="label">Mensagens hoje</div><div class="value">${c.messages_today}</div>
          <div class="hint">${c.messages_total} no total</div></div>
        <div class="kpi"><div class="label">Chamadas reais</div><div class="value">${c.live_calls_active} <small>ativas</small></div>
          <div class="hint">${c.live_calls_total} no histórico</div></div>
        <div class="kpi"><div class="label">Cadastros</div><div class="value">${c.clients_total} <small>clientes</small></div>
          <div class="hint">${c.scenarios_total} cenário(s)</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <h3>Quem está online agora</h3>
          ${ov.online.length ? ov.online.map(personRow).join('') : '<div class="empty">Ninguém ativo nos últimos 5 minutos.</div>'}
          ${ov.users.filter((u) => !u.online).slice(0, 6).map((u) => personRow(u, true)).join('')}
        </div>
        <div class="card">
          <h3>Atividade recente</h3>
          ${ov.feed.length ? ov.feed.map(feedRow).join('') : '<div class="empty">Sem atividade registrada.</div>'}
        </div>
      </div>`;
    state.timers.push(setInterval(() => { if (state.tab === 'overview') renderOverview(); }, 30000));
  } catch (err) { tabError(err); }
}

function personRow(u, offline = false) {
  const doing = u.in_live_call
    ? '<span class="badge doing-call">🎧 em chamada real</span>'
    : u.in_training
      ? '<span class="badge doing-training">💬 em treinamento</span>'
      : (u.online ? '<span class="badge doing-idle">🟢 logado</span>' : '');
  return `
    <div class="person-row" style="${offline ? 'opacity:.5' : ''}">
      <div class="avatar">${esc(u.avatar_emoji || '👤')}</div>
      <div class="who">
        <div class="name">${esc(u.name)} <span class="badge role-${esc(u.role)}">${roleLabel(u.role)}</span></div>
        <div class="detail">${doing}</div>
      </div>
      <time>${relTime(u.last_activity)}</time>
    </div>`;
}

const FEED_META = {
  login: ['🔑', 'entrou no sistema'],
  session_start: ['▶️', 'iniciou um treinamento'],
  session_end: ['🏁', 'concluiu um treinamento'],
  live_call_start: ['🎧', 'entrou em chamada real (Live Coach)'],
  live_call_end: ['⏹️', 'encerrou uma chamada real'],
};

function feedRow(ev) {
  const [ico, verb] = FEED_META[ev.type] || ['•', ev.type];
  const det = ev.detail ? ` <span class="det">— ${esc(String(ev.detail).slice(0, 90))}</span>` : '';
  return `
    <div class="feed-row">
      <div class="ico">${ico}</div>
      <div class="txt"><b>${esc(ev.name || 'Usuário removido')}</b> ${verb}${det}</div>
      <time>${relTime(ev.t)}</time>
    </div>`;
}

function roleLabel(r) {
  return { manager: 'gestor', seller: 'vendedor', superadmin: 'superadmin' }[r] || r;
}

// ----- Usuários -----
let usersCache = [];
async function renderUsers() {
  try {
    usersCache = await api(`/instances/${state.instId}/users`);
    el('tab-body').innerHTML = `
      <div class="toolbar">
        <button class="btn primary" onclick="openUserModal()">➕ Novo usuário</button>
        <span class="muted">${usersCache.length} usuário(s) — todos pertencem exclusivamente a
          <b>${esc(currentInst().company)}</b> (banco isolado desta instância)</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Usuário</th><th>Empresa (instância)</th><th>Papel</th><th>Status</th><th>Gestor</th>
          <th>Sessões</th><th>Chamadas</th><th>Último login</th><th>Criado em</th><th></th>
        </tr></thead>
        <tbody>${usersCache.map(userRow).join('')}</tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

function userRow(u) {
  const inst = currentInst();
  return `
    <tr>
      <td><span class="prim">${esc(u.avatar_emoji || '👤')} ${esc(u.name)}</span><br><span class="sec">${esc(u.email)}</span></td>
      <td>🏢 ${esc(inst.company)}<br><span class="sec mono">${esc(inst.appName)}</span></td>
      <td><span class="badge role-${esc(u.role)}">${roleLabel(u.role)}</span></td>
      <td><span class="badge st-${esc(u.status)}">${u.status === 'active' ? '✓ ativo' : '⏸ ' + esc(u.status)}</span></td>
      <td>${esc(u.manager_name || '—')}</td>
      <td>${u.sessions_count}</td>
      <td>${u.live_calls_count}</td>
      <td>${relTime(u.last_login_at)}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td style="white-space:nowrap">
        <button class="icon-btn" title="Editar" onclick="openUserModal('${u.id}')">✏️</button>
        <button class="icon-btn" title="${u.status === 'active' ? 'Suspender' : 'Reativar'}"
          onclick="toggleUserStatus('${u.id}')">${u.status === 'active' ? '⏸️' : '▶️'}</button>
        <button class="icon-btn" title="Excluir" onclick="removeUser('${u.id}')">🗑️</button>
      </td>
    </tr>`;
}

function openUserModal(userId) {
  const u = userId ? usersCache.find((x) => x.id === userId) : null;
  const managers = usersCache.filter((x) => x.role === 'manager');
  const instInfo = currentInst();
  openModal(`
    <div class="modal-head"><h3>${u ? 'Editar usuário' : 'Novo usuário'}</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="badge" style="margin-bottom:14px">🏢 ${esc(instInfo.company)} · <span class="mono">${esc(instInfo.appName)}</span></div>
      <div id="user-modal-error"></div>
      <div class="field-row">
        <div class="field"><label>Nome</label><input id="uf-name" value="${esc(u?.name || '')}"></div>
        <div class="field"><label>E-mail</label><input id="uf-email" type="email" value="${esc(u?.email || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Papel</label>
          <select id="uf-role">
            <option value="seller" ${u?.role === 'seller' || !u ? 'selected' : ''}>Vendedor</option>
            <option value="manager" ${u?.role === 'manager' ? 'selected' : ''}>Gestor</option>
            <option value="superadmin" ${u?.role === 'superadmin' ? 'selected' : ''}>Superadmin</option>
          </select></div>
        <div class="field"><label>Gestor responsável</label>
          <select id="uf-manager">
            <option value="">— nenhum —</option>
            ${managers.map((m) => `<option value="${m.id}" ${u?.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>${u ? 'Nova senha (deixe vazio p/ manter)' : 'Senha'}</label>
          <input id="uf-password" type="text" placeholder="mín. 6 caracteres"></div>
        <div class="field"><label>Avatar (emoji)</label><input id="uf-avatar" value="${esc(u?.avatar_emoji || '👤')}"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveUser('${u?.id || ''}')">${u ? 'Salvar' : 'Criar usuário'}</button>
    </div>`);
}

async function saveUser(userId) {
  const body = {
    name: el('uf-name').value.trim(),
    email: el('uf-email').value.trim(),
    role: el('uf-role').value,
    manager_id: el('uf-manager').value || null,
    avatar_emoji: el('uf-avatar').value.trim() || '👤',
  };
  const pw = el('uf-password').value;
  if (pw) body.password = pw;
  try {
    if (userId) await api(`/instances/${state.instId}/users/${userId}`, { method: 'PUT', body });
    else await api(`/instances/${state.instId}/users`, { method: 'POST', body });
    closeModal();
    renderUsers();
  } catch (err) {
    el('user-modal-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

async function toggleUserStatus(userId) {
  const u = usersCache.find((x) => x.id === userId);
  const to = u.status === 'active' ? 'suspended' : 'active';
  try {
    await api(`/instances/${state.instId}/users/${userId}`, { method: 'PUT', body: { status: to } });
    renderUsers();
  } catch (err) { alert(err.message); }
}

async function removeUser(userId) {
  const u = usersCache.find((x) => x.id === userId);
  if (!confirm(`Excluir "${u.name}" (${u.email})?\n\nIsso apaga também as sessões e mensagens desse usuário nessa instância. Não tem volta.`)) return;
  try {
    await api(`/instances/${state.instId}/users/${userId}`, { method: 'DELETE' });
    renderUsers();
  } catch (err) { alert(err.message); }
}

// ----- Empresa -----
async function renderCompany() {
  const inst = currentInst();
  let counts = null;
  try { counts = (await api(`/instances/${state.instId}/overview`)).counts; } catch (err) { /* banco fora: mostra só o cadastro */ }
  el('tab-body').innerHTML = `
    <div class="two-col">
      <div class="card">
        <h3>Cadastro da empresa</h3>
        <div id="co-error"></div>
        <div class="field"><label>Nome da empresa</label><input id="co-company" value="${esc(inst.company)}"></div>
        <div class="field-row">
          <div class="field"><label>CNPJ</label><input id="co-cnpj" value="${esc(inst.cnpj || '')}" placeholder="00.000.000/0000-00"></div>
          <div class="field"><label>Contato (nome)</label><input id="co-contact" value="${esc(inst.contactName || '')}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>E-mail do contato</label><input id="co-email" value="${esc(inst.contactEmail || '')}"></div>
          <div class="field"><label>Telefone</label><input id="co-phone" value="${esc(inst.contactPhone || '')}"></div>
        </div>
        <div class="field"><label>Notas</label><textarea id="co-notes" rows="3">${esc(inst.notes || '')}</textarea></div>
        <button class="btn primary" onclick="saveCompany()">💾 Salvar</button>
      </div>
      <div class="card">
        <h3>Instância desta empresa</h3>
        <table>
          <tr><td class="muted">App Service</td><td class="mono">${esc(inst.appName)}</td></tr>
          <tr><td class="muted">URL</td><td><a href="${esc(inst.url)}" target="_blank">${esc(inst.url)}</a></td></tr>
          <tr><td class="muted">Banco (host)</td><td class="mono">${esc(inst.dbHost || '—')}</td></tr>
          <tr><td class="muted">Registrada em</td><td>${fmtDate(inst.createdAt)}</td></tr>
          ${counts ? `
          <tr><td class="muted">Usuários</td><td>${counts.users_total} (${counts.managers} gestor(es), ${counts.sellers} vendedor(es))</td></tr>
          <tr><td class="muted">Clientes (personas)</td><td>${counts.clients_total}</td></tr>
          <tr><td class="muted">Sessões de treino</td><td>${counts.sessions_total}</td></tr>
          <tr><td class="muted">Chamadas reais</td><td>${counts.live_calls_total}</td></tr>` : `
          <tr><td class="muted">Dados do banco</td><td><span class="status warn"><span class="dot"></span>banco indisponível agora</span></td></tr>`}
        </table>
        <p class="muted" style="margin-top:12px;font-size:12px;line-height:1.5">
          🔒 Todos os dados desta empresa (usuários, clientes, produtos, conversas) vivem
          <b>somente</b> nesta instância e neste banco — nenhuma outra empresa tem como acessá-los.
        </p>
      </div>
    </div>`;
}

async function saveCompany() {
  try {
    await api(`/instances/${state.instId}`, {
      method: 'PUT',
      body: {
        company: el('co-company').value.trim(),
        cnpj: el('co-cnpj').value.trim(),
        contactName: el('co-contact').value.trim(),
        contactEmail: el('co-email').value.trim(),
        contactPhone: el('co-phone').value.trim(),
        notes: el('co-notes').value.trim(),
      },
    });
    await loadInstances();
    renderInstanceShell();
    state.tab = 'company';
    switchTab('company');
  } catch (err) {
    el('co-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

// ----- helpers de formulário (checkbox-list e datas) -----
function checkList(idPrefix, items, selectedIds) {
  const sel = new Set(selectedIds || []);
  if (!items.length) return '<div class="muted" style="font-size:12px">— nenhum disponível —</div>';
  return `<div style="max-height:130px;overflow-y:auto;border:1px solid var(--border);border-radius:7px;padding:8px 10px">
    ${items.map((it) => `
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text-2);padding:2px 0;cursor:pointer">
        <input type="checkbox" style="width:auto" class="${idPrefix}-check" value="${esc(it.id)}" ${sel.has(it.id) ? 'checked' : ''}>
        ${esc(it.label)}
      </label>`).join('')}
  </div>`;
}
function checkedValues(idPrefix) {
  return Array.from(document.querySelectorAll(`.${idPrefix}-check:checked`)).map((c) => c.value);
}
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ----- Clientes (personas) -----
let clientsCache = [];
const DIFF_LABEL = { easy: 'fácil', medium: 'médio', hard: 'difícil', extreme: 'extremo' };

async function renderClients() {
  try {
    [clientsCache, usersCache] = await Promise.all([
      api(`/instances/${state.instId}/clients`),
      api(`/instances/${state.instId}/users`),
    ]);
    el('tab-body').innerHTML = `
      <div class="toolbar">
        <button class="btn primary" onclick="openClientModal()">➕ Novo cliente</button>
        <span class="muted">${clientsCache.length} cliente(s)-persona desta empresa</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Cliente</th><th>Dificuldade</th><th>Arquétipo</th><th>Segmento</th>
          <th>Dono (gestor)</th><th>Vendedores</th><th>Agendadas</th><th>Criado</th><th></th>
        </tr></thead>
        <tbody>${clientsCache.map((c) => `
          <tr>
            <td><span class="prim">${esc(c.emoji || '👨‍💼')} ${esc(c.name)}</span>
              ${c.description ? `<br><span class="sec">${esc(String(c.description).slice(0, 60))}</span>` : ''}</td>
            <td><span class="badge">${esc(DIFF_LABEL[c.difficulty] || c.difficulty || '—')}</span></td>
            <td>${esc(c.archetype || '—')}</td>
            <td>${esc(c.market_segment || '—')}</td>
            <td>${esc(c.manager_name || 'global')}</td>
            <td>${(c.vendedores_atribuidos || []).length}</td>
            <td>${c.scheduled_count}</td>
            <td>${fmtDate(c.created_at)}</td>
            <td style="white-space:nowrap">
              <button class="icon-btn" title="Editar" onclick="openClientModal('${esc(c.id)}')">✏️</button>
              <button class="icon-btn" title="Excluir" onclick="removeClient('${esc(c.id)}')">🗑️</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="9"><div class="empty">Nenhum cliente cadastrado.</div></td></tr>'}
        </tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

// Campos "avançados" da persona editados como JSON (o painel cobre o essencial;
// o ajuste fino também existe no app do gestor)
const CLIENT_ADV_FIELDS = ['humanidade', 'formalidade', 'nivel_erros', 'nivel_girias', 'emotividade',
  'objetividade', 'sotaque_regiao', 'velocidade_resposta', 'nivel_tecnico', 'usa_abreviacoes',
  'usa_maiusculas', 'usa_emojis', 'faz_perguntas', 'skepticism', 'urgency', 'price_sensitivity',
  'product_knowledge', 'negotiation_will', 'trick_frequency', 'trick_types', 'hostile_mode',
  'hostile_competitors', 'session_constraints'];

function openClientModal(clientId) {
  const c = clientId ? clientsCache.find((x) => x.id === clientId) : null;
  const managers = usersCache.filter((u) => u.role === 'manager');
  const sellers = usersCache.filter((u) => u.role === 'seller')
    .map((u) => ({ id: u.id, label: `${u.avatar_emoji || '👤'} ${u.name}` }));
  const adv = {};
  for (const f of CLIENT_ADV_FIELDS) adv[f] = c ? c[f] : undefined;
  openModal(`
    <div class="modal-head"><h3>${c ? 'Editar cliente' : 'Novo cliente (persona)'}</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div id="cli-error"></div>
      <div class="field-row">
        <div class="field" style="grid-column:span 2"><label>Nome</label><input id="cf-name" value="${esc(c?.name || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Emoji</label><input id="cf-emoji" value="${esc(c?.emoji || '👨‍💼')}"></div>
        <div class="field"><label>Dificuldade</label>
          <select id="cf-diff">${['easy', 'medium', 'hard', 'extreme'].map((d) =>
            `<option value="${d}" ${(c?.difficulty || 'medium') === d ? 'selected' : ''}>${DIFF_LABEL[d]}</option>`).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Arquétipo</label><input id="cf-arch" value="${esc(c?.archetype || '')}" placeholder="ex: cético analítico"></div>
        <div class="field"><label>Segmento de mercado</label><input id="cf-seg" value="${esc(c?.market_segment || 'generico')}"></div>
      </div>
      <div class="field"><label>Descrição</label><textarea id="cf-desc" rows="2">${esc(c?.description || '')}</textarea></div>
      <div class="field"><label>Agenda oculta</label><textarea id="cf-agenda" rows="2">${esc(c?.hidden_agenda || '')}</textarea></div>
      <div class="field"><label>Comportamento personalizado</label><textarea id="cf-behavior" rows="2">${esc(c?.custom_behavior || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Dono (gestor)</label>
          <select id="cf-manager">
            <option value="">— global (todos os gestores) —</option>
            ${managers.map((m) => `<option value="${m.id}" ${c?.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>Vendedores atribuídos</label>${checkList('cfv', sellers, c?.vendedores_atribuidos)}</div>
      </div>
      <details style="margin-top:6px">
        <summary class="muted" style="cursor:pointer;font-size:12.5px">Personalidade avançada (JSON — sliders, pegadinhas, modo hostil…)</summary>
        <div class="field" style="margin-top:8px">
          <textarea id="cf-adv" rows="8" class="mono">${esc(JSON.stringify(adv, null, 2))}</textarea>
          <div class="help">Edite os valores mantendo o formato JSON. Deixe como está para usar os padrões.</div>
        </div>
      </details>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveClient('${esc(c?.id || '')}')">${c ? 'Salvar' : 'Criar cliente'}</button>
    </div>`, true);
}

async function saveClient(clientId) {
  let advanced = {};
  try {
    advanced = JSON.parse(el('cf-adv').value || '{}');
  } catch (err) {
    el('cli-error').innerHTML = '<div class="error-box">⚠️ O JSON da personalidade avançada é inválido.</div>';
    return;
  }
  for (const k of Object.keys(advanced)) if (advanced[k] === undefined || advanced[k] === null) delete advanced[k];
  const body = {
    ...advanced,
    name: el('cf-name').value.trim(),
    emoji: el('cf-emoji').value.trim() || '👨‍💼',
    difficulty: el('cf-diff').value,
    archetype: el('cf-arch').value.trim() || null,
    market_segment: el('cf-seg').value.trim() || 'generico',
    description: el('cf-desc').value.trim() || null,
    hidden_agenda: el('cf-agenda').value.trim() || null,
    custom_behavior: el('cf-behavior').value.trim() || null,
    manager_id: el('cf-manager').value || null,
    vendedores_atribuidos: checkedValues('cfv'),
  };
  try {
    if (clientId) await api(`/instances/${state.instId}/clients/${clientId}`, { method: 'PUT', body });
    else await api(`/instances/${state.instId}/clients`, { method: 'POST', body });
    closeModal();
    renderClients();
  } catch (err) {
    el('cli-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

async function removeClient(clientId) {
  const c = clientsCache.find((x) => x.id === clientId);
  if (!confirm(`Excluir o cliente "${c.name}"?\n\nSessões agendadas com ele serão apagadas junto (cascade).`)) return;
  try {
    await api(`/instances/${state.instId}/clients/${clientId}`, { method: 'DELETE' });
    renderClients();
  } catch (err) { alert(err.message); }
}

// ----- Produtos -----
let productsCache = [];

async function renderProducts() {
  try {
    [productsCache, clientsCache, usersCache] = await Promise.all([
      api(`/instances/${state.instId}/products`),
      api(`/instances/${state.instId}/clients`),
      api(`/instances/${state.instId}/users`),
    ]);
    el('tab-body').innerHTML = `
      <div class="toolbar">
        <button class="btn primary" onclick="openProductModal()">➕ Novo produto</button>
        <span class="muted">${productsCache.length} produto(s) desta empresa</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Produto</th><th>Preço</th><th>Benefícios</th><th>Objeções</th>
          <th>Clientes</th><th>Vendedores</th><th>Dono (gestor)</th><th>Criado</th><th></th>
        </tr></thead>
        <tbody>${productsCache.map((p) => `
          <tr>
            <td><span class="prim">📦 ${esc(p.name)}</span>
              ${p.description ? `<br><span class="sec">${esc(String(p.description).slice(0, 60))}</span>` : ''}</td>
            <td>${esc(p.price || '—')}</td>
            <td>${(p.benefits || []).length}</td>
            <td>${(p.objections || []).length}</td>
            <td>${(p.clientes_atribuidos || []).length}</td>
            <td>${(p.vendedores_atribuidos || []).length}</td>
            <td>${esc(p.manager_name || 'global')}</td>
            <td>${fmtDate(p.created_at)}</td>
            <td style="white-space:nowrap">
              <button class="icon-btn" title="Editar" onclick="openProductModal('${esc(p.id)}')">✏️</button>
              <button class="icon-btn" title="Excluir" onclick="removeProduct('${esc(p.id)}')">🗑️</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="9"><div class="empty">Nenhum produto cadastrado.</div></td></tr>'}
        </tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

function openProductModal(productId) {
  const p = productId ? productsCache.find((x) => x.id === productId) : null;
  const managers = usersCache.filter((u) => u.role === 'manager');
  const sellers = usersCache.filter((u) => u.role === 'seller')
    .map((u) => ({ id: u.id, label: `${u.avatar_emoji || '👤'} ${u.name}` }));
  const clientOpts = clientsCache.map((c) => ({ id: c.id, label: `${c.emoji || '👨‍💼'} ${c.name}` }));
  openModal(`
    <div class="modal-head"><h3>${p ? 'Editar produto' : 'Novo produto'}</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div id="prod-error"></div>
      <div class="field-row">
        <div class="field"><label>Nome</label><input id="pfr-name" value="${esc(p?.name || '')}"></div>
        <div class="field"><label>Preço</label><input id="pfr-price" value="${esc(p?.price || '')}" placeholder="ex: R$ 1.200/mês"></div>
      </div>
      <div class="field"><label>Descrição</label><textarea id="pfr-desc" rows="2">${esc(p?.description || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Benefícios (um por linha)</label>
          <textarea id="pfr-benefits" rows="4">${esc((p?.benefits || []).join('\n'))}</textarea></div>
        <div class="field"><label>Objeções comuns (uma por linha)</label>
          <textarea id="pfr-objections" rows="4">${esc((p?.objections || []).join('\n'))}</textarea></div>
      </div>
      <div class="field"><label>Dono (gestor)</label>
        <select id="pfr-manager">
          <option value="">— global (todos os gestores) —</option>
          ${managers.map((m) => `<option value="${m.id}" ${p?.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select></div>
      <div class="field-row">
        <div class="field"><label>Vendedores atribuídos</label>${checkList('pfv', sellers, p?.vendedores_atribuidos)}</div>
        <div class="field"><label>Clientes (personas) atribuídos</label>${checkList('pfc', clientOpts, p?.clientes_atribuidos)}</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveProduct('${esc(p?.id || '')}')">${p ? 'Salvar' : 'Criar produto'}</button>
    </div>`, true);
}

async function saveProduct(productId) {
  const lines = (id) => el(id).value.split('\n').map((l) => l.trim()).filter(Boolean);
  const body = {
    name: el('pfr-name').value.trim(),
    price: el('pfr-price').value.trim() || null,
    description: el('pfr-desc').value.trim() || null,
    benefits: lines('pfr-benefits'),
    objections: lines('pfr-objections'),
    manager_id: el('pfr-manager').value || null,
    vendedores_atribuidos: checkedValues('pfv'),
    clientes_atribuidos: checkedValues('pfc'),
  };
  try {
    if (productId) await api(`/instances/${state.instId}/products/${productId}`, { method: 'PUT', body });
    else await api(`/instances/${state.instId}/products`, { method: 'POST', body });
    closeModal();
    renderProducts();
  } catch (err) {
    el('prod-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

async function removeProduct(productId) {
  const p = productsCache.find((x) => x.id === productId);
  if (!confirm(`Excluir o produto "${p.name}"?`)) return;
  try {
    await api(`/instances/${state.instId}/products/${productId}`, { method: 'DELETE' });
    renderProducts();
  } catch (err) { alert(err.message); }
}

// ----- Sessões agendadas -----
let scheduledCache = [];
const SCHED_STATUS = { pending: '⏳ pendente', done: '✓ concluída', cancelled: '✖ cancelada' };

async function renderScheduled() {
  try {
    [scheduledCache, clientsCache, usersCache, productsCache] = await Promise.all([
      api(`/instances/${state.instId}/scheduled`),
      api(`/instances/${state.instId}/clients`),
      api(`/instances/${state.instId}/users`),
      api(`/instances/${state.instId}/products`),
    ]);
    el('tab-body').innerHTML = `
      <div class="toolbar">
        <button class="btn primary" onclick="openSchedModal()">➕ Agendar treinamento</button>
        <span class="muted">${scheduledCache.length} sessão(ões) agendada(s)</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Agendada para</th><th>Vendedor</th><th>Cliente (persona)</th><th>Modo</th>
          <th>Abordagem</th><th>Status</th><th>Concluída em</th><th></th>
        </tr></thead>
        <tbody>${scheduledCache.map((s) => `
          <tr>
            <td>${fmtDate(s.scheduled_at)}</td>
            <td><span class="prim">${esc(s.avatar_emoji || '👤')} ${esc(s.seller_name || '?')}</span></td>
            <td>${esc(s.client_emoji || '👨‍💼')} ${esc(s.client_name || '?')}</td>
            <td><span class="badge">${(s.session_mode || 'text') === 'voice' ? '🎙️ voz' : '💬 texto'}</span></td>
            <td>${esc(s.sales_approach || 'active')}</td>
            <td><span class="badge ${s.status === 'pending' ? 'doing-training' : ''}">${SCHED_STATUS[s.status] || esc(s.status)}</span></td>
            <td>${fmtDate(s.done_at)}</td>
            <td style="white-space:nowrap">
              <button class="icon-btn" title="Editar" onclick="openSchedModal('${esc(s.id)}')">✏️</button>
              <button class="icon-btn" title="Excluir" onclick="removeSched('${esc(s.id)}')">🗑️</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="8"><div class="empty">Nenhuma sessão agendada.</div></td></tr>'}
        </tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

function openSchedModal(schedId) {
  const s = schedId ? scheduledCache.find((x) => x.id === schedId) : null;
  const sellers = usersCache.filter((u) => u.role === 'seller');
  const productOpts = productsCache.map((p) => ({ id: p.id, label: `📦 ${p.name}` }));
  openModal(`
    <div class="modal-head"><h3>${s ? 'Editar sessão agendada' : 'Agendar treinamento'}</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div id="sch-error"></div>
      <div class="field-row">
        <div class="field"><label>Vendedor</label>
          <select id="sf-seller">${sellers.map((u) =>
            `<option value="${u.id}" ${s?.seller_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Cliente (persona)</label>
          <select id="sf-client">${clientsCache.map((c) =>
            `<option value="${esc(c.id)}" ${s?.client_id === c.id ? 'selected' : ''}>${esc(c.emoji || '')} ${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Data/hora</label>
          <input id="sf-when" type="datetime-local" value="${toLocalInput(s?.scheduled_at || new Date().toISOString())}"></div>
        <div class="field"><label>Modo</label>
          <select id="sf-mode">
            <option value="text" ${(s?.session_mode || 'text') === 'text' ? 'selected' : ''}>💬 Chat por texto</option>
            <option value="voice" ${s?.session_mode === 'voice' ? 'selected' : ''}>🎙️ Ligação por voz</option>
          </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Abordagem</label>
          <select id="sf-approach">
            <option value="active" ${(s?.sales_approach || 'active') === 'active' ? 'selected' : ''}>Ativa (vendedor prospecta)</option>
            <option value="receptive" ${s?.sales_approach === 'receptive' ? 'selected' : ''}>Receptiva (cliente procura)</option>
          </select></div>
        <div class="field"><label>Status</label>
          <select id="sf-status">${['pending', 'done', 'cancelled'].map((st) =>
            `<option value="${st}" ${(s?.status || 'pending') === st ? 'selected' : ''}>${SCHED_STATUS[st]}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Produtos em pauta</label>${checkList('sfp', productOpts, s?.product_ids)}</div>
      <div class="field-row">
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text-2)">
          <input type="checkbox" id="sf-realtime" style="width:auto" ${s ? (s.show_realtime ? 'checked' : '') : 'checked'}> Coach em tempo real</label>
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text-2)">
          <input type="checkbox" id="sf-report" style="width:auto" ${s ? (s.show_report ? 'checked' : '') : 'checked'}> Relatório ao final</label>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveSched('${esc(s?.id || '')}')">${s ? 'Salvar' : 'Agendar'}</button>
    </div>`, true);
}

async function saveSched(schedId) {
  const body = {
    seller_id: el('sf-seller').value,
    client_id: el('sf-client').value,
    scheduled_at: el('sf-when').value ? new Date(el('sf-when').value).toISOString() : new Date().toISOString(),
    session_mode: el('sf-mode').value,
    sales_approach: el('sf-approach').value,
    status: el('sf-status').value,
    product_ids: checkedValues('sfp'),
    show_realtime: el('sf-realtime').checked,
    show_report: el('sf-report').checked,
  };
  try {
    if (schedId) await api(`/instances/${state.instId}/scheduled/${schedId}`, { method: 'PUT', body });
    else await api(`/instances/${state.instId}/scheduled`, { method: 'POST', body });
    closeModal();
    renderScheduled();
  } catch (err) {
    el('sch-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

async function removeSched(schedId) {
  if (!confirm('Excluir esta sessão agendada?')) return;
  try {
    await api(`/instances/${state.instId}/scheduled/${schedId}`, { method: 'DELETE' });
    renderScheduled();
  } catch (err) { alert(err.message); }
}

// ----- Conversas -----
async function renderSessions() {
  try {
    const [sessions, users] = await Promise.all([
      api(`/instances/${state.instId}/sessions?limit=150`),
      usersCache.length ? Promise.resolve(usersCache) : api(`/instances/${state.instId}/users`),
    ]);
    usersCache = users;
    el('tab-body').innerHTML = `
      <div class="toolbar">
        <label>Vendedor:
          <select id="sess-filter" onchange="filterSessions()">
            <option value="">todos</option>
            ${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
          </select></label>
        <span class="muted" id="sess-count">${sessions.length} sessão(ões)</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Início</th><th>Vendedor</th><th>Cenário</th><th>Status</th>
          <th>Msgs</th><th>Convicção</th><th>Duração</th><th>Última msg</th><th></th>
        </tr></thead>
        <tbody id="sess-tbody">${sessions.map(sessRow).join('')}</tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

function sessRow(s) {
  return `
    <tr class="clickable" onclick="openSession('${s.id}')">
      <td>${fmtDate(s.created_at)}</td>
      <td><span class="prim">${esc(s.avatar_emoji || '')} ${esc(s.user_name || '?')}</span></td>
      <td>${esc(s.scenario_name || '—')}</td>
      <td><span class="badge ${s.status === 'in_progress' ? 'doing-training' : ''}">${s.status === 'in_progress' ? '● em andamento' : '✓ concluída'}</span></td>
      <td>${s.msg_count}</td>
      <td>${s.conviction_final ?? '—'}</td>
      <td>${fmtDur(s.duration_seconds)}</td>
      <td>${relTime(s.last_msg_at)}</td>
      <td><button class="icon-btn" title="Excluir conversa"
        onclick="event.stopPropagation(); removeSession('${esc(s.id)}')">🗑️</button></td>
    </tr>`;
}

async function removeSession(sid) {
  if (!confirm('Excluir esta conversa?\n\nA transcrição inteira é apagada do banco. Não tem volta.')) return;
  try {
    await api(`/instances/${state.instId}/sessions/${sid}`, { method: 'DELETE' });
    renderSessions();
  } catch (err) { alert(err.message); }
}

async function filterSessions() {
  const uid = el('sess-filter').value;
  const sessions = await api(`/instances/${state.instId}/sessions?limit=150${uid ? `&user_id=${uid}` : ''}`);
  el('sess-tbody').innerHTML = sessions.map(sessRow).join('');
  el('sess-count').textContent = `${sessions.length} sessão(ões)`;
}

async function openSession(sid) {
  try {
    const { session: s, messages } = await api(`/instances/${state.instId}/sessions/${sid}`);
    openModal(`
      <div class="modal-head">
        <h3>💬 ${esc(s.user_name || '?')} · ${esc(s.scenario_name || 'sem cenário')}</h3>
        <button class="icon-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="muted" style="margin-bottom:12px">
          ${fmtDate(s.created_at)} · ${s.status === 'in_progress' ? 'em andamento' : 'concluída'} ·
          convicção final ${s.conviction_final ?? '—'} · ${fmtDur(s.duration_seconds)} · ${messages.length} mensagens
        </div>
        <div class="chat-view">
          ${messages.map((m) => `
            <div class="bubble ${esc(m.role)}">
              ${esc(m.content)}
              <div class="meta">${m.role === 'user' ? '🧑 vendedor' : m.role === 'assistant' ? '🤖 cliente IA' : 'sistema'} · ${fmtDate(m.created_at)}
              ${m.is_trick ? ` <span class="trick">⚠ pegadinha${m.trick_type ? `: ${esc(m.trick_type)}` : ''}</span>` : ''}</div>
            </div>`).join('') || '<div class="empty">Sem mensagens.</div>'}
        </div>
      </div>`, true);
  } catch (err) { alert(err.message); }
}

// ----- Live Coach -----
async function renderLiveCalls() {
  try {
    const calls = await api(`/instances/${state.instId}/live-calls`);
    el('tab-body').innerHTML = `
      <div class="toolbar"><span class="muted">${calls.length} chamada(s) real(is) registradas</span></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Início</th><th>Vendedor</th><th>Status</th><th>Falas</th><th>Dicas</th><th>Resumo</th>
        </tr></thead>
        <tbody>${calls.map((c) => `
          <tr class="clickable" onclick="openLiveCall('${esc(c.id)}')">
            <td>${fmtDate(c.started_at)}</td>
            <td><span class="prim">${esc(c.avatar_emoji || '')} ${esc(c.user_name || '?')}</span></td>
            <td><span class="badge ${!c.ended_at ? 'doing-call' : ''}">${!c.ended_at ? '● ao vivo' : '✓ encerrada'}</span></td>
            <td>${c.transcript_len}</td>
            <td>${c.tips_len}</td>
            <td><span class="sec">${esc(String(c.summary || '—').slice(0, 70))}</span></td>
          </tr>`).join('') || '<tr><td colspan="6"><div class="empty">Nenhuma chamada registrada.</div></td></tr>'}
        </tbody>
      </table></div>`;
  } catch (err) { tabError(err); }
}

function liveEntryText(entry) {
  if (typeof entry === 'string') return entry;
  return entry.text || entry.content || entry.message || JSON.stringify(entry);
}
function liveEntryWho(entry) {
  const who = entry.speaker || entry.role || entry.source || '';
  return /vend|user|seller|me/i.test(who) ? 'user' : 'assistant';
}

async function openLiveCall(cid) {
  try {
    const c = await api(`/instances/${state.instId}/live-calls/${cid}`);
    const transcript = Array.isArray(c.transcript) ? c.transcript : [];
    const tips = Array.isArray(c.tips) ? c.tips : [];
    openModal(`
      <div class="modal-head">
        <h3>🎧 Chamada de ${esc(c.user_name || '?')} · ${fmtDate(c.started_at)}</h3>
        <button class="icon-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        ${c.summary ? `<div class="card" style="margin-bottom:14px"><h3>Resumo</h3>${esc(c.summary)}</div>` : ''}
        ${tips.length ? `<div class="card" style="margin-bottom:14px"><h3>Dicas do coach (${tips.length})</h3>
          ${tips.map((t) => `<div class="feed-row"><div class="ico">💡</div><div class="txt">${esc(liveEntryText(t))}</div></div>`).join('')}</div>` : ''}
        <div class="card"><h3>Transcrição (${transcript.length} falas)</h3>
          <div class="chat-view">
            ${transcript.map((t) => `<div class="bubble ${liveEntryWho(t)}">${esc(liveEntryText(t))}</div>`).join('') || '<div class="empty">Transcrição vazia.</div>'}
          </div></div>
      </div>`, true);
  } catch (err) { alert(err.message); }
}

// ----- Logs -----
async function renderLogs() {
  el('tab-body').innerHTML = `
    <div class="toolbar">
      <button class="btn" onclick="fetchLogs()">🔄 Atualizar</button>
      <label>Tamanho:
        <select id="log-kb"><option value="64">64 KB</option><option value="256" selected>256 KB</option><option value="1024">1 MB</option></select>
      </label>
      <label><input type="checkbox" id="log-auto" style="width:auto" onchange="toggleLogAuto()"> auto (10s)</label>
      <span class="muted" id="log-info"></span>
    </div>
    <div class="log-box" id="log-box">Carregando logs do container…</div>`;
  fetchLogs();
}

async function fetchLogs() {
  try {
    const maxKb = el('log-kb') ? el('log-kb').value : 256;
    const data = await api(`/instances/${state.instId}/logs?maxKb=${maxKb}`);
    const box = el('log-box');
    if (!box) return;
    box.textContent = data.content || '(vazio)';
    box.scrollTop = box.scrollHeight;
    el('log-info').textContent = `${data.file || ''} · atualizado ${relTime(data.lastUpdated)}`;
  } catch (err) {
    const box = el('log-box');
    if (box) box.textContent = `Erro ao buscar logs: ${err.message}\n\nDica: os logs vêm do Kudu via credenciais de publicação (az CLI). Confira se o "az login" está válido.`;
  }
}

function toggleLogAuto() {
  clearTimers();
  if (el('log-auto').checked) state.timers.push(setInterval(fetchLogs, 10000));
}

// ----- Config -----
async function renderConfig() {
  try {
    const cfg = await api(`/instances/${state.instId}/settings`);
    const inst = currentInst();
    const site = cfg.site && !cfg.site.error ? cfg.site : null;
    el('tab-body').innerHTML = `
      <div class="two-col">
        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Azure App Service</h3>
            ${site ? `
              <table>
                <tr><td class="muted">Estado</td><td class="prim">${esc(site.state)}</td></tr>
                <tr><td class="muted">Host</td><td class="mono">${esc(site.host)}</td></tr>
                <tr><td class="muted">Runtime</td><td>${esc(site.linuxFx)}</td></tr>
                <tr><td class="muted">Startup</td><td class="mono">${esc(site.startup || '—')}</td></tr>
                <tr><td class="muted">Região</td><td>${esc(site.location)}</td></tr>
                <tr><td class="muted">Último deploy</td><td>${fmtDate(site.lastModified)}</td></tr>
              </table>` : `<div class="error-box">⚠️ ${esc(cfg.site?.error || 'não foi possível consultar o Azure')}</div>`}
          </div>
          <div class="card" style="margin-bottom:14px">
            <h3>IA da instância (ai_settings)</h3>
            ${cfg.ai && !cfg.ai.error ? `
              <table>
                <tr><td class="muted">Chave OpenAI</td><td>${cfg.ai.configured ? `<span class="mono">${esc(cfg.ai.keyMasked)}</span>` : '<span class="status warn"><span class="dot"></span>não configurada</span>'}</td></tr>
                <tr><td class="muted">Modelo</td><td>${esc(cfg.ai.preferred_model || '—')}</td></tr>
                <tr><td class="muted">Limite mensal</td><td>${cfg.ai.monthly_token_limit ?? '—'} tokens</td></tr>
              </table>` : `<div class="error-box">⚠️ ${esc(cfg.ai?.error || '')}</div>`}
          </div>
          <div class="card">
            <h3>Ações</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <a class="btn small" href="${esc(cfg.links.app)}" target="_blank">Abrir app ↗</a>
              <a class="btn small" href="${esc(cfg.links.scm)}" target="_blank">Kudu (SCM) ↗</a>
              <a class="btn small" href="${esc(cfg.links.portal)}" target="_blank">Portal Azure ↗</a>
              <button class="btn small" onclick="testDb()">🗄️ Testar banco</button>
              <button class="btn small danger" onclick="restartInstance()">⟳ Reiniciar app</button>
              <button class="btn small danger" onclick="unregisterInstance()">✂️ Remover do painel</button>
            </div>
            <div class="help muted" style="margin-top:10px">Remover do painel NÃO apaga nada no Azure — só tira daqui.</div>
          </div>
        </div>
        <div class="card">
          <h3>App Settings (segredos mascarados)</h3>
          ${cfg.appSettings ? `<table>${cfg.appSettings.map((s) => `
            <tr><td class="mono muted">${esc(s.name)}</td><td class="mono">${esc(s.value ?? '')}</td></tr>`).join('')}</table>`
            : '<div class="error-box">⚠️ não foi possível listar (az CLI)</div>'}
        </div>
      </div>`;
  } catch (err) { tabError(err); }
}

async function testDb() {
  try {
    const r = await api(`/instances/${state.instId}/db-test`, { method: 'POST' });
    alert(`Banco OK ✓\n${r.users} usuário(s) na tabela users.`);
  } catch (err) { alert(`Falha na conexão com o banco:\n${err.message}${err.hint ? `\n\n💡 ${err.hint}` : ''}`); }
}

async function restartInstance() {
  const inst = currentInst();
  if (!confirm(`Reiniciar o app "${inst.company}" (${inst.appName})?\nQuem estiver usando cai por ~1 minuto.`)) return;
  try {
    await api(`/instances/${state.instId}/restart`, { method: 'POST' });
    alert('Reinício disparado. O app volta em ~1 min.');
    refreshStatuses();
  } catch (err) { alert(err.message); }
}

async function unregisterInstance() {
  const inst = currentInst();
  if (!confirm(`Remover "${inst.company}" do Mission Control?\n(nada é apagado no Azure/banco)`)) return;
  await api(`/instances/${state.instId}`, { method: 'DELETE' });
  await loadInstances();
  showFleet();
}

// ===== Modais =====
function openModal(innerHtml, wide = false) {
  el('modal-root').innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}">${innerHtml}</div>
    </div>`;
}
function closeModal() { el('modal-root').innerHTML = ''; }

// ----- Registrar instância existente -----
async function openRegisterModal() {
  openModal(`
    <div class="modal-head"><h3>🔗 Registrar instância existente</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div id="reg-error"></div>
      <div class="field"><label>Web App na assinatura Azure</label>
        <select id="reg-app"><option>carregando…</option></select>
        <div class="help">Lista via az CLI. Selecione o App Service da empresa.</div></div>
      <div class="field"><label>Nome da empresa</label>
        <input id="reg-company" placeholder="ex: Açoforte Segurança"></div>
      <div class="field"><label>DATABASE_URL (opcional)</label>
        <input id="reg-dburl" placeholder="deixe vazio p/ buscar das App Settings do app">
        <div class="help">Se vazio, o painel busca automaticamente das App Settings.</div></div>
      <div class="field"><label>Notas (opcional)</label><input id="reg-notes"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" id="reg-submit" onclick="submitRegister()">Registrar</button>
    </div>`);
  try {
    const apps = await api('/azure/webapps');
    el('reg-app').innerHTML = apps.map((a) =>
      `<option value="${esc(a.name)}|${esc(a.resourceGroup)}" ${a.registered ? 'disabled' : ''}>
        ${esc(a.name)} (${esc(a.resourceGroup)})${a.registered ? ' — já registrada' : ''}</option>`).join('')
      || '<option value="">nenhum web app encontrado</option>';
  } catch (err) {
    el('reg-error').innerHTML = `<div class="error-box">⚠️ az CLI: ${esc(err.message)}</div>`;
    el('reg-app').innerHTML = '<option value="">(indisponível — informe manualmente nas notas)</option>';
  }
}

async function submitRegister() {
  const sel = el('reg-app').value;
  const [appName, resourceGroup] = sel.split('|');
  const btn = el('reg-submit');
  btn.disabled = true; btn.textContent = 'Testando banco…';
  try {
    const created = await api('/instances', {
      method: 'POST',
      body: {
        company: el('reg-company').value.trim(),
        appName, resourceGroup,
        dbUrl: el('reg-dburl').value.trim() || undefined,
        notes: el('reg-notes').value.trim(),
      },
    });
    if (created.dbTest && !created.dbTest.ok) {
      alert(`Instância registrada, MAS o banco não respondeu:\n\n${created.dbTest.error}\n\nSe for Supabase free, o projeto pode estar pausado — restaure no dashboard do Supabase.`);
    }
    closeModal();
    await loadInstances();
    showFleet();
  } catch (err) {
    el('reg-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
    btn.disabled = false; btn.textContent = 'Registrar';
  }
}

// ----- Nova instância (provisionamento) -----
function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => chars[b % chars.length]).join('');
}

async function openProvisionModal() {
  openModal(`
    <div class="modal-head"><h3>➕ Nova instância — nova empresa</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body" id="prov-body">
      <div class="error-box" style="background:var(--warning-soft);border-color:rgba(250,178,25,.35);color:var(--warning)">
        ⚠️ Antes de começar: crie um projeto novo no <b>Supabase</b> (1 banco por empresa) e copie a
        connection string (Settings → Database → Connection string → URI, com a senha).
      </div>
      <div id="prov-error"></div>
      <div class="field"><label>Nome da empresa</label>
        <input id="pf-company" placeholder="ex: Açoforte Segurança" oninput="el('pf-app').value = 'salespulse-' + slugify(this.value) + '-app'"></div>
      <div class="field"><label>Nome do Web App (único no Azure)</label>
        <input id="pf-app" class="mono" placeholder="salespulse-empresa-app">
        <div class="help">Vira a URL: https://&lt;nome&gt;.azurewebsites.net</div></div>
      <div class="field-row">
        <div class="field"><label>Resource group</label><input id="pf-rg" value="joao.mattos_rg_2339"></div>
        <div class="field"><label>App Service Plan</label>
          <select id="pf-plan"><option value="joao.mattos_asp_5727">joao.mattos_asp_5727 (atual)</option></select></div>
      </div>
      <div class="field"><label>DATABASE_URL do banco novo (Supabase — use a do POOLER)</label>
        <input id="pf-dburl" class="mono" placeholder="postgresql://postgres.xxxx:SENHA@aws-1-sa-east-1.pooler.supabase.com:5432/postgres">
        <div class="help">Use a connection string do <b>pooler em Session mode (porta 5432)</b> — a conexão
        direta (db.xxxx.supabase.co) é só IPv6 e não funciona nem desta máquina nem do Azure.</div></div>
      <div class="field-row">
        <div class="field"><label>E-mail do gestor inicial</label>
          <input id="pf-admin-email" value="admin@salespulse.com.br"></div>
        <div class="field"><label>Senha do gestor inicial</label>
          <input id="pf-admin-pass" class="mono" value="${genPassword()}"></div>
      </div>
      <div class="field"><label>Chave OpenAI (opcional — dá pra definir depois no painel do app)</label>
        <input id="pf-openai" class="mono" placeholder="sk-…"></div>
    </div>
    <div class="modal-foot" id="prov-foot">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" id="prov-submit" onclick="submitProvision()">🚀 Criar instância</button>
    </div>`, true);
  try {
    const plans = await api('/azure/plans');
    el('pf-plan').innerHTML = plans.map((p) =>
      `<option value="${esc(p.name)}" ${p.name === 'joao.mattos_asp_5727' ? 'selected' : ''}>
        ${esc(p.name)} — ${esc(p.sku)} ${esc(p.tier)} · ${p.apps} app(s) · ${esc(p.location)}</option>`).join('');
  } catch (err) { /* mantém o default */ }
}

async function submitProvision() {
  const body = {
    company: el('pf-company').value.trim(),
    appName: el('pf-app').value.trim(),
    resourceGroup: el('pf-rg').value.trim(),
    plan: el('pf-plan').value,
    dbUrl: el('pf-dburl').value.trim(),
    adminEmail: el('pf-admin-email').value.trim(),
    adminPassword: el('pf-admin-pass').value,
    openaiKey: el('pf-openai').value.trim() || undefined,
  };
  const adminPass = body.adminPassword;
  try {
    const { jobId } = await api('/provision', { method: 'POST', body });
    el('prov-body').innerHTML = '<div class="steps" id="prov-steps"></div><div id="prov-result"></div>';
    el('prov-foot').innerHTML = '<button class="btn" onclick="closeModal(); loadInstances()">Fechar</button>';
    const es = new EventSource(`/api/provision/${jobId}/stream`);
    es.onmessage = (e) => {
      const snap = JSON.parse(e.data);
      el('prov-steps').innerHTML = snap.steps.map((s) => `
        <div class="step-row ${s.status}">
          <div class="head">
            <span>${s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : '<span class="spin">⏳</span>'}</span>
            ${esc(s.name)}
          </div>
          ${s.lines.length ? `<div class="lines">${s.lines.map(esc).join('\n')}</div>` : ''}
        </div>`).join('');
      if (snap.status === 'done') {
        es.close();
        el('prov-result').innerHTML = `
          <div class="card" style="margin-top:14px;border-color:rgba(12,163,12,.4)">
            <h3>✅ Instância no ar</h3>
            <p>URL: <a href="${esc(snap.result.url)}" target="_blank">${esc(snap.result.url)}</a></p>
            <p style="margin-top:8px">Login do gestor: <span class="mono">${esc(snap.result.adminEmail)}</span> ·
               senha <span class="mono">${esc(adminPass)}</span></p>
            <p class="muted" style="margin-top:8px">Anote a senha — ela não fica salva no painel.</p>
          </div>`;
        loadInstances();
      }
      if (snap.status === 'failed') {
        es.close();
        el('prov-result').innerHTML = `<div class="error-box" style="margin-top:14px">❌ ${esc(snap.error)}</div>`;
      }
    };
  } catch (err) {
    el('prov-error').innerHTML = `<div class="error-box">⚠️ ${esc(err.message)}</div>`;
  }
}

// ===== Boot =====
(async function boot() {
  await loadInstances();
  showFleet();
})();
