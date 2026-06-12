/**
 * routes/_nf-ai-full.js
 * Leitura COMPLETA de um documento via IA (Anthropic ou OpenAI, conforme settings.json).
 * Usado pelo modo "Forçar Leitura via IA" (force-scan-ai) quando os parsers locais de
 * regex não dão conta de um documento.
 *
 * A IA recebe o TEXTO cru (texto real do PDF ou texto do OCR) e devolve, de uma só vez,
 * tudo que o pipeline de conferência precisa:
 *   • TIPO       — uma das 7 categorias do sistema (CONSORCIO/CTE/FATURA/IMPOSTO/NF/NFS/RECIBO)
 *   • EMITENTE   — quem EMITE o documento (não o destinatário/tomador/pagador)
 *   • CNPJ       — CNPJ/CPF do emitente
 *   • DATA       — data de emissão (e vencimento, quando houver boleto)
 *   • NÚMERO     — número da NF/CT-e/guia + Ordem de Compra (OCP), quando houver
 *   • VALOR      — valor total do documento
 *   • PARCELADA  — lista de boletos DISTINTOS (carnê), contados por Nosso Número/Linha
 *                  Digitável distintos — não pela repetição de "VENCIMENTO".
 *
 * Codifica os padrões aprendidos em produção (ver memória do projeto):
 *   - emitente público (DARF/GPS/FGTS) → IMPOSTO, mas SEM falso positivo por endereço
 *     ("Estado de MG"/"Secretaria" num endereço NÃO torna o doc um imposto — ex.: Localiza);
 *   - carnê real = N boletos com Nosso Número distintos (boleto+recibo+ficha = 1 boleto);
 *   - emitente ≠ destinatário (em boleto, emitente é o BENEFICIÁRIO/CEDENTE).
 *
 * Exporta: extrairNotaAI({ text, filename, pages }) → { ...campos, error }
 */
'use strict';

const { callOpenAI, callAnthropic, getActiveAiProvider, toFloat, isNumeric, trimStr } = require('./_helpers');

// As 7 categorias canônicas do sistema (mesmas de _nf-parsers.classify).
const TIPOS_VALIDOS = ['CONSORCIO', 'CTE', 'FATURA', 'IMPOSTO', 'NF', 'NFS', 'RECIBO'];

