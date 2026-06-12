/**
 * routes/scan-status.js
 * GET: retorna o resultado da última varredura automática
 * DELETE: limpa o resultado (marca como lido)
 */
'use strict';

const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { getLastScanResult, clearLastScanResult, getScanProgress, pauseScan, resumeScan, stopScan } = require('../scheduler');

module.exports = async function scanStatusRoute(req, res) {
  setFullSecurityHeaders(res);

  if (!requireAuth(req, res)) return;

  try {
    const method = req.method;

    /* ── GET: retorna resultado da última varredura ──────────────────── */
    if (method === 'GET') {
      const progress = getScanProgress();
      const result = getLastScanResult();
      return res.json({ success: true, progress: progress || null, result: result || null });
    }

    /* ── POST: controle (pause / resume / stop) ──────────────────────── */
    if (method === 'POST') {
      const action = (req.body || {}).action;
      if (action === 'pause')  { pauseScan();  return res.json({ success: true, action: 'pause' }); }
      if (action === 'resume') { resumeScan(); return res.json({ success: true, action: 'resume' }); }
      if (action === 'stop')   { stopScan();   return res.json({ success: true, action: 'stop' }); }
      return res.status(400).json({ success: false, message: 'action deve ser pause, resume ou stop.' });
    }

    /* ── DELETE: limpa o resultado ────────────────────────────────────── */
    if (method === 'DELETE') {
      clearLastScanResult();
      return res.json({ success: true, message: 'Resultado limpo.' });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  } catch (e) {
    console.error('[scan-status] erro:', e.message);
    return res.status(500).json({ success: false, message: 'Erro no servidor.' });
  }
};
