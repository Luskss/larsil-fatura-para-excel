/**
 * routes/me.js  → GET /api/me
 * Devolve ao front quem está logado e o que ele pode ver.
 * O menu e os guards das páginas são montados a partir daqui — nunca de algo
 * gravado no browser, que o usuário poderia forjar.
 */
'use strict';

const { setFullSecurityHeaders } = require('./_helpers');
const { permissoes, tem } = require('./_iam-session');
const { TELAS, permTela, PERM_ACESSO, IAM_ADMIN_URL } = require('../iam');

module.exports = function meRoute(req, res) {
  setFullSecurityHeaders(res);
  res.set('Cache-Control', 'no-store');

  if (!req.session || !req.session.cf_loggedIn) {
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
  }

  const perms = permissoes(req);

  res.json({
    success: true,
    usuario: {
      id: req.session.cf_usuario_id,
      login: req.session.cf_username,
      nome: req.session.cf_nome,
      admin: !!req.session.cf_admin,
      papeis: req.session.cf_papeis || [],
      global: !!req.session.cf_global,
      escopos: req.session.cf_escopos || [],
    },
    permissoes: perms,
    acesso: tem(req, PERM_ACESSO),
    onboarding_pendente: !!req.session.cf_onboarding_pendente,
    // arquivos que esta pessoa pode abrir — o guard do front usa para esconder links
    telas: TELAS
      .filter((t) => perms.includes(permTela(t.rota)))
      .map((t) => ({ arquivo: t.arquivo, rota: t.rota, titulo: t.descricao })),
    todas_telas: TELAS.map((t) => t.arquivo),
    iam_admin_url: IAM_ADMIN_URL,
  });
};