const FULL_PROMPT = `Você é um analisador de documentos financeiros brasileiros (notas fiscais, faturas,
boletos, carnês, guias de imposto, recibos e consórcios). Recebe o texto cru extraído de
um PDF (texto real ou de OCR) e o NOME DO ARQUIVO, e devolve EXCLUSIVAMENTE um JSON com os
dados estruturados do documento.

════════════════════════════════════════════════════════════════
1) TIPO — classifique em EXATAMENTE UMA destas 7 categorias (em CAIXA ALTA):
════════════════════════════════════════════════════════════════
• "NF"        → Nota Fiscal de PRODUTO. Marcadores: "DANFE", "NOTA FISCAL ELETRÔNICA",
                "NF-e", "DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA", "NATUREZA DA OPERAÇÃO".
• "NFS"       → Nota Fiscal de SERVIÇO. Marcadores: "NFS-e", "NOTA FISCAL DE SERVIÇOS",
                "DANFSe", "PRESTADOR DO SERVIÇO", "TOMADOR DO SERVIÇO", "ISS".
• "CTE"       → Conhecimento de Transporte. Marcadores: "DACTE", "CT-e", "MDF-e",
                "CONHECIMENTO DE TRANSPORTE", "TRANSPORTE RODOVIÁRIO DE CARGAS".
• "IMPOSTO"   → Guia de tributo de ÓRGÃO PÚBLICO. Marcadores: "DARF", "GPS", "INSS",
                "FGTS", "DCTFWeb", "GNRE", "GUIA DA PREVIDÊNCIA SOCIAL", "GUIA DO FGTS",
                "ARRECADAÇÃO DE RECEITAS FEDERAIS". O emitente é a União/Receita/Prefeitura/Estado.
• "CONSORCIO" → Consórcio. Marcadores: "CONSÓRCIO", "COTA DE CONSÓRCIO", "PARCELA DE CONSÓRCIO",
                "ADMINISTRADORA DE CONSÓRCIOS", "GRUPO/COTA".
• "FATURA"    → Fatura de concessionária/serviço contínuo (água, luz, telefone, internet,
                locação) que NÃO é NF-e/NFS-e. Marcador típico: "FATURA".
• "RECIBO"    → Recibo ou qualquer outro documento que não se encaixe acima.

REGRA DE PRECEDÊNCIA (crítica):
- Se houver marcador FORTE de NF/NFS/CTE (DANFE, NFS-e, DACTE...), o tipo é esse — MESMO que
  o emitente seja um órgão público. (EXCEÇÃO: pacote multi-documento, regra abaixo.)
- Só classifique "IMPOSTO" quando o documento É DE FATO uma guia de tributo (DARF/GPS/FGTS/etc.).
  ⛔ NÃO classifique como IMPOSTO só porque aparece "Estado de", "Secretaria", "Município",
     "União" ou "Prefeitura" em um ENDEREÇO, cláusula ou rodapé. Isso é falso positivo
     (ex.: uma locadora com endereço em MG NÃO é imposto). Olhe o TIPO REAL do documento.

REGRA DE PACOTE MULTI-DOCUMENTO (crítica):
- Um único PDF pode conter VÁRIOS documentos fiscais DISTINTOS — ex.: um boleto/FATURA
  (duplicata) que CONSOLIDA uma NF-e e/ou uma NFS-e anexas, cada uma com seu PRÓPRIO número e
  valor. Nesse caso há UM documento PRINCIPAL: o que está sendo PAGO (a FATURA/duplicata/boleto).
- numeroDocumento, valorTotal e dataVencimento devem vir TODOS do MESMO documento (o principal).
  ⛔ O erro mais comum: misturar o NÚMERO de uma NFS-e/NF-e anexa com o VALOR do boleto. NÃO faça.
- Quando o PDF agrupa fatura + anexos e o NOME DO ARQUIVO traz o número da fatura (ex.: "FT11610",
  "FAT 11610"), use ESSE número em numeroDocumento e classifique tipo="FATURA". Essa regra
  SOBREPÕE a precedência acima — as NF-e/NFS-e anexas são só comprovação, não o que se paga.

════════════════════════════════════════════════════════════════
2) EMITENTE e CNPJ — quem EMITE o documento (recebe o pagamento)
════════════════════════════════════════════════════════════════
• emitente = razão social de quem EMITIU o documento / o BENEFICIÁRIO do pagamento.
  - Em NF-e/NFS-e: bloco "EMITENTE" / "PRESTADOR DO SERVIÇO".
  - Em boleto/carnê: o "BENEFICIÁRIO" / "CEDENTE" (quem recebe), NÃO o "PAGADOR"/"SACADO".
  - Em guia de imposto: o órgão público (ex.: "RECEITA FEDERAL", "PREFEITURA DE ...").
• ⛔ NUNCA confunda com o DESTINATÁRIO/TOMADOR/PAGADOR (o cliente que paga).
• ⛔ NUNCA use rótulos como valor: "DESTINATÁRIO", "CNPJ", "CPF", "DATA DE EMISSÃO",
     "ENDEREÇO", "MUNICÍPIO", "INSCRIÇÃO". Se não achar o nome real, devolva "".
• cnpj = CNPJ ("XX.XXX.XXX/XXXX-XX") ou CPF ("XXX.XXX.XXX-XX") DO EMITENTE. Copie como está.
  Se o documento só tiver o CNPJ do pagador e não o do emitente, devolva "".
• Se o texto estiver vazio/ilegível, tente extrair o emitente do NOME DO ARQUIVO
  (padrão comum: "NNN.DOC- valor - AAAA.MM.DD. EMITENTE. TIPO numero").

════════════════════════════════════════════════════════════════
3) DATA, NÚMERO, VALOR
════════════════════════════════════════════════════════════════
• dataEmissao   → data de emissão do documento "DD/MM/AAAA" (ou a data do nome do arquivo).
• dataVencimento → data de vencimento "DD/MM/AAAA" quando o documento for/tiver UM boleto de
                   pagamento. Em carnê (vários boletos), deixe "" e liste em "parcelas". Senão "".
• numeroDocumento → número da NF / CT-e / NFS-e / guia (apenas dígitos, sem zeros à esquerda).
• ordemCompra   → número da "ORDEM DE COMPRA - OCP", se houver (apenas dígitos). Senão "".
• valorTotal    → valor total do documento (número decimal com ponto, ex.: 1234.56).
                  Em boleto, é o valor a pagar; em NF, o "VALOR TOTAL DA NOTA".

════════════════════════════════════════════════════════════════
4) PARCELADA — carnê com VÁRIOS boletos (regra crítica)
════════════════════════════════════════════════════════════════
• Conte boletos DISTINTOS pelo "NOSSO NÚMERO" / "LINHA DIGITÁVEL" / código de barras DISTINTOS.
• ⛔ NUNCA conte boletos pela quantidade de vezes que "VENCIMENTO" ou um valor aparece. Um
     único boleto repete vencimento/valor em vários lugares (boleto + recibo do pagador +
     ficha de compensação) — isso é UM só boleto.
• Uma NOTA FISCAL/FATURA com UM boleto anexo é UM boleto, mesmo que liste vários itens/datas.
• Só devolva VÁRIAS parcelas quando houver de fato Nosso Número/Linha Digitável DISTINTOS
  (carnê com parcelas mensais, cada uma com seu próprio boleto).
• parcelada = true somente quando "parcelas" tiver 2 ou mais itens distintos.
• Para cada parcela: { "vencimento": "DD/MM/AAAA", "valor": 139.90, "nossoNumero": "25/10398-7" }.
  Se o documento tiver um só boleto, devolva "parcelas": [] e parcelada=false.

════════════════════════════════════════════════════════════════
SAÍDA — APENAS JSON válido, sem markdown, sem comentários:
════════════════════════════════════════════════════════════════
{
  "tipo": "NF",
  "emitente": "RAZÃO SOCIAL DO EMITENTE LTDA",
  "cnpj": "12.345.678/0001-90",
  "dataEmissao": "10/03/2026",
  "dataVencimento": "",
  "numeroDocumento": "12345",
  "ordemCompra": "",
  "valorTotal": 1234.56,
  "parcelada": false,
  "parcelas": []
}`;

