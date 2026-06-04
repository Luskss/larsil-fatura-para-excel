'use strict';

const OCR_URL = 'http://127.0.0.1:5001/ocr';

/**
 * POST /api/ocr
 * Body JSON: { pdf: "<base64 do arquivo PDF>" }
 * Retorna:   { text: "<texto extraído>" }  ou  { error: "<mensagem>" }
 *
 * Encaminha o PDF para o servidor Python (ocr_server.py) que usa PaddleOCR.
 * O servidor Python deve estar rodando (iniciado automaticamente pelo server.js).
 */
module.exports = async function ocrRoute(req, res) {
    const { pdf } = req.body || {};
    if (!pdf) return res.status(400).json({ error: 'campo pdf obrigatório' });

    let pyRes;
    try {
        const buf = Buffer.from(pdf, 'base64');

        // Node.js 18+ tem FormData e Blob globais — sem dependências extras
        const formData = new FormData();
        formData.append('file', new Blob([buf], { type: 'application/pdf' }), 'upload.pdf');

        pyRes = await fetch(OCR_URL, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000), // 2 min máximo por documento
        });
    } catch (err) {
        // Python não está rodando ou ainda está carregando o modelo
        return res.status(503).json({
            error: 'Servidor OCR indisponível. Verifique se o Python e as dependências estão instalados.',
        });
    }

    const data = await pyRes.json();
    if (!pyRes.ok) console.error('[ocr] Python retornou erro:', data.error || data);
    res.status(pyRes.ok ? 200 : 500).json(data);
};
