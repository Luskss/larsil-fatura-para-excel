/**
 * _medir/_reler-mes.js — dispara a releitura de UM mês com `forceAITudo`.
 *
 * GRAVA NO BANCO. É o único script de `_medir/` que não é somente-leitura, e por isso
 * exige o caminho da pasta explicitamente em vez de adivinhar por MONITOR_PATH: apontar
 * para a raiz erraria o escopo e releria 16.110 PDFs.
 *
 * Por que `forceAITudo` e não `forceAI` (medido em 14/09/2026):
 *   - o `forceAI` reaproveita do cache toda row que já tem origem "IA"
 *   - em 03.2026 são 374 rows assim, gravadas pelo `parseNfse` com o bug de §15.16
 *   - ou seja: o cache protegia justamente as linhas que a releitura existe para trocar
 *
 * Seguro quanto a duplicatas — conferido antes de rodar, chave a chave:
 *   SUBSTITUI 834 · RECONCILIA 202 · AMBÍGUO 0 · ÓRFÃ 206 (de outros meses)
 *
 * Uso: node _medir/_reler-mes.js "<caminho da pasta do mês>"
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { runScan, getScanProgress } = require('../scheduler');

const PASTA = process.argv[2];
if (!PASTA) {
    console.error('uso: node _medir/_reler-mes.js "<caminho da pasta do mês>"');
    process.exit(1);
}

(async () => {
    const prog = getScanProgress();
    if (prog && prog.running) {
        console.error('JÁ EXISTE uma varredura em andamento — abortando.');
        console.error('Duas rodadas simultâneas derrubam o OCR, e falha de OCR grava');
        console.error('vazio por cima de dado bom (ocr-cai-com-medicoes-em-paralelo).');
        process.exit(1);
    }

    console.log(`[reler-mes] início ${new Date().toLocaleString('pt-BR')}`);
    console.log(`[reler-mes] pasta: ${PASTA}`);
    console.log('[reler-mes] modo: forceAITudo (relê inclusive o que já é origem IA)\n');

    const t0 = Date.now();
    await runScan(PASTA, { forceAITudo: true });
    const min = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`\n[reler-mes] fim — ${min} min`);
    process.exit(0);
})();
