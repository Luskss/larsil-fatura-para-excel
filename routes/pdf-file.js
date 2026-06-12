/**
 * routes/pdf-file.js
 * GET: retorna um PDF pelo nome e pasta
 * Busca na pasta monitorada (MONITOR_PATH)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { requireAuth } = require('./_helpers');

module.exports = async function pdfFileRoute(req, res) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');

    if (!requireAuth(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const { name, folder } = req.query;

        if (!name) {
            return res.status(400).json({ success: false, message: 'Nome do arquivo não fornecido.' });
        }

        const monitorPath = process.env.MONITOR_PATH;
        if (!monitorPath) {
            return res.status(400).json({ success: false, message: 'Caminho de monitoramento não configurado.' });
        }

        // Constrói o caminho do arquivo
        let filePath;
        if (folder) {
            filePath = path.join(monitorPath, folder, name);
        } else {
            filePath = path.join(monitorPath, name);
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

        // Retorna o arquivo
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${name}"`);
        const fileStream = fs.createReadStream(realPath);
        fileStream.pipe(res);
    } catch (e) {
        console.error('[pdf-file] erro:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao recuperar arquivo.' });
    }
};
