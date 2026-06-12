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

    if (req.method === 'GET') {
        // Leitura de config é pública (sem dados sensíveis)
        return res.json({ success: true, config: readConfig() });
    }

    if (req.method === 'POST') {
        const { caminhoRelatorio, aiProvider } = req.body || {};
        const current = readConfig();

        // aiProvider não requer auth — é preferência de sistema sem dado sensível
        if (aiProvider !== undefined) {
            const p = String(aiProvider).trim().toLowerCase();
            if (p !== 'openai' && p !== 'anthropic') {
                return res.status(400).json({ success: false, message: 'aiProvider deve ser "openai" ou "anthropic".' });
            }
            current.aiProvider = p;
            // Se só veio aiProvider, salva e retorna sem exigir auth
            if (caminhoRelatorio === undefined) {
                writeConfig(current);
                return res.json({ success: true, config: current, message: 'Provedor de IA salvo.' });
            }
        }

        // caminhoRelatorio e demais campos sensíveis exigem auth
        if (!requireAuth(req, res)) return;

        if (caminhoRelatorio !== undefined) {
            const p = String(caminhoRelatorio).trim();

            if (p && !path.isAbsolute(p)) {
                return res.status(400).json({ success: false, message: 'Use um caminho absoluto (ex: C:\\Relatorios ou /home/user/relatorios).' });
            }

            if (p) {
                try {
                    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
                    const probe = path.join(p, '.write-test');
                    fs.writeFileSync(probe, '');
                    fs.unlinkSync(probe);
                } catch (e) {
                    return res.status(400).json({ success: false, message: `Caminho inacessível: ${e.message}` });
                }
            }

            current.caminhoRelatorio = p;
        }

        writeConfig(current);
        return res.json({ success: true, config: current, message: 'Configuração salva.' });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
};
