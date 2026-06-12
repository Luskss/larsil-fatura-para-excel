/**
 * routes/classify-fallback.js
 * POST /api/classify-fallback  body: { name, text }
 * Fallback de classificação por IA para UM documento, chamado automaticamente
 * pela conferência quando o conteúdo (texto + OCR) não resolveu o tipo.
 * Classifica SOMENTE pelo conteúdo do documento — o nome é meramente informativo.
 * Retorna { success, result: { category, confidence, reason } }.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = ['CONSORCIO', 'CTE', 'NF', 'NFS', 'IMPOSTO', 'FATURA', 'RECIBO'];

module.exports = async function classifyFallbackRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const body = req.body || {};
        const text = String(body.text || '').slice(0, 6000); // limita tokens

        if (text.replace(/\s/g, '').length < 15) {
            return res.json({
                success: true,
                result: { category: 'Não identificado', confidence: 'baixa', reason: 'Sem conteúdo suficiente.' },
            });
        }

        const message = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
                role: 'user',
                content: `Classifique este documento fiscal/comercial APENAS pelo seu conteúdo.

Texto do documento:
${text}

Categorias possíveis: ${CATEGORIES.join(', ')}

Responda APENAS com um JSON (sem markdown):
{
  "category": "CATEGORIA_IDENTIFICADA",
  "confidence": "alta|média|baixa",
  "reason": "breve explicação baseada no conteúdo"
}`,
            }],
        });

        let result = { category: 'Não identificado', confidence: 'baixa', reason: 'Claude não conseguiu classificar.' };
        try {
            const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) result = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.error('[classify-fallback] erro ao parsear resposta:', e.message);
        }

        if (!CATEGORIES.includes(result.category)) {
            result.category = 'Não identificado';
            result.confidence = 'baixa';
        }

        return res.json({ success: true, result });
    } catch (e) {
        console.error('[classify-fallback] erro:', e.message);
        return res.status(500).json({ success: false, message: 'Erro no servidor.' });
    }
};
