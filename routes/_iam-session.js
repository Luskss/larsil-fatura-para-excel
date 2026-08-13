/**
 * routes/_iam-session.js
 * Ponte entre a sessão do Express e a IAM Larsil.
 *
 * A sessão guarda o JWT emitido pela IAM (server-side, nunca no browser) e a
 * cópia mais recente de papéis/permissões/escopo. O middleware `iamRefresh`
 * reconsulta `GET /api/auth/resolve` a cada TTL_RESOLVE_MS para que:
 *   - permissão revogada no console /admin caia aqui sem esperar o token expirar;
 *   - conta desativada pela TI derrube a sessão na hora.
 */
'use strict';

const { iamResolve, PERM_ACESSO } = require('../iam');

/** De quanto em quanto tempo reconsultamos a IAM (env para ajustar/testar). */
const TTL_RESOLVE_MS = Number(process.env.IAM_RESOLVE_TTL_MS || 5 * 60 * 1000);
/** Se a IAM estiver fora do ar, espera este tempo antes de tentar de novo. */
const TTL_RETRY_MS = 60 * 1000;

/** Rotas liberadas mesmo com o 1º acesso (senha provisória) pendente. */
const LIVRES_NO_ONBOARDING = new Set(['/auth.php', '/logout.php', '/me', '/onboarding']);

/** Grava na sessão a identidade e o acesso vindos da IAM. */
function gravarAcesso(req, { token, usuario, senhaProvisoria }) {
  req.session.iam_token = token;
  req.session.iam_resolvido_em = Date.now();
  req.session.cf_loggedIn = true;
  req.session.cf_usuario_id = usuario.id;
  req.session.cf_username = usuario.login;
  req.session.cf_nome = usuario.nome || usuario.login;
  req.session.cf_admin = !!usuario.admin;
  req.session.cf_papeis = usuario.papeis || [];
  req.session.cf_permissoes = usuario.permissoes || [];
  req.session.cf_escopos = usuario.escopos || [];
  req.session.cf_global = !!usuario.global;
  req.session.cf_onboarding_pendente = !!senhaProvisoria;
}

/** Atualiza só a parte de acesso (o que o /resolve devolve). */
function atualizarAcesso(req, acesso) {
  req.session.cf_papeis = acesso.papeis || [];
  req.session.cf_permissoes = acesso.permissoes || [];
  req.session.cf_escopos = acesso.escopos || [];
  req.session.cf_global = !!acesso.global;
  req.session.iam_resolvido_em = Date.now();
}

/** Permissões atuais da sessão (sempre array). */
const permissoes = (req) => (req.session && req.session.cf_permissoes) || [];

/** A pessoa tem esta permissão? */
const tem = (req, codigo) => permissoes(req).includes(codigo);

/** Escopos do token — use SEMPRE isto para filtrar dados, nunca a query. */
const escopos = (req) => (req.session && req.session.cf_escopos) || [];

/**
 * Reconsulta a IAM se o acesso em cache já passou do TTL.
 * Devolve { ok: true } ou { ok: false, message } — quem chama decide se responde
 * JSON (API) ou redireciona (página HTML).
 */
async function revalidar(req) {
  const s = req.session;
  if (!s || !s.iam_token) return { ok: true };

  if (Date.now() - (s.iam_resolvido_em || 0) < TTL_RESOLVE_MS) return { ok: true };

  const r = await iamResolve(s.iam_token);

  // Espera TTL_RETRY_MS antes da próxima tentativa, em vez de bater a cada request.
  const adiar = () => { s.iam_resolvido_em = Date.now() - TTL_RESOLVE_MS + TTL_RETRY_MS; };

  if (r.erroRede) {
    // IAM indisponível: segue com o acesso em cache — a identidade já foi provada.
    console.warn('[iam] resolve falhou (mantendo acesso em cache):', r.erroRede);
    adiar();
    return { ok: true };
  }
  if (r.status === 401) return { ok: false, message: 'Sua sessão expirou. Entre novamente.' };
  if (r.status === 403) {
    return { ok: false, message: (r.data && r.data.erro) || 'Sua conta está desativada. Entre em contato com a TI da empresa.' };
  }
  if (!r.ok) {
    console.warn('[iam] resolve respondeu', r.status);
    adiar();
    return { ok: true };
  }

  atualizarAcesso(req, r.data || {});

  // Acesso ao sistema revogado no console → não adianta seguir logado aqui.
  if (!tem(req, PERM_ACESSO)) {
    return { ok: false, message: 'Seu acesso ao Conversor de Faturas foi removido. Fale com a TI.' };
  }
  return { ok: true };
}

/**
 * Middleware das rotas /api: mantém o acesso fresco e derruba sessões inválidas.
 * Não exige login — a rota de login passa direto.
 */
async function iamRefresh(req, res, next) {
  const r = await revalidar(req);
  if (!r.ok) {
    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.status(401).json({ success: false, message: r.message, sessao_encerrada: true });
    });
  }
  // Barra o resto do sistema enquanto o 1º acesso não for concluído.
  if (req.session && req.session.cf_onboarding_pendente && !LIVRES_NO_ONBOARDING.has(req.path)) {
    return res.status(428).json({
      success: false,
      onboarding_pendente: true,
      message: 'Conclua o primeiro acesso (troca da senha provisória) para continuar.',
    });
  }
  return next();
}

/**
 * Mesma revalidação, para requisições de PÁGINA: em vez de JSON, manda a pessoa
 * de volta ao login com o motivo. Sem isto, uma permissão revogada só apareceria
 * na próxima chamada de API.
 */
async function revalidarPagina(req, res) {
  const r = await revalidar(req);
  if (r.ok) return true;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect(302, '/index.html?sessao=' + encodeURIComponent(r.message));
  });
  return false;
}

/**
 * Middleware-fábrica: exige uma permissão específica.
 * Use nas rotas que pertencem a uma tela só (ex.: as de configurações).
 */
function requirePermissao(codigo) {
  return function (req, res, next) {
    if (!req.session || !req.session.cf_loggedIn) {
      return res.status(401).json({ success: false, message: 'Não autenticado.' });
    }
    if (!tem(req, codigo)) {
      return res.status(403).json({
        success: false,
        message: 'Você não tem permissão para esta ação. Peça liberação à TI.',
        permissao: codigo,
      });
    }
    return next();
  };
}

module.exports = {
  TTL_RESOLVE_MS,
  gravarAcesso,
  atualizarAcesso,
  permissoes,
  escopos,
  tem,
  iamRefresh,
  revalidarPagina,
  requirePermissao,
};
