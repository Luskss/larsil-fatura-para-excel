/**
 * routes/classify-unidentified.js
 * POST: envia documentos "Não identificado" para Claude Haiku classificar
 * Retorna a categoria identificada para cada documento
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');

const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const CATEGORIES = ['CONSORCIO', 'CTE', 'NF', 'NFS', 'IMPOSTO', 'FATURA', 'RECIBO'];

module.exports = async function classifyUnidentifiedRoute(req, res) {
    setFullSecurityHeaders(res);

    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const body = req.body || {};
        const documents = body.documents || []; // Array de { name, text, conteudo }

        if (!Array.isArray(documents) || documents.length === 0) {
            return res.status(400).json({ success: false, message: 'Nenhum documento fornecido.' });
        }

        const results = [];

        // Processa cada documento
        for (const doc of documents) {
            if (!doc.text && !doc.conteudo) {
                results.push({
                    name: doc.name,
                    category: 'Não identificado',
                    confidence: 'baixa',
                    reason: 'Sem conteúdo para análise',
                });
                continue;
            }

            const content = (doc.text || doc.conteudo || '').slice(0, 4000); // Limita a 4KB para economizar tokens

            try {
                const message = await client.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 200,
                    messages: [
                        {
                            role: 'user',
                            content: `Analise este documento fiscal/comercial e identifique sua categoria.

Texto do documento:
${content}

Categorias possíveis: ${CATEGORIES.join(', ')}

Responda APENAS com um JSON (sem markdown):
{
  "category": "CATEGORIA_IDENTIFICADA",
  "confidence": "alta|média|baixa",
  "reason": "breve explicação"
}`,
                        },
                    ],
                });

                let classification = { category: 'Não identificado', confidence: 'baixa', reason: 'Claude não conseguiu classificar' };

                try {
                    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
                    // Tenta extrair JSON da resposta
                    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        classification = JSON.parse(jsonMatch[0]);
                    }
                } catch (e) {
                    console.error(`[classify] erro ao parsear resposta para ${doc.name}:`, e.message);
                }

                // Valida categoria
                if (!CATEGORIES.includes(classification.category)) {
                    classification.category = 'Não identificado';
                    classification.confidence = 'baixa';
                }

                results.push({
                    name: doc.name,
                    category: classification.category,
                    confidence: classification.confidence,
                    reason: classification.reason,
                });
            } catch (e) {
                console.error(`[classify] erro ao processar ${doc.name}:`, e.message);
                results.push({
                    name: doc.name,
                    category: 'Não identificado',
                    confidence: 'baixa',
                    reason: `Erro ao processar: ${e.message}`,
                });
            }
        }

        return res.json({
            success: true,
            processed: documents.length,
            results: results,
        });
    } catch (e) {
        console.error('[classify-unidentified] erro:', e.message);
        return res.status(500).json({ success: false, message: 'Erro no servidor.' });
    }
};
