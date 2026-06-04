/**
 * routes/logout.js  → POST /api/logout.php
 * Destrói a sessão autenticada. Espelha api/logout.php.
 */
'use strict';

module.exports = function logoutRoute(req, res) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');

  if (!req.session || !req.session.cf_loggedIn) {
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('[logout] destroy error:', err.message);
      return res.status(500).json({ success: false, message: 'Erro ao encerrar sessão.' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logout realizado com sucesso.' });
  });
};
