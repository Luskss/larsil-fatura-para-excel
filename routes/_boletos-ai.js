/**
 * routes/_boletos-ai.js
 * Extrai a lista de boletos/parcelas de um documento via IA (Anthropic ou OpenAI,
 * conforme settings.json). Usado por process-folder para dividir carnês de várias
 * parcelas em entradas separadas.
 *
 * É a IA quem decide QUANTOS boletos distintos existem — resolve o que a regex não
 * conseguia: distinguir um carnê real (N 
 * 
 * 
 * 
boletos) de um documento que só menciona
 * a mesma data/valor várias vezes (boleto + recibo + ficha de compensação = 1).
 *
 * Opera sobre TEXTO (texto real do PDF ou texto do OCR) — funciona para PDFs de
 * texto e escaneados sem precisar renderizar imagem no servidor.
 *
 * Exporta: extrairBoletosAI({ text, filename }) → { boletos: [...], error }
 *   boletos: [ { vencimento: 'DD/MM/AAAA', valor: Number, nossoNumero: String } ]
 */
'use strict';

const { callOpenAI, callAnthropic, getActiveAiProvider, toFloat, isNumeric, trimStr } = require('./_helpers');

const BOLETO_PROMPT = `Você recebe o texto cru (extraído de PDF ou de OCR) de um documento bancário
brasileiro que pode conter UM boleto ou VÁRIOS boletos (um carnê de parcelas).
Sua tarefa é listar CADA boleto DISTINTO presente no documento.

════════════════════════════════════════════════════════════════
COMO CONTAR BOLETOS DISTINTOS (regra crítica)
════════════════════════════════════════════════════════════════
• Cada boleto físico tem UM "Nosso Número" e UMA "Linha Digitável"/código de barras
  próprios. Conte boletos distintos pelo NOSSO NÚMERO / LINHA DIGITÁVEL distintos.
• NUNCA conte boletos pela quantidade de vezes que a palavra "VENCIMENTO" ou um
  valor aparece. Um único boleto repete vencimento/valor em vários lugares
  (boleto + recibo do pagador + ficha de compensação) — isso é UM só boleto.
• Um documento que é uma NOTA FISCAL / FATURA com UM boleto de pagamento anexo é
  UM boleto, mesmo que o corpo da nota liste vários itens/serviços com datas.
• Só considere VÁRIOS boletos quando houver de fato Nosso Número / Linha Digitável
  DISTINTOS (ex.: carnê com parcelas mensais, cada parcela com seu próprio boleto).

Para cada boleto distinto extraia:
  - vencimento: data de vencimento no formato "DD/MM/AAAA"
  - valor: valor do documento (número decimal com ponto, ex.: 139.90)
  - nossoNumero: o "Nosso Número" do boleto (string) ou "" se não houver

Se não conseguir identificar nenhum boleto, devolva lista vazia.

Devolva APENAS JSON válido, sem markdown, sem comentários:
{
  "boletos": [
    { "vencimento": "10/03/2026", "valor": 139.90, "nossoNumero": "25/10398-7" }
  ]
}`;

// Parse data "DD/MM/AAAA" → chave comparável; null se inválida.
function vencKey(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Normaliza/valida a saída da IA: mantém só boletos com vencimento válido e
// remove duplicatas por (nossoNumero) ou, na falta dele, por (vencimento+valor).
function sanitizeBoletos(parsed) {
  const arr = Array.isArray(parsed?.boletos) ? parsed.boletos : [];
  const out = [];
  const vistos = new Set();
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    const venc = trimStr(b.vencimento);
    if (!vencKey(venc)) continue; // exige data válida
    const valor = isNumeric(b.valor) ? toFloat(b.valor) : 0;
    const nosso = trimStr(b.nossoNumero);
    const chave = nosso ? `n:${nosso}` : `v:${vencKey(venc)}|${valor.toFixed(2)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ vencimento: venc, valor, nossoNumero: nosso });
  }
  return out;
}

function extrairJson(content) {
  let parsed = null;
  try { parsed = JSON.parse(content); } catch (_) {}
  if (!parsed) {
    const s = content.indexOf('{'), e = content.lastIndexOf('}');
    if (s >= 0 && e > s) { try { parsed = JSON.parse(content.slice(s, e + 1)); } catch (_) {} }
  }
  return parsed;
}

async function extrairBoletosAI({ text, filename }) {
  const provider = getActiveAiProvider();
  let t = String(text || '');
  const MAX_CHARS = 12000;
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS);
  const userPrompt = `Arquivo: ${filename || ''}\n\nTexto do documento:\n----------\n${t}\n----------`;

  let content = '';
  if (provider === 'openai') {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return { boletos: [], error: 'OPENAI_API_KEY não configurada.' };
    const r = await callOpenAI(apiKey, {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: BOLETO_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) {
      return { boletos: [], error: `OpenAI HTTP ${r.httpCode} ${r.error}` };
    }
    try { content = JSON.parse(r.body).choices?.[0]?.message?.content ?? ''; } catch (_) {}
  } else {
    const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return { boletos: [], error: 'ANTHROPIC_API_KEY não configurada.' };
    const r = await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      temperature: 0,
      system: BOLETO_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) {
      return { boletos: [], error: `Anthropic HTTP ${r.httpCode} ${r.error}` };
    }
    try { content = JSON.parse(r.body).content?.[0]?.text ?? ''; } catch (_) {}
  }

  const parsed = extrairJson(content);
  if (!parsed) return { boletos: [], error: 'JSON inválido da IA.' };
  return { boletos: sanitizeBoletos(parsed), error: null };
}

module.exports = { extrairBoletosAI, sanitizeBoletos };