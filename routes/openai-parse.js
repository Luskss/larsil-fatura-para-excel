/**
 * routes/openai-parse.js  → POST /api/openai-parse.php
 * Recebe o texto extraído de um PDF de fatura de cartão e pede ao GPT para
 * extrair as transações. Espelha api/openai-parse.php (prompt verbatim e
 * mesma conversão para o formato sheetsMap).
 */
'use strict';

const { getConnection } = require('../config'); // garante .env carregado
const { setApiSecurityHeaders, requireAuth, callOpenAI, isNumeric, toFloat, trimStr } = require('./_helpers');

function elog(msg) { console.error('[openai-parse] ' + msg); }

const systemPrompt = `Você é um analisador de faturas de cartão de crédito brasileiras. Recebe o
texto cru (extraído por OCR/PDF) de uma fatura de QUALQUER banco (Itaú,
Bradesco, Santander, Nubank, Caixa, Banco do Brasil, Inter, C6, Sicoob,
Sicredi, BTG, XP, Original, Will, Mercado Pago, PicPay, etc.) e devolve
EXCLUSIVAMENTE um JSON válido com as transações extraídas.

REGRAS:
1. Identifique cada CARTÃO presente na fatura (titular + 4 últimos dígitos).
   - Rótulo do cartão: "NOME SOBRENOME - final 1234".
   - Se a fatura tiver vários cartões/portadores, separe cada um em sua chave.
   - Se não houver identificação clara, use "Fatura".
2. Para cada cartão, agrupe as transações em até 3 SEÇÕES, nesta ordem:
      "PAGAMENTO E DEMAIS CRÉDITOS"
      "DESPESAS"
      "PARCELAMENTOS"
   Pule seções vazias.
3. Cada transação tem: Data (DD/MM), Descrição (curta, sem códigos lixo),
   Parcela (formato "NN/NN" se houver, senão ""), Valor (número decimal
   com ponto, sinal NEGATIVO para créditos/pagamentos/estornos).
4. Detecte o período da fatura no formato "MM-AAAA" (mês de vencimento ou
   referência). Se não for possível, devolva "".
5. NÃO invente transações. Ignore: limites, anuidades, taxas resumo,
   cabeçalhos, totais, "saldo anterior", "valor total da fatura".
6. Devolva APENAS o JSON no formato:
{
  "periodLabel": "MM-AAAA" ou "",
  "cards": [
    {
      "label": "NOME - final 1234",
      "sections": {
        "PAGAMENTO E DEMAIS CRÉDITOS": [
          {"data":"DD/MM","descricao":"...","parcela":"","valor":-123.45}
        ],
        "DESPESAS": [
          {"data":"DD/MM","descricao":"...","parcela":"02/10","valor":99.90}
        ],
        "PARCELAMENTOS": []
      }
    }
  ]
}
Sem texto fora do JSON. Sem markdown. Sem comentários.`;

module.exports = async function openaiParseRoute(req, res) {
  setApiSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (apiKey === '') {
    return res.status(500).json({ success: false, message: 'Chave OPENAI_API_KEY não configurada no .env.' });
  }

  const data = req.body || {};
  const filename = trimStr(data.filename);
  let text = String(data.text ?? '');

  if (text === '') {
    return res.status(400).json({ success: false, message: 'Texto do PDF não enviado.' });
  }

  elog('REQ_START filename=' + filename + ' text_len=' + text.length);

  const MAX_CHARS = 120000;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

  const userPrompt = `Arquivo: ${filename}\n\nTexto da fatura:\n----------\n${text}\n----------`;

  const payload = {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0,
    top_p: 0.1,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  const r = await callOpenAI(apiKey, payload);
  if (!r.ok) {
    return res.status(502).json({ success: false, message: 'Falha ao contatar OpenAI: ' + r.error });
  }
  if (r.httpCode < 200 || r.httpCode >= 300) {
    let detail = r.body.slice(0, 500);
    try { detail = JSON.parse(r.body).error.message || detail; } catch (_) {}
    return res.status(502).json({ success: false, message: 'OpenAI retornou HTTP ' + r.httpCode, detail });
  }

  let decoded;
  try { decoded = JSON.parse(r.body); } catch (_) { decoded = null; }
  const content = decoded?.choices?.[0]?.message?.content ?? '';
  if (content === '') {
    return res.status(502).json({ success: false, message: 'Resposta vazia da OpenAI.' });
  }

  let parsed;
  try { parsed = JSON.parse(content); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return res.status(502).json({ success: false, message: 'Resposta da OpenAI não é JSON válido.', detail: content.slice(0, 500) });
  }

  // ── Conversão para o formato sheetsMap do conversor ──────────────────
  const HEADER = ['Data', 'Descrição', 'Parcela', 'Valor (R$)'];
  const sheetsMap = {};

  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  if (cards.length === 0) {
    sheetsMap['Fatura'] = [HEADER];
  } else {
    for (const card of cards) {
      const label = trimStr(card?.label) || 'Fatura';
      const sheet = [HEADER];

      const sectionsOrder = ['PAGAMENTO E DEMAIS CRÉDITOS', 'DESPESAS', 'PARCELAMENTOS'];
      const sectionsObj = card?.sections || {};

      for (const secName of sectionsOrder) {
        const rows = sectionsObj[secName];
        if (!Array.isArray(rows) || rows.length === 0) continue;

        sheet.push([`── ${secName} ──`, '', '', '']);
        for (const tx of rows) {
          if (!tx || typeof tx !== 'object') continue;
          const dataVal = trimStr(tx.data);
          const descricao = trimStr(tx.descricao);
          const parcela = trimStr(tx.parcela);
          const valor = tx.valor ?? null;

          if (descricao === '' || !isNumeric(valor)) continue;
          sheet.push([dataVal, descricao, parcela, toFloat(valor)]);
        }
      }

      let finalLabel = label;
      let n = 2;
      while (Object.prototype.hasOwnProperty.call(sheetsMap, finalLabel)) {
        finalLabel = `${label} (${n})`;
        n++;
      }
      sheetsMap[finalLabel] = sheet;
    }
  }

  res.json({
    success: true,
    periodLabel: String(parsed.periodLabel ?? ''),
    sheetsMap,
  });
};
