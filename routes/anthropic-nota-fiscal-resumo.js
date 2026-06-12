/**
 * routes/anthropic-nota-fiscal-resumo.js → usado por ai-dispatch quando aiProvider=anthropic
 * Resumo simples de Nota Fiscal via Claude.
 */
'use strict';

require('../config');
const { setApiSecurityHeaders, requireAuth, callAnthropic, isNumeric, toFloat, trimStr } = require('./_helpers');

function relog(msg) { console.error('[anthropic-nf-resumo] ' + msg); }

const systemPrompt = `Você é um analisador de Notas Fiscais brasileiras (NF-e, NFS-e, NF de papel).
Sua tarefa é gerar um RESUMO SIMPLES de cada nota presente no texto, extraindo
APENAS os campos abaixo. Devolva EXCLUSIVAMENTE um JSON válido.

Campos a extrair, por nota:
  - numero        : número da NF (somente dígitos, sem zeros à esquerda obrigatórios)
  - dataEmissao   : data de emissão no formato "DD/MM/AAAA"
  - emitente:
      razaoSocial : nome da empresa/pessoa emitente
      cnpj        : "XX.XXX.XXX/XXXX-XX" ou "XXX.XXX.XXX-XX" (CPF)
  - destinatario:
      razaoSocial : nome da empresa/pessoa destinatária
      cnpj        : "XX.XXX.XXX/XXXX-XX" ou "XXX.XXX.XXX-XX" (CPF)
      endereco    : endereço completo do destinatário em uma única string
  - itens         : lista contendo APENAS o campo descricao de cada produto/serviço
  - totalNF       : valor total da nota como número decimal (ponto como separador)

REGRAS:
1. Identifique TODAS as notas presentes (pode haver mais de uma por PDF).
2. NÃO inclua nenhum outro campo.
3. Se algum campo não puder ser determinado, use "" para strings e 0 para números.
4. NUNCA invente. Use apenas o que estiver explicitamente no texto/imagem.
5. NUNCA use rótulos ("CNPJ", "DESTINATÁRIO", "DATA DE EMISSÃO") como valor.
6. Devolva APENAS este JSON, sem markdown ou comentários:

{
  "notas": [
    {
      "numero": "123",
      "dataEmissao": "DD/MM/AAAA",
      "emitente":     { "razaoSocial": "...", "cnpj": "..." },
      "destinatario": { "razaoSocial": "...", "cnpj": "...", "endereco": "..." },
      "itens": [ { "descricao": "..." } ],
      "totalNF": 100.0
    }
  ]
}`;

const CNPJ_OR_CPF = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

function rclean(v) {
  let s = trimStr(v);
  s = s.replace(/(?:^|\s*[-–]\s*)(?:null|undefined|n\/a)\s*$/i, '');
  return s.trim();
}

module.exports = async function anthropicNotaFiscalResumoRoute(req, res) {
  setApiSecurityHeaders(res);

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

  relog('REQ_START filename=' + filename + ' text_len=' + text.length + ' images=' + images.length);

  const MAX_CHARS = 120000;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

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
      { type: 'text', text: userPromptText + '\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia os dados das imagens anexas.' },
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
    max_tokens: 8000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  const r = await callAnthropic(apiKey, payload);
  relog('ANTHROPIC_RESP http=' + r.httpCode + ' bytes=' + (r.ok ? r.body.length : 'FALSE') + ' err=' + r.error);

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

  const notas = Array.isArray(parsed.notas) ? parsed.notas : [];
  const notasOut = [];

  for (const nota of notas) {
    if (!nota || typeof nota !== 'object') continue;

    const itensOut = [];
    for (const item of (Array.isArray(nota.itens) ? nota.itens : [])) {
      if (!item || typeof item !== 'object') continue;
      const desc = rclean(item.descricao);
      if (desc === '') continue;
      itensOut.push({ descricao: desc });
    }

    let emiCnpj = rclean(nota.emitente?.cnpj);
    if (emiCnpj !== '' && !CNPJ_OR_CPF.test(emiCnpj)) emiCnpj = '';
    let destCnpj = rclean(nota.destinatario?.cnpj);
    if (destCnpj !== '' && !CNPJ_OR_CPF.test(destCnpj)) destCnpj = '';

    notasOut.push({
      numero: rclean(nota.numero),
      dataEmissao: rclean(nota.dataEmissao),
      emitente: { razaoSocial: rclean(nota.emitente?.razaoSocial), cnpj: emiCnpj },
      destinatario: {
        razaoSocial: rclean(nota.destinatario?.razaoSocial),
        cnpj: destCnpj,
        endereco: rclean(nota.destinatario?.endereco),
      },
      itens: itensOut,
      totalNF: isNumeric(nota.totalNF) ? toFloat(nota.totalNF) : 0,
    });
  }

  res.json({ success: true, notas: notasOut });
};
