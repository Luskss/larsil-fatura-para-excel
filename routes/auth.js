/**
 * routes/auth.js  → POST /api/auth.php
 * Autenticação consultando nfs.CONV_USUARIOS (Azure SQL).
 * Espelha api/auth.php (senha em texto plano, rate limiting por sessão).
 */
'use strict';

const crypto = require('crypto');
const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders } = require('./_helpers');

/** Comparação em tempo constante (equivalente a hash_equals). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async function authRoute(req, res) {
  setFullSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }

  const data = req.body || {};
  const username = String(data.username ?? '').trim();
  const password = data.password ?? '';

  if (username === '' || password === '') {
    return res.status(400).json({ success: false, message: 'Usuário e senha são obrigatórios.' });
  }
  if (username.length > 100 || String(password).length > 256) {
    return res.status(400).json({ success: false, message: 'Dados inválidos.' });
  }

  // ── Proteção contra brute force (rate limiting por sessão) ──────────────
  const loginAttempts = req.session.login_attempts || 0;
  const lastAttempt = req.session.last_login_attempt || 0;
  const now = Math.floor(Date.now() / 1000);
  if (loginAttempts > 5 && now - lastAttempt < 900) {
    return res.status(429).json({ success: false, message: 'Muitas tentativas de login. Tente novamente mais tarde.' });
  }
  req.session.last_login_attempt = now;

  const respondUnauthorized = () =>
    res.status(401).json({ success: false, message: 'Usuário ou senha incorretos.' });

  try {
    const pool = await getConnection();
    const result = await pool
      .request()
      .input('login', sql.NVarChar(100), username)
      .query('SELECT LOGIN, SENHA, NOME FROM nfs.CONV_USUARIOS WHERE LOGIN = @login');

    const row = result.recordset[0];
    if (!row) {
      return respondUnauthorized();
    }

    const senhaValida = safeEqual(row.SENHA, password);
    if (!senhaValida) {
      req.session.login_attempts = loginAttempts + 1;
      return respondUnauthorized();
    }

    // Login OK — reseta contador e (re)gera sessão autenticada
    req.session.login_attempts = 0;
    req.session.regenerate((err) => {
      if (err) {
        console.error('[auth] regenerate error:', err.message);
        return res.status(500).json({ success: false, message: 'Erro de sessão.' });
      }
      req.session.cf_loggedIn = true;
      req.session.cf_username = row.LOGIN;
      res.json({
        success: true,
        message: 'Login realizado com sucesso.',
        username: row.NOME || row.LOGIN,
      });
    });
  } catch (e) {
    console.error('[conversor-fatura] DB error:', e.message);
    res.status(500).json({ success: false, message: 'Erro de conexão: ' + e.message });
  }
};
