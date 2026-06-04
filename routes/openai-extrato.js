/**
 * routes/openai-extrato.js  → POST /api/openai-extrato.php
 * Analisa extratos bancários. Espelha api/openai-extrato.php (prompt verbatim,
 * fallback Vision por imagens base64, reparo de JSON cortado por tokens).
 */
'use strict';

require('../config'); // garante .env carregado
const { setApiSecurityHeaders, requireAuth, callOpenAI, isNumeric, toFloat, trimStr } = require('./_helpers');

function elog(msg) { console.error('[openai-extrato] ' + msg); }

const systemPrompt = `Você é um analisador de EXTRATOS BANCÁRIOS brasileiros (conta corrente,
poupança, conta digital). Recebe o texto cru extraído do PDF de QUALQUER
banco (Santander, Itaú, Bradesco, Caixa, Banco do Brasil, Inter, Nubank,
C6, Sicoob, Sicredi, BTG, XP, Original, Will, Mercado Pago, etc.) e
devolve EXCLUSIVAMENTE um JSON válido com TODAS as movimentações.

ATENÇÃO CRÍTICA — EXTRAIA TODAS AS LINHAS, SEM EXCEÇÃO:
- Não pule transações. Não resuma.
- Cada linha de movimentação vira UM objeto, mesmo que o banco repita
  a mesma descrição várias vezes no mesmo dia.
- A descrição costuma ocupar 2 linhas (ex.: "PIX RECEBIDO" + nome do
  pagador na linha de baixo). Junte as duas em uma única descrição
  separada por " - " (ex.: "PIX RECEBIDO - Sandro Inocencio Vieira").
- Quando a coluna Data estiver VAZIA, herde a data da linha anterior.
- Valor de movimento com "-" no final (ex.: "1.222,06-") é DÉBITO →
  número NEGATIVO. Sem "-" é CRÉDITO → POSITIVO.
- SALDO: preencha o campo "saldo" SOMENTE quando o valor estiver
  EXPLICITAMENTE escrito naquela linha do extrato (coluna Saldo).
  NUNCA calcule, NUNCA estime, NUNCA repita o saldo da linha anterior.
  Se a coluna Saldo daquela linha estiver vazia → use null.
- Ignore: cabeçalhos, rodapés, totais, "saldo anterior", "saldo do dia",
  textos legais, paginação.

FORMATO DE SAÍDA (apenas JSON, sem markdown, sem comentários):
{
  "bankLabel":   "Nome do Banco - mês/ano",   // ou "" se desconhecido
  "periodLabel": "MM-AAAA",                   // ou ""
  "rows": [
    {
      "data":      "DD/MM",
      "descricao": "PIX RECEBIDO - Fulano",
      "documento": "314869",                  // ou "" / "-"
      "movimento": -1222.06,                  // negativo se débito
      "saldo":     7314.51                    // null se a linha não traz saldo
    }
  ]
}`;

module.exports = async function openaiExtratoRoute(req, res) {
  setApiSecurityHeaders(res);

  elog('REQ_START method=' + req.method + ' content_length=' + (req.headers['content-length'] || '?') + ' ip=' + (req.ip || '?'));

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (apiKey === '') {
    return res.status(500).json({ success: false, message: 'OPENAI_API_KEY não configurada.' });
  }

  const body = req.body || {};
  const filename = trimStr(body.filename);
  let text = String(body.text ?? '');
  const images = Array.isArray(body.images) ? body.images : null;
  const hasImages = Array.isArray(images) && images.length > 0;

  if (text === '' && !hasImages) {
    return res.status(400).json({ success: false, message: 'Texto vazio.' });
  }

  const MAX_CHARS = 120000;
  if (!hasImages && text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
  }

  const userPrompt = `Arquivo: ${filename}\n\nExtrato:\n----------\n${text}\n----------`;

  let userContent;
  if (hasImages) {
    userContent = [{ type: 'text', text: `Arquivo: ${filename}\n\nExtrato (lido via imagem):` }];
    for (const raw of images.slice(0, 6)) {
      const b64 = String(raw).replace(/\s+/g, '');
      userContent.push({
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' },
      });
    }
    elog('VISION_REQ pages=' + Math.min(images.length, 6) + ' file=' + filename);
  } else {
    userContent = userPrompt;
  }

  const payload = {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0,
    top_p: 0.1,
    max_tokens: 16384,
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
  const finishReason = decoded?.choices?.[0]?.finish_reason ?? 'stop';
  const content = decoded?.choices?.[0]?.message?.content ?? '';
  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { parsed = null; }
  let wasTruncatedByTokens = false;

  if ((!parsed || typeof parsed !== 'object') && finishReason === 'length') {
    elog('TOKEN_LIMIT_TRUNCATION: tentando reparar JSON cortado');
    const lastBrace = content.lastIndexOf('}');
    if (lastBrace !== -1) {
      let repaired = content.slice(0, lastBrace + 1) + ']}';
      repaired = repaired.replace(/,\s*\]/g, ']');
      try {
        const parsedRepaired = JSON.parse(repaired);
        if (parsedRepaired && typeof parsedRepaired === 'object') {
          parsed = parsedRepaired;
          wasTruncatedByTokens = true;
          elog('TOKEN_LIMIT_REPAIR_OK rows=' + ((parsed.rows || []).length));
        }
      } catch (_) {}
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ success: false, message: 'JSON inválido da OpenAI.', detail: content.slice(0, 500) });
  }

  const HEADER = ['Data', 'Descrição', 'Nº Documento', 'Movimento (R$)', 'Saldo (R$)'];
  const rows = [HEADER];

  for (const rrow of (parsed.rows || [])) {
    if (!rrow || typeof rrow !== 'object') continue;
    const dataVal = trimStr(rrow.data);
    const desc = trimStr(rrow.descricao);
    const doc = trimStr(rrow.documento);
    const mov = rrow.movimento ?? null;
    const sld = rrow.saldo ?? null;

    if (desc === '' || !isNumeric(mov)) continue;

    rows.push([
      dataVal,
      desc,
      doc,
      toFloat(mov),
      isNumeric(sld) ? toFloat(sld) : '',
    ]);
  }

  const result = {
    success: true,
    periodLabel: String(parsed.periodLabel ?? ''),
    bankLabel: String(parsed.bankLabel ?? ''),
    rows,
  };
  if (wasTruncatedByTokens) {
    result.warning = 'Extrato muito longo: a IA atingiu o limite de tokens e algumas transações do final podem estar ausentes.';
  }
  res.json(result);
};
