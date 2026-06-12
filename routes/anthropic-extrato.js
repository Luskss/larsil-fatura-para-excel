/**
 * routes/anthropic-extrato.js → usado por ai-dispatch quando aiProvider=anthropic
 * Analisa extratos bancários via Claude (mesma lógica de openai-extrato.js).
 */
'use strict';

require('../config');
const { setApiSecurityHeaders, requireAuth, callAnthropic, isNumeric, toFloat, trimStr } = require('./_helpers');

function elog(msg) { console.error('[anthropic-extrato] ' + msg); }

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
  "bankLabel":   "Nome do Banco - mês/ano",
  "periodLabel": "MM-AAAA",
  "rows": [
    {
      "data":      "DD/MM",
      "descricao": "PIX RECEBIDO - Fulano",
      "documento": "314869",
      "movimento": -1222.06,
      "saldo":     7314.51
    }
  ]
}`;

module.exports = async function anthropicExtratoRoute(req, res) {
  setApiSecurityHeaders(res);

  elog('REQ_START method=' + req.method + ' ip=' + (req.ip || '?'));

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey === '') {
    return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY não configurada.' });
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
  if (!hasImages && text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  let userContent;
  if (hasImages) {
    userContent = [{ type: 'text', text: `Arquivo: ${filename}\n\nExtrato (lido via imagem):` }];
    for (const raw of images.slice(0, 6)) {
      const b64 = String(raw).replace(/\s+/g, '');
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
      });
    }
    elog('VISION_REQ pages=' + Math.min(images.length, 6) + ' file=' + filename);
  } else {
    userContent = `Arquivo: ${filename}\n\nExtrato:\n----------\n${text}\n----------`;
  }

  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16384,
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
  const stopReason = decoded?.stop_reason ?? 'end_turn';
  const content = decoded?.content?.[0]?.text ?? '';

  let parsed = null;
  try { parsed = JSON.parse(content); } catch (_) {}

  // Tenta reparar JSON cortado por limite de tokens
  if ((!parsed || typeof parsed !== 'object') && stopReason === 'max_tokens') {
    elog('TOKEN_LIMIT_TRUNCATION: tentando reparar JSON cortado');
    const lastBrace = content.lastIndexOf('}');
    if (lastBrace !== -1) {
      let repaired = content.slice(0, lastBrace + 1) + ']}';
      repaired = repaired.replace(/,\s*\]/g, ']');
      try {
        const parsedRepaired = JSON.parse(repaired);
        if (parsedRepaired && typeof parsedRepaired === 'object') {
          parsed = parsedRepaired;
          elog('TOKEN_LIMIT_REPAIR_OK rows=' + ((parsed.rows || []).length));
        }
      } catch (_) {}
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ success: false, message: 'JSON inválido da Anthropic.', detail: content.slice(0, 500) });
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
    rows.push([dataVal, desc, doc, toFloat(mov), isNumeric(sld) ? toFloat(sld) : '']);
  }

  const result = {
    success: true,
    periodLabel: String(parsed.periodLabel ?? ''),
    bankLabel: String(parsed.bankLabel ?? ''),
    rows,
  };
  if (stopReason === 'max_tokens') {
    result.warning = 'Extrato muito longo: a IA atingiu o limite de tokens e algumas transações do final podem estar ausentes.';
  }
  res.json(result);
};
