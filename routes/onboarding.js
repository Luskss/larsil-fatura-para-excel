/**
 * routes/onboarding.js  → POST /api/onboarding
 * Primeiro acesso: troca a senha provisória e coleta telefone/e-mail.
 * Proxy de POST /api/auth/onboarding da IAM, usando o token da sessão.
 */
'use strict';

const { setFullSecurityHeaders } = require('./_helpers');
const { iamOnboarding } = require('../iam');

module.exports = async function onboardingRoute(req, res) {
  setFullSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!req.session || !req.session.iam_token) {
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
  }

  const { novaSenha, telefone, email } = req.body || {};
  if (!novaSenha || String(novaSenha).length < 6) {
    return res.status(400).json({ success: false, message: 'A nova senha deve ter ao menos 6 caracteres.' });
  }

  const r = await iamOnboarding(req.session.iam_token, { novaSenha, telefone, email });

  if (r.erroRede) {
    console.error('[onboarding] IAM inacessível:', r.erroRede);
    return res.status(503).json({ success: false, message: 'Não foi possível falar com o sistema de login. Tente de novo.' });
  }
  if (!r.ok) {
    return res.status(r.status || 502).json({
      success: false,
      message: (r.data && r.data.erro) || 'Não foi possível concluir o primeiro acesso.',
    });
  }

  req.session.cf_onboarding_pendente = false;
  res.json({ success: true, message: 'Primeiro acesso concluído.' });
};
