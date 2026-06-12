/**
 * routes/force-scan.js
 * POST /api/force-scan
 * Dispara imediatamente a varredura do MONITOR_PATH sem esperar o agendamento.
 */
'use strict';

const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { runScan } = require('../scheduler');

module.exports = async function forceScanRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    const monitorPath = process.env.MONITOR_PATH;
    if (!monitorPath) {
        return res.status(400).json({ success: false, message: 'MONITOR_PATH não configurado.' });
    }

    // Dispara em background — responde imediatamente para não bloquear o front
    res.json({ success: true, message: 'Leitura iniciada. Acompanhe o status em /api/scan-status.' });

    try {
        await runScan(monitorPath);
    } catch (e) {
        console.error('[force-scan] erro:', e.message);
    }
};
