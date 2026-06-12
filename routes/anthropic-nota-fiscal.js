/**
 * routes/anthropic-nota-fiscal.js  → usado por ai-dispatch quando aiProvider=anthropic
 * Mesma lógica de openai-nota-fiscal.js, adaptada para a API Anthropic (Claude).
 */
'use strict';

require('../config');
const { setApiSecurityHeaders, requireAuth, callAnthropic, trimStr } = require('./_helpers');
const { systemPrompt, sanitizeNotasOut } = require('./_nf-shared');

function elog(msg) { console.error('[anthropic-nf] ' + msg); }

module.exports = async function anthropicNotaFiscalRoute(req, res) {
  setApiSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey === '') {
    return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY não configurada no .env.' });
  }

  const body = req.body || {};
  const filename = trimStr(body.filename);
  let text = String(body.text ?? '');
  let images = Array.isArray(body.images) ? body.images : [];

  if (text === '' && images.length === 0) {
    return res.status(400).json({ success: false, message: 'Texto do PDF não enviado.' });
  }

  elog('REQ_START filename=' + filename + ' text_len=' + text.length + ' images=' + images.length);

  const MAX_CHARS = 10000;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  // Sanitiza imagens — converte data URI para formato Anthropic
  const validImages = [];
  for (const img of images) {
    if (typeof img !== 'string') continue;
    const m = img.match(/^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    if (img.length > 7000000) continue;
    validImages.push({ mediaType: m[1] === 'jpg' ? 'image/jpeg' : 'image/' + m[1], data: m[2] });
    if (validImages.length >= 6) break;
  }
  images = validImages;

  const useVision = images.length > 0;
  const userPromptText = `Arquivo: ${filename}\n\nTexto da nota fiscal:\n----------\n${text}\n----------`;

  let userContent;
  if (useVision) {
    userContent = [
      { type: 'text', text: userPromptText + '\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia TODOS os dados das imagens anexas.' },
      ...images.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      })),
    ];
  } else {
    userContent = userPromptText;
  }

  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  const r = await callAnthropic(apiKey, payload);
  elog('ANTHROPIC_RESP http=' + r.httpCode + ' bytes=' + (r.ok ? r.body.length : 'FALSE') + ' err=' + r.error);

  if (!r.ok) {
    return res.status(502).json({ success: false, message: 'Falha ao contatar Anthropic: ' + r.error });
  }
  if (r.httpCode < 200 || r.httpCode >= 300) {
    let detail = r.body.slice(0, 500);
    try { detail = JSON.parse(r.body).error?.message || detail; } catch (_) {}
    return res.status(502).json({ success: false, message: 'Anthropic HTTP ' + r.httpCode, detail });
  }

  let decoded;
  try { decoded = JSON.parse(r.body); } catch (_) { decoded = null; }
  const content = decoded?.content?.[0]?.text ?? '';

  let parsed = null;
  try { parsed = JSON.parse(content); } catch (_) {}
  if (!parsed) {
    const s = content.indexOf('{'), e = content.lastIndexOf('}');
    if (s >= 0 && e > s) { try { parsed = JSON.parse(content.slice(s, e + 1)); } catch (_) {} }
  }

  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ success: false, message: 'JSON inválido da Anthropic.', detail: content.slice(0, 500) });
  }

  res.json({ success: true, notas: sanitizeNotasOut(parsed) });
};
