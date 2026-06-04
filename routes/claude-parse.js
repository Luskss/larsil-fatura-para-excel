/**
 * routes/claude-parse.js  → POST /api/claude-parse
 * Recebe o texto extraído de um documento fiscal e usa Claude para extrair campos.
 * Suporta 6 tipos: CTE, FATURA, IMPOSTO, NF, NFS, RECIBO.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { setApiSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

const FIELDS_BY_TYPE = {
  CTE:     ['numero_cte', 'serie', 'chave_acesso', 'data_emissao', 'cnpj_emitente', 'remetente', 'destinatario', 'valor_total_prestacao', 'valor_carga'],
  FATURA:  ['numero_fatura', 'data_emissao', 'vencimento', 'cnpj_emitente', 'nome_emitente', 'descricao', 'valor_total'],
  IMPOSTO: ['tipo_guia', 'codigo_receita', 'competencia', 'periodo_apuracao', 'numero_documento', 'cnpj_cpf', 'vencimento', 'valor_principal', 'multa', 'juros', 'valor_total'],
  NF:      ['numero_nfe', 'serie', 'chave_acesso', 'data_emissao', 'cnpj_emitente', 'nome_emitente', 'cnpj_destinatario', 'nome_destinatario', 'natureza_operacao', 'valor_produtos', 'valor_icms', 'valor_total'],
  NFS:     ['numero_nfse', 'data_emissao', 'cnpj_prestador', 'nome_prestador', 'cnpj_tomador', 'nome_tomador', 'descricao_servico', 'valor_servico', 'aliquota_iss', 'iss_retido', 'valor_liquido'],
  RECIBO:  ['numero_recibo', 'data', 'pagador', 'beneficiario', 'descricao', 'valor'],
};

let _client;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

module.exports = async function claudeParseRoute(req, res) {
  setApiSecurityHeaders(res);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  }
  if (!requireAuth(req, res)) return;

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(500).json({ success: false, message: 'ANTHROPIC_API_KEY não configurada no .env.' });
  }

  const { text, tipo } = req.body || {};
  if (!text || !tipo) {
    return res.status(400).json({ success: false, message: 'text e tipo são obrigatórios.' });
  }

  const tipoUpper = String(tipo).toUpperCase();
  const fields = FIELDS_BY_TYPE[tipoUpper] || ['cnpj', 'data_emissao', 'valor_total'];
  const fieldsJson = fields.map(f => `"${f}": "valor ou null"`).join(', ');

  try {
    const message = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: 'Você é um parser de documentos fiscais brasileiros. Extraia campos do texto e responda SOMENTE com JSON válido, sem markdown, sem explicações.',
      messages: [
        {
          role: 'user',
          content: `Tipo do documento: ${tipoUpper}\nCampos a extrair: ${fields.join(', ')}\n\nResponda com JSON neste formato:\n{${fieldsJson}}\n\nTexto do documento:\n${String(text).slice(0, 6000)}`,
        },
      ],
    });

    let campos;
    try {
      campos = JSON.parse(message.content[0].text);
    } catch {
      campos = { raw: message.content[0].text };
    }

    res.json({ success: true, tipo: tipoUpper, campos });
  } catch (err) {
    console.error('[claude-parse] erro:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
