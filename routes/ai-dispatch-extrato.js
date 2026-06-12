/**
 * routes/ai-dispatch-extrato.js  → POST /api/openai-extrato.php
 * Redireciona para openai-extrato ou anthropic-extrato conforme aiProvider em settings.json.
 */
'use strict';

const { getActiveAiProvider } = require('./_helpers');

module.exports = async function aiDispatchExtrato(req, res) {
  const provider = getActiveAiProvider();
  const handler = provider === 'openai'
    ? require('./openai-extrato')
    : require('./anthropic-extrato');
  return handler(req, res);
};
