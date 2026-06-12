/**
 * routes/ai-dispatch-parse.js  → POST /api/openai-parse.php
 * Redireciona para openai-parse ou anthropic-parse conforme aiProvider em settings.json.
 */
'use strict';

const { getActiveAiProvider } = require('./_helpers');

module.exports = async function aiDispatchParse(req, res) {
  const provider = getActiveAiProvider();
  const handler = provider === 'openai'
    ? require('./openai-parse')
    : require('./anthropic-parse');
  return handler(req, res);
};
