/**
 * routes/usuarios.js  → /api/usuarios.php
 * APOSENTADO. A gestão de usuários deste sistema não existe mais: identidade,
 * senha e acesso são da IAM Larsil ("uma pessoa = uma identidade").
 *
 * A rota continua no ar só para responder de forma explicável a qualquer front
 * antigo em cache, apontando para o console da TI.
 */
'use strict';

const { setFullSecurityHeaders } = require('./_helpers');
const { IAM_ADMIN_URL } = require('../iam');

module.exports = function usuariosRoute(req, res) {
  setFullSecurityHeaders(res);
  return res.status(410).json({
    success: false,
    message: 'A gestão de usuários passou a ser feita no Painel ADM da Larsil (IAM).',
    iam_admin_url: IAM_ADMIN_URL,
  });
};
