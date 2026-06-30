// ================================================
// SALESPULSE — Auth Module
// ================================================

const Auth = (() => {

  // Default manager account:
  const DEFAULT_MANAGER = {
    id: 'mgr_001',
    name: 'Administrador',
    email: 'admin@salespulse.com',
    password: 'admin123',
    role: 'manager',
  };

  function init() {
    // Ensure default manager exists
    const settings = Storage.getSettings();
    if (!settings.managerAccount) {
      Storage.setSettings({ managerAccount: DEFAULT_MANAGER });
    }
    // Ensure sellers list is initialized
    const sellers = Storage.getSellers();
  }

  async function loginManager(email, password) {
    // Try backend first
    if (API.isBackendEnabled()) {
      try {
        const data = await API.login(email, password);
        if (data && data.user) {
          const auth = { ...data.user, token: data.token, loginAt: new Date().toISOString() };
          Storage.setAuth(auth);
          return auth;
        }
      } catch (err) {
        console.warn('[Auth] Backend login failed:', err.message, '- Falling back to local storage auth.');
        // Don't throw yet, fallback to local storage
      }
    }

    // Fallback to local
    const settings = Storage.getSettings();
    const mgr = settings.managerAccount || DEFAULT_MANAGER;
    if (
      (email.toLowerCase().trim() === mgr.email.toLowerCase() || email.toLowerCase().trim() === 'admin@salespulse.com') &&
      password === mgr.password
    ) {
      const auth = {
        id: mgr.id,
        name: mgr.name,
        email: mgr.email,
        role: 'manager',
        loginAt: new Date().toISOString(),
      };
      Storage.setAuth(auth);
      return auth;
    }
    return null;
  }

  async function loginSeller(email, password) {
    // Try backend first
    if (API.isBackendEnabled()) {
      try {
        const data = await API.login(email, password);
        if (data && data.user) {
          const auth = { ...data.user, token: data.token, loginAt: new Date().toISOString() };
          Storage.setAuth(auth);
          if (API.syncDown) await API.syncDown();
          return auth;
        }
      } catch (err) {
        console.warn('[Auth] Backend login failed:', err.message, 'falling back to local.');
      }
    }

    // Fallback to local
    const sellers = Storage.getSellers();
    const seller = sellers.find(
      s => s.email.toLowerCase().trim() === email.toLowerCase().trim() && s.password === password
    );
    if (seller) {
      const auth = {
        id: seller.id,
        name: seller.name,
        email: seller.email,
        role: 'seller',
        avatar: seller.avatar || '👤',
        loginAt: new Date().toISOString(),
      };
      Storage.setAuth(auth);
      return auth;
    }
    return null;
  }

  async function loginUnified(email, password) {
    // Try backend first
    if (API.isBackendEnabled()) {
      try {
        const data = await API.login(email, password);
        if (data && data.user) {
          const auth = { ...data.user, token: data.token, loginAt: new Date().toISOString() };
          Storage.setAuth(auth);
          return auth;
        }
      } catch (err) {
        console.warn('[Auth] Backend login failed:', err.message, 'falling back to local.');
      }
    }

    // Fallback to local
    const settings = Storage.getSettings();
    const mgr = settings.managerAccount || DEFAULT_MANAGER;
    if (
      (email.toLowerCase().trim() === mgr.email.toLowerCase() || email.toLowerCase().trim() === 'admin@salespulse.com') &&
      password === mgr.password
    ) {
      const auth = {
        id: mgr.id,
        name: mgr.name,
        email: mgr.email,
        role: 'manager',
        loginAt: new Date().toISOString(),
      };
      Storage.setAuth(auth);
      return auth;
    }

    const sellers = Storage.getSellers();
    const sel = sellers.find(s => s.email.toLowerCase().trim() === email.toLowerCase().trim() && s.password === password);
    if (sel) {
      const auth = {
        id: sel.id,
        name: sel.name,
        email: sel.email,
        role: 'seller',
        loginAt: new Date().toISOString(),
      };
      Storage.setAuth(auth);
      return auth;
    }
    
    return null;
  }

  function logout() {
    Storage.clearAuth();
    App.navigate('landing');
  }

  function getUser() {
    return Storage.getAuth();
  }

  function isAuthenticated() {
    const auth = Storage.getAuth();
    return !!auth;
  }

  function isManager() {
    const auth = Storage.getAuth();
    return auth?.role === 'manager';
  }

  function isSeller() {
    const auth = Storage.getAuth();
    return auth?.role === 'seller';
  }

  function requireAuth(role) {
    const auth = Storage.getAuth();
    if (!auth) {
      App.navigate('login');
      return false;
    }
    if (role && auth.role !== role) {
      UI.toast(`Acesso negado para este perfil.`, 'error');
      return false;
    }
    return true;
  }

  return { init, loginManager, loginSeller, loginUnified, logout, getUser, isAuthenticated, isManager, isSeller, requireAuth };
})();
