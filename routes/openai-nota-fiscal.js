/**
 * routes/openai-nota-fiscal.js  → usado por ai-dispatch quando aiProvider=openai
 * Extrai dados estruturados de Notas Fiscais via GPT-4o-mini / GPT-4o (Vision).
 */
'use strict';

require('../config');
const { setApiSecurityHeaders, requireAuth, callOpenAI } = require('./_helpers');
const { systemPrompt, sanitizeNotasOut } = require('./_nf-shared');
const { trimStr } = require('./_helpers');

function elog(msg) { console.error('[openai-nf] ' + msg); }

module.exports = async function openaiNotaFiscalRoute(req, res) {
  setApiSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (apiKey === '') {
    return res.status(500).json({ success: false, message: 'OPENAI_API_KEY não configurada no .env.' });
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

  const validImages = [];
  for (const img of images) {
    if (typeof img !== 'string') continue;
    if (!/^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/.test(img)) continue;
    if (img.length > 7000000) continue;
    validImages.push(img);
    if (validImages.length >= 6) break;
  }
  images = validImages;

  const userPrompt = `Arquivo: ${filename}\n\nTexto da nota fiscal:\n----------\n${text}\n----------`;

  const useVision = images.length > 0;
  let userContent;
  if (useVision) {
    userContent = [
      { type: 'text', text: userPrompt + '\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia TODOS os dados das imagens anexas.' },
      ...images.map((img) => ({ type: 'image_url', image_url: { url: img, detail: 'high' } })),
    ];
  } else {
    userContent = userPrompt;
  }

  const payload = {
    model: useVision ? 'gpt-4o' : 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0,
    top_p: 0.1,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  const r = await callOpenAI(apiKey, payload);
  elog('OPENAI_RESP http=' + r.httpCode + ' bytes=' + (r.ok ? r.body.length : 'FALSE') + ' err=' + r.error);

  if (!r.ok) {
    return res.status(502).json({ success: false, message: 'Falha ao contatar OpenAI: ' + r.error });
  }
  if (r.httpCode < 200 || r.httpCode >= 300) {
    let detail = r.body.slice(0, 500);
    try { detail = JSON.parse(r.body).error.message || detail; } catch (_) {}
    return res.status(502).json({ success: false, message: 'OpenAI HTTP ' + r.httpCode, detail });
  }

  let decoded;
  try { decoded = JSON.parse(r.body); } catch (_) { decoded = null; }
  const content = decoded?.choices?.[0]?.message?.content ?? '';
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { parsed = null; }

  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ success: false, message: 'JSON inválido da OpenAI.', detail: content.slice(0, 500) });
  }

  res.json({ success: true, notas: sanitizeNotasOut(parsed) });
};
