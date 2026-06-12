/**
 * routes/monitor-config.js
 * GET: retorna o caminho monitorado atual
 * POST: atualiza o caminho monitorado (salva no .env)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { setFullSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

const ENV_FILE = path.join(__dirname, '..', '.env');

module.exports = async function monitorConfigRoute(req, res) {
  setFullSecurityHeaders(res);

  if (!requireAuth(req, res)) return;

  const method = req.method;

  try {
    /* ── GET: retorna caminho monitorado ──────────────────────────────── */
    if (method === 'GET') {
      const monitorPath = process.env.MONITOR_PATH || '';
      return res.json({ success: true, monitorPath });
    }

    const body = req.body || {};

    /* ── POST: atualiza caminho monitorado ──────────────────────────────── */
    if (method === 'POST') {
      const newPath = trimStr(body.monitorPath);

      if (!newPath) {
        return res.status(400).json({ success: false, message: 'Caminho não pode estar vazio.' });
      }

      // Verifica se o caminho é válido (tenta acessar)
      try {
        fs.accessSync(newPath);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `Caminho inacessível: ${e.message}`,
        });
      }

      // Lê o .env atual
      let envContent = '';
      try {
        envContent = fs.readFileSync(ENV_FILE, 'utf8');
      } catch (e) {
        // Se não existe, cria vazio
        envContent = '';
      }

      // Substitui ou adiciona MONITOR_PATH
      const lines = envContent.split('\n');
      let found = false;
      const newLines = lines.map(line => {
        if (line.trim().startsWith('MONITOR_PATH=')) {
          found = true;
          return `MONITOR_PATH=${newPath}`;
        }
        return line;
      });

      if (!found) {
        newLines.push(`MONITOR_PATH=${newPath}`);
      }

      const newContent = newLines.join('\n').trim() + '\n';

      // Escreve de volta
      fs.writeFileSync(ENV_FILE, newContent, 'utf8');

      // Atualiza a variável de ambiente
      process.env.MONITOR_PATH = newPath;

      // Recarrega o scheduler com o novo caminho
      const { reloadSchedules } = require('../scheduler');
      await reloadSchedules();

      return res.json({
        success: true,
        message: `Caminho de monitoramento atualizado para: ${newPath}`,
        monitorPath: newPath,
      });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  } catch (e) {
    console.error('[monitor-config] erro:', e.message);
    return res.status(500).json({ success: false, message: 'Erro no servidor.' });
  }
};
