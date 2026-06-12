/**
 * routes/ai-dispatch-nota-fiscal-resumo.js  → POST /api/openai-nota-fiscal-resumo.php
 * Redireciona para openai-nota-fiscal-resumo ou anthropic-nota-fiscal-resumo conforme aiProvider.
 */
'use strict';

const { getActiveAiProvider } = require('./_helpers');

module.exports = async function aiDispatchNotaFiscalResumo(req, res) {
  const provider = getActiveAiProvider();
  const handler = provider === 'openai'
    ? require('./openai-nota-fiscal-resumo')
    : require('./anthropic-nota-fiscal-resumo');
  return handler(req, res);
};