// "DD/MM/AAAA" → chave comparável "AAAA-MM-DD"; null se inválida.
function vencKey(v) {
  const m = String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const CNPJ_OU_CPF = /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})\b/;
// Aceita CNPJ/CPF com ou sem máscara; devolve formatado se reconhecer, senão "".
function limparCnpj(v) {
  const s = trimStr(v);
  const m = s.match(CNPJ_OU_CPF);
  if (m) return m[1];
  const d = s.replace(/\D/g, '');
  if (d.length === 14) return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
  return '';
}

// Dedup de parcelas: por Nosso Número; na falta dele, por (vencimento+valor).
function sanitizeParcelas(arr) {
  const out = [];
  const vistos = new Set();
  for (const b of (Array.isArray(arr) ? arr : [])) {
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

// Normaliza/valida a saída da IA num formato estável.
function sanitizeResultado(parsed) {
  const tipoRaw = trimStr(parsed?.tipo).toUpperCase();
  const tipo = TIPOS_VALIDOS.includes(tipoRaw) ? tipoRaw : '';
  const numero = trimStr(parsed?.numeroDocumento).replace(/\D/g, '').replace(/^0+/, '');
  const ocp = trimStr(parsed?.ordemCompra).replace(/\D/g, '').replace(/^0+/, '');
  const parcelas = sanitizeParcelas(parsed?.parcelas);
  return {
    tipo,
    emitente: trimStr(parsed?.emitente),
    cnpj: limparCnpj(parsed?.cnpj),
    dataEmissao: trimStr(parsed?.dataEmissao),
    dataVencimento: trimStr(parsed?.dataVencimento),
    numero,
    ordemCompra: ocp,
    valorTotal: isNumeric(parsed?.valorTotal) ? toFloat(parsed.valorTotal) : 0,
    parcelada: parcelas.length > 1,
    parcelas,
  };
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

async function extrairNotaAI({ text, filename, pages }) {
  const provider = getActiveAiProvider();
  let t = String(text || '');
  const MAX_CHARS = 14000;
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS);
  const userPrompt =
    `Arquivo: ${filename || ''}\nPáginas: ${pages || '?'}\n\nTexto do documento:\n----------\n${t}\n----------`;

  let content = '';
  if (provider === 'openai') {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return { ...sanitizeResultado(null), error: 'OPENAI_API_KEY não configurada.' };
    const r = await callOpenAI(apiKey, {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: FULL_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) {
      return { ...sanitizeResultado(null), error: `OpenAI HTTP ${r.httpCode} ${r.error}` };
    }
    try { content = JSON.parse(r.body).choices?.[0]?.message?.content ?? ''; } catch (_) {}
  } else {
    const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) return { ...sanitizeResultado(null), error: 'ANTHROPIC_API_KEY não configurada.' };
    const r = await callAnthropic(apiKey, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      temperature: 0,
      system: FULL_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) {
      return { ...sanitizeResultado(null), error: `Anthropic HTTP ${r.httpCode} ${r.error}` };
    }
    try { content = JSON.parse(r.body).content?.[0]?.text ?? ''; } catch (_) {}
  }

  const parsed = extrairJson(content);
  if (!parsed) return { ...sanitizeResultado(null), error: 'JSON inválido da IA.' };
  return { ...sanitizeResultado(parsed), error: null };
}

module.exports = { extrairNotaAI, sanitizeResultado, TIPOS_VALIDOS };