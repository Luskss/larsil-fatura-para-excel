/**
 * routes/pdf-viewer.js
 * GET: retorna um PDF para visualizar
 * Tenta cache primeiro, depois arquivo na pasta monitorada
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { requireAuth } = require('./_helpers');
const pdfCache = require('../pdf-cache');

module.exports = async function pdfViewerRoute(req, res) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');

    if (!requireAuth(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const { arquivo, pasta } = req.query;

        if (!arquivo) {
            return res.status(400).json({ success: false, message: 'Nome do arquivo não fornecido.' });
        }

        // 1) Tenta cache primeiro (instantâneo)
        let pdfBuffer = pdfCache.get(arquivo, pasta);
        if (pdfBuffer) {
            console.log(`[pdf-viewer] PDF encontrado em cache: ${arquivo}`);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('X-Cache', 'HIT');
            return res.send(pdfBuffer);
        }

        // 2) Se não estiver em cache, busca do arquivo na pasta monitorada
        const monitorPath = process.env.MONITOR_PATH;
        if (!monitorPath) {
            return res.status(503).json({ success: false, message: 'Serviço indisponível.' });
        }

        let filePath;
        if (pasta) {
            filePath = path.join(monitorPath, pasta, arquivo);
        } else {
            filePath = path.join(monitorPath, arquivo);
        }

        // Valida que o caminho está dentro de monitorPath (previne directory traversal)
        const realPath = path.resolve(filePath);
        const realMonitor = path.resolve(monitorPath);
        if (!realPath.startsWith(realMonitor)) {
            return res.status(403).json({ success: false, message: 'Acesso negado.' });
        }

        // Verifica se o arquivo existe
        if (!fs.existsSync(realPath)) {
            return res.status(404).json({ success: false, message: 'Arquivo não encontrado.' });
        }

        // Lê o arquivo
        pdfBuffer = fs.readFileSync(realPath);

        // Armazena em cache para próximas requisições
        pdfCache.put(arquivo, pasta, pdfBuffer);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('X-Cache', 'MISS');
        res.send(pdfBuffer);

    } catch (e) {
        console.error('[pdf-viewer] erro:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao recuperar arquivo.' });
    }
};
