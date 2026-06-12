/**
 * routes/force-scan-ai.js
 * POST /api/force-scan-ai
 * Igual ao force-scan, mas relê TODOS os PDFs pela IA (tipo, emitente, CNPJ, data,
 * número, valor e parcelas), substituindo o que os parsers locais de regex tinham
 * extraído. Arquivos já lidos por IA são reaproveitados do cache (não re-chamam a IA).
 */
'use strict';

const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { runScan, getScanProgress } = require('../scheduler');

module.exports = async function forceScanAiRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    const monitorPath = process.env.MONITOR_PATH;
    if (!monitorPath) {
        return res.status(400).json({ success: false, message: 'MONITOR_PATH não configurado.' });
    }

    // Evita duas varreduras simultâneas (a IA é cara e o progresso é global).
    const prog = getScanProgress();
    if (prog && prog.running) {
        return res.status(409).json({ success: false, message: 'Já existe uma leitura em andamento.' });
    }

    // Dispara em background — responde imediatamente para não bloquear o front.
    res.json({ success: true, message: 'Leitura via IA iniciada. Acompanhe o status em /api/scan-status.' });

    try {
        await runScan(monitorPath, { forceAI: true });
    } catch (e) {
        console.error('[force-scan-ai] erro:', e.message);
    }
};