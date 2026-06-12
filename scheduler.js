/**
 * scheduler.js
 * Scheduler de monitoramento automático de pastas em horários específicos.
 * Carrega horários da tabela nfs.HORARIOS e executa varredura de PDFs.
 */
'use strict';

const path = require('path');
const fs = require('fs').promises;
const schedule = require('node-schedule');
const { getConnection } = require('./config');
const { processFolderAuto } = require('./routes/process-folder');

let _activeJobs = new Map(); // ID_HORARIO → Job
let _lastScanResult = null;   // Resultado da última varredura
let _scanProgress = null;     // { running, paused, current, total, percent, message } | null
let _scanPaused = false;
let _scanStopped = false;

/**
 * Carrega PDFs recursivamente de uma pasta
 */
async function collectPdfs(dirPath, files = []) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
                files.push(fullPath);
            } else if (entry.isDirectory()) {
                await collectPdfs(fullPath, files);
            }
        }
    } catch (e) {
        console.error(`[scheduler] erro ao ler pasta ${dirPath}:`, e.message);
    }
    return files;
}

/**
 * Inicia agendamentos baseado nos horários salvos no banco
 */
async function initScheduler() {
    try {
        const pool = await getConnection();
        const result = await pool
            .request()
            .query('SELECT ID_HORARIO, CONVERT(varchar(5), HORARIO, 108) AS HORARIO FROM nfs.HORARIOS ORDER BY HORARIO');

        const horarios = result.recordset || [];
        console.log(`[scheduler] carregado ${horarios.length} horário(s) de monitoramento`);

        const monitorPath = process.env.MONITOR_PATH;
        if (!monitorPath) {
            console.warn('[scheduler] MONITOR_PATH não configurado no .env — monitoramento desativado');
            return;
        }

        // Cancela jobs antigos
        _activeJobs.forEach(job => job.cancel());
        _activeJobs.clear();

        // Agenda novo horário para cada entrada
        for (const h of horarios) {
            const [hh, mm] = h.HORARIO.split(':');
            const cronExpr = `${mm} ${hh} * * *`; // cron: MM HH * * *

            const job = schedule.scheduleJob(h.ID_HORARIO.toString(), cronExpr, async () => {
                console.log(`[scheduler] executando varredura em ${h.HORARIO}…`);
                await runScan(monitorPath);
            });

            _activeJobs.set(h.ID_HORARIO, job);
            console.log(`[scheduler] agendado: ${h.HORARIO} (${cronExpr})`);
        }
    } catch (e) {
        console.error('[scheduler] erro ao inicializar:', e.message);
    }
}

/**
 * Executa uma varredura de PDFs na pasta monitorada.
 * @param {string} dirPath
 * @param {{ forceAI?: boolean }} [opts]  forceAI → relê tudo pela IA (botão "Forçar Leitura via IA")
 */
async function runScan(dirPath, opts = {}) {
    try {
        // Verifica se a pasta existe
        await fs.access(dirPath);
        console.log(`[scheduler] iniciando processamento de ${dirPath}…${opts.forceAI ? ' (via IA)' : ''}`);

        _scanPaused = false;
        _scanStopped = false;
        _scanProgress = { running: true, paused: false, current: 0, total: 0, percent: 0, message: 'Iniciando...' };

        const result = await processFolderAuto(dirPath, ({ current, total, percent, filename }) => {
            _scanProgress = { running: true, paused: _scanPaused, current, total, percent, message: filename };
        }, () => _scanPaused, () => _scanStopped, opts);

        _scanProgress = null;

        if (result.noChanges) {
            console.log(`[scheduler] ✓ ${result.message}`);
            _lastScanResult = {
                success: true,
                message: 'Nenhuma alteração nas notas!',
                timestamp: new Date().toLocaleString('pt-BR'),
            };
        } else if (result.success) {
            console.log(`[scheduler] ✓ ${result.message}`);
            _lastScanResult = {
                success: true,
                message: result.message,
                processed: result.processed,
                unchanged: result.unchanged,
                timestamp: new Date().toLocaleString('pt-BR'),
            };
        } else {
            console.error(`[scheduler] ✗ ${result.message}`);
            _lastScanResult = {
                success: false,
                message: `Erro: ${result.message}`,
                timestamp: new Date().toLocaleString('pt-BR'),
            };
        }

        _scanPaused = false;
        _scanStopped = false;
    } catch (e) {
        _scanProgress = null;
        _scanPaused = false;
        _scanStopped = false;
        if (e.code === 'ENOENT') {
            console.warn(`[scheduler] pasta não existe: ${dirPath}`);
        } else {
            console.error('[scheduler] erro ao executar varredura:', e.message);
        }
        _lastScanResult = {
            success: false,
            message: e.message,
            timestamp: new Date().toLocaleString('pt-BR'),
        };
    }
}

/**
 * Recarrega os horários (chamado após adicionar/remover um horário)
 */
async function reloadSchedules() {
    console.log('[scheduler] recarregando agendamentos…');
    await initScheduler();
}

/**
 * Retorna o resultado da última varredura
 */
function getLastScanResult() {
    return _lastScanResult;
}

/**
 * Limpa o resultado da última varredura
 */
function clearLastScanResult() {
    _lastScanResult = null;
}

function getScanProgress() { return _scanProgress; }
function setScanProgress(p) { _scanProgress = p; }
function pauseScan()  { if (_scanProgress?.running) { _scanPaused = true;  if (_scanProgress) _scanProgress.paused = true;  } }
function resumeScan() { if (_scanProgress?.running) { _scanPaused = false; if (_scanProgress) _scanProgress.paused = false; } }
function stopScan()   { _scanStopped = true; }

module.exports = { initScheduler, reloadSchedules, runScan, getLastScanResult, clearLastScanResult, getScanProgress, setScanProgress, pauseScan, resumeScan, stopScan };
