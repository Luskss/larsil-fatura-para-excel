'use strict';

const fs   = require('fs');
const path = require('path');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'settings.json');

function readConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch { return {}; }
}

function writeConfig(data) {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = async function configRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET') {
        return res.json({ success: true, config: readConfig() });
    }

    if (req.method === 'POST') {
        const { caminhoRelatorio } = req.body || {};

        if (caminhoRelatorio !== undefined) {
            const p = String(caminhoRelatorio).trim();

            // Valida: deve ser caminho absoluto (Windows ou Unix)
            if (p && !path.isAbsolute(p)) {
                return res.status(400).json({ success: false, message: 'Use um caminho absoluto (ex: C:\\Relatorios ou /home/user/relatorios).' });
            }

            if (p) {
                try {
                    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
                    // Testa permissão de escrita
                    const probe = path.join(p, '.write-test');
                    fs.writeFileSync(probe, '');
                    fs.unlinkSync(probe);
                } catch (e) {
                    return res.status(400).json({ success: false, message: `Caminho inacessível: ${e.message}` });
                }
            }
        }

        const updated = { ...readConfig(), ...(caminhoRelatorio !== undefined ? { caminhoRelatorio: String(caminhoRelatorio).trim() } : {}) };
        writeConfig(updated);
        return res.json({ success: true, config: updated, message: 'Configuração salva.' });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
};
