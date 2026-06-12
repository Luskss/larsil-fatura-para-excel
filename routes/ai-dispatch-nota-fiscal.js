/**
 * routes/ai-dispatch-nota-fiscal.js  → POST /api/openai-nota-fiscal.php
 * Redireciona para openai-nota-fiscal ou anthropic-nota-fiscal conforme aiProvider em settings.json.
 */
'use strict';

const { getActiveAiProvider } = require('./_helpers');

module.exports = async function aiDispatchNotaFiscal(req, res) {
  const provider = getActiveAiProvider();
  const handler = provider === 'openai'
    ? require('./openai-nota-fiscal')
    : require('./anthropic-nota-fiscal');
  return handler(req, res);
};
