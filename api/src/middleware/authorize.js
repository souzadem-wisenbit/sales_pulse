'use strict';

/**
 * Middleware para autorizar papéis específicos.
 * Ex: authorize('manager')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });

    let allowedRoles = [...roles];
    if (allowedRoles.includes('manager') && !allowedRoles.includes('superadmin')) {
      allowedRoles.push('superadmin');
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado. Nível de permissão insuficiente.' });
    }
    next();
  };
}

module.exports = { authorize };
