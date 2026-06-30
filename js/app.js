/ ================================================
// SALESPULSE — App Router & UI Utilities
// ================================================

const UI = (() => {
  function toast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const iconMap = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const div = document.createElement('div');
    div.className = `toast toast-${type}`;
    div.innerHTML = `<span>${iconMap[type] || 'ℹ️'}</span><span>${message}</span>`;
    container.appendChild(div);

    setTimeout(() => {
      div.style.animation = 'toastOut 0.3s var(--ease-in) forwards';
      setTimeout(() => div.remove(), 300);
    }, duration);
  }

  function showLoading(show) {
    const el = document.getElementById('global-loader');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  return { toast, showLoading };
})();

// ══════════════════════════════════════════════════
// APP ROUTER
// ══════════════════════════════════════════════════
const App = (() => {

  let currentPage = null;

  // Lazy lookup - called after DOM is ready
  function getPages() {
    return {
      landing:  document.getElementById('page-landing'),
      login:    document.getElementById('page-login'),
      manager:  document.getElementById('page-manager'),
      seller:   document.getElementById('page-seller'),
      results:  document.getElementById('page-results'),
    };
  }

  async function init() {
    Auth.init();
    setupLanding();
    setupLogin();

    // Route based on auth state
    const auth = Auth.getUser();
    if (auth) {
      UI.showLoading(true);
      await Storage.hydrate();
      UI.showLoading(false);
      navigate((auth.role === 'manager' || auth.role === 'superadmin') ? 'manager' : 'seller');
    } else {
      navigate('landing');
    }
  }

  function navigate(page) {
    // Force-hide ALL pages using direct style (highest specificity)
    ['page-landing', 'page-login', 'page-manager', 'page-seller', 'page-results'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('active');
        el.style.setProperty('display', 'none', 'important');
      }
    });

    currentPage = page;

    // Show target page
    const pageIdMap = {
      landing: 'page-landing',
      login:   'page-login',
      manager: 'page-manager',
      seller:  'page-seller',
      results: 'page-results',
    };

    const targetId = pageIdMap[page];
    if (targetId) {
      const target = document.getElementById(targetId);
      if (target) {
        target.classList.add('active');
        target.style.setProperty('display', 'block', 'important');
      }
    }

    // Initialize page modules
    switch (page) {
      case 'manager': Manager.init(); break;
      case 'seller':  Seller.init();  break;
      case 'login':
        // Sempre reseta o botão ao navegar para a tela de login
        const loginBtn = document.getElementById('login-btn');
        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Entrar →'; }
        break;
    }
  }

  function showResults(result, sessionId) {
    // Hide all pages
    ['page-landing', 'page-login', 'page-manager', 'page-seller', 'page-results'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('active');
        el.style.setProperty('display', 'none', 'important');
      }
    });
    // Show results
    const resultsPage = document.getElementById('page-results');
    if (resultsPage) {
      resultsPage.classList.add('active');
      resultsPage.style.setProperty('display', 'block', 'important');
      Results.render(result, sessionId);
    }
  }

  // ══════════════════════════════════════
  // LANDING PAGE SETUP
  // ══════════════════════════════════════
  function setupLanding() {
    animateDemoChat();
    animateCounters();
  }

  function animateDemoChat() {
    const demoMsgs = document.querySelectorAll('.demo-msg');
    demoMsgs.forEach((msg, i) => {
      msg.style.opacity = '0';
      setTimeout(() => {
        msg.style.transition = 'opacity 0.5s, transform 0.5s';
        msg.style.opacity = '1';
        msg.style.transform = 'translateY(0)';
      }, 600 + i * 700);
    });
  }

  function animateCounters() {
    const counters = document.querySelectorAll('.hero-stat-num[data-target]');
    counters.forEach(counter => {
      const target = parseInt(counter.dataset.target);
      const suffix = counter.dataset.suffix || '';
      let current = 0;
      const increment = target / 60;
      const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
          counter.textContent = target + suffix;
          clearInterval(timer);
        } else {
          counter.textContent = Math.floor(current) + suffix;
        }
      }, 25);
    });
  }

  // ══════════════════════════════════════
  // LOGIN PAGE SETUP
  // ══════════════════════════════════════
  function setupLogin() {
    // Single Form submission
    document.getElementById('login-form')?.addEventListener('submit', e => {
      e.preventDefault();
      handleUnifiedLogin();
    });
  }

  async function handleUnifiedLogin() {
    const email    = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    const btn      = document.getElementById('login-btn');

    if (!email || !password) { UI.toast('Preencha e-mail e senha.', 'error'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

    try {
      const user = await Auth.loginUnified(email, password);
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar →'; }
      if (user) {
        UI.toast(`Bem-vindo, ${user.name}! 👋`, 'success');
        UI.showLoading(true);
        await Storage.hydrate();
        UI.showLoading(false);
        if (user.role === 'manager' || user.role === 'superadmin') {
          navigate('manager');
        } else {
          navigate('seller');
        }
      } else {
        UI.toast('E-mail ou senha inválidos.', 'error');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar →'; }
      UI.toast(err.message || 'Erro ao fazer login.', 'error');
    }
  }

  return { init, navigate, showResults };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
