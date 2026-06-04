/**
 * routes/openai-nota-fiscal-resumo.js  → POST /api/openai-nota-fiscal-resumo.php
 * Resumo simples de Nota Fiscal por IA. Espelha api/openai-nota-fiscal-resumo.php.
 */
'use strict';

require('../config'); // garante .env carregado
const { setApiSecurityHeaders, requireAuth, callOpenAI, isNumeric, toFloat, trimStr } = require('./_helpers');

function relog(msg) { console.error('[openai-nf-resumo] ' + msg); }

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
                    (logradouro, número, bairro, município, UF, CEP — o que estiver disponível)
  - itens         : lista contendo APENAS o campo descricao de cada produto/serviço
                    Ex.: [{ "descricao": "..." }, { "descricao": "..." }]
  - totalNF       : valor total da nota como número decimal (ponto como separador)

REGRAS:
1. Identifique TODAS as notas presentes (pode haver mais de uma por PDF).
2. NÃO inclua nenhum outro campo (sem itens detalhados, sem impostos, sem fazenda etc.).
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

module.exports = async function openaiNotaFiscalResumoRoute(req, res) {
  setApiSecurityHeaders(res);

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

  relog('REQ_START filename=' + filename + ' text_len=' + text.length + ' images=' + images.length);

  const MAX_CHARS = 120000;
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
      { type: 'text', text: userPrompt + '\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia os dados das imagens anexas.' },
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
    max_tokens: 8000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  const r = await callOpenAI(apiKey, payload);
  relog('OPENAI_RESP http=' + r.httpCode + ' bytes=' + (r.ok ? r.body.length : 'FALSE') + ' curl_err=' + r.error);

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
      emitente: {
        razaoSocial: rclean(nota.emitente?.razaoSocial),
        cnpj: emiCnpj,
      },
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
