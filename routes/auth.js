/**
 * routes/auth.js  → POST /api/auth.php
 * Login único da Larsil: este endpoint é um proxy/adaptador da Auth API da IAM.
 *
 * Não existe mais tabela de usuário/senha neste sistema (nfs.CONV_USUARIOS foi
 * aposentada) — quem valida a senha é a IAM. Aqui só traduzimos o contrato para
 * o formato que o front já usa ({ success, message, username }) e guardamos o
 * JWT na sessão do servidor.
 */
'use strict';

const { setFullSecurityHeaders } = require('./_helpers');
const { gravarAcesso } = require('./_iam-session');
const { iamLogin, PERM_ACESSO, IAM_ADMIN_URL, TELAS, permTela } = require('../iam');

module.exports = async function authRoute(req, res) {
  setFullSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }

  const data = req.body || {};
  // aceita o formato antigo (username/password) e o da IAM (login/senha)
  const login = String(data.username ?? data.login ?? '').trim();
  const senha = data.password ?? data.senha ?? '';

  if (login === '' || senha === '') {
    return res.status(400).json({ success: false, message: 'Usuário e senha são obrigatórios.' });
  }
  if (login.length > 100 || String(senha).length > 256) {
    return res.status(400).json({ success: false, message: 'Dados inválidos.' });
  }

  // ── Proteção contra brute force (rate limiting por sessão) ──────────────
  const tentativas = req.session.login_attempts || 0;
  const ultima = req.session.last_login_attempt || 0;
  const agora = Math.floor(Date.now() / 1000);
  if (tentativas > 5 && agora - ultima < 900) {
    return res.status(429).json({ success: false, message: 'Muitas tentativas de login. Tente novamente mais tarde.' });
  }
  req.session.last_login_attempt = agora;

  const r = await iamLogin(login, senha);

  if (r.erroRede) {
    console.error('[auth] IAM inacessível:', r.erroRede);
    return res.status(503).json({
      success: false,
      message: 'Não foi possível falar com o sistema de login da Larsil. Tente novamente em instantes.',
    });
  }

  // Credencial errada — mensagem genérica, não revela se o login existe.
  if (r.status === 401) {
    req.session.login_attempts = tentativas + 1;
    return res.status(401).json({ success: false, message: 'Usuário ou senha incorretos.' });
  }

  // Conta desativada pela TI: a senha estava certa, então a mensagem é específica.
  if (r.status === 403) {
    return res.status(403).json({
      success: false,
      message: (r.data && r.data.erro) || 'Sua conta está desativada. Entre em contato com a TI da empresa.',
      motivo: (r.data && r.data.motivo) || 'INATIVO',
    });
  }

  if (!r.ok || !r.data || !r.data.token) {
    console.error('[auth] resposta inesperada da IAM:', r.status, r.data && r.data.erro);
    return res.status(502).json({ success: false, message: 'Falha no login. Avise a TI.' });
  }

  const usuario = r.data.usuario || {};
  const permissoes = usuario.permissoes || [];

  // Tem identidade na Larsil, mas ninguém liberou ESTE sistema para ela.
  if (!permissoes.includes(PERM_ACESSO)) {
    return res.status(403).json({
      success: false,
      message: 'Seu usuário não tem acesso ao Conversor de Faturas. Peça a liberação à TI.',
      motivo: 'SEM_ACESSO',
      iam_admin_url: IAM_ADMIN_URL,
    });
  }

  // Login OK — reseta o contador e regenera a sessão (evita fixation).
  req.session.login_attempts = 0;
  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth] regenerate error:', err.message);
      return res.status(500).json({ success: false, message: 'Erro de sessão.' });
    }

    gravarAcesso(req, {
      token: r.data.token,
      usuario,
      senhaProvisoria: !!r.data.senha_provisoria,
    });

    res.json({
      success: true,
      message: 'Login realizado com sucesso.',
      username: usuario.nome || usuario.login, // o front já mostra isto no "Olá, …"
      login: usuario.login,
      admin: !!usuario.admin,
      senha_provisoria: !!r.data.senha_provisoria,
      permissoes,
      telas: TELAS.filter((t) => permissoes.includes(permTela(t.rota))).map((t) => t.arquivo),
    });
  });
};
