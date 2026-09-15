/**
 * _medir/_salvar-fila-ocr.js — congela a fila da releitura para retomar depois.
 *
 * A releitura de 03.2026 processa 933 documentos em ordem. Se for interrompida (ou
 * se quisermos rodar outra coisa antes), esta lista diz o que JÁ passou e o que
 * FALTA, para não refazer o trabalho caro de OCR.
 *
 * Lê o progresso do LOG (que registra cada arquivo processado) e cruza com a
 * ordem real da pasta. Não toca no banco nem reabre PDF — é só bookkeeping, e por
 * isso pode rodar com a releitura em andamento.
 *
 * Uso: node _medir/_salvar-fila-ocr.js <caminho-do-log> [saida.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const LOG = process.argv[2];
const SAIDA = process.argv[3] || path.join(h.CACHE, 'fila-ocr-03.json');
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

// Mesmo filtro de `ehAnexoIgnoravel` em process-folder.js: CPV e extrato do dia
// não entram na fila, então não podem entrar na contagem.
const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXTRATO = /^0+\s*[.\-]/;
const ehAnexo = n => RE_CPV.test(n) || RE_EXTRATO.test(n);

function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}

if (!LOG || !fs.existsSync(LOG)) {
    console.error('uso: node _medir/_salvar-fila-ocr.js <log> [saida.json]');
    process.exit(1);
}

const txt = fs.readFileSync(LOG, 'utf8');

// O log imprime "  NN%  (atual/total)  nome-do-arquivo" a cada 5%, e uma linha por
// evento (carnê, OCR, data corrigida). O sinal confiável do AVANÇO é o contador.
const marcos = [...txt.matchAll(/(\d+)%\s+\((\d+)\/(\d+)\)\s+(.*)$/gm)]
    .map(m => ({ pct: +m[1], atual: +m[2], total: +m[3], arquivo: m[4].trim() }));
const ultimo = marcos[marcos.length - 1] || null;

// Arquivos citados no log por qualquer motivo — indício de já terem sido tocados.
const citados = new Set();
for (const m of txt.matchAll(/(?:carnê confirmado pela IA em|OCR falhou em|data corrigida pela subpasta:\s*")([^:"]+\.pdf)/gi))
    citados.add(m[1].trim());
for (const m of marcos) if (/\.pdf/i.test(m.arquivo)) citados.add(m.arquivo);

const todos = listarPdfs(path.join(RAIZ_ARQ, PASTA)).map(p => path.basename(p));
const fila = todos.filter(n => !ehAnexo(n));

const out = {
    gerado: new Date().toISOString(),
    pasta: PASTA,
    log: LOG,
    // O que o processo reportou por último. `atual` é a posição na fila DELE, que
    // segue a mesma ordem de `collectPdfs` — por isso serve para retomar.
    ultimoMarco: ultimo,
    totalPdfsNaPasta: todos.length,
    anexosIgnorados: todos.length - fila.length,
    totalNaFila: fila.length,
    processadosAteOMarco: ultimo ? ultimo.atual : 0,
    faltamAproximadamente: ultimo ? ultimo.total - ultimo.atual : fila.length,
    arquivosCitadosNoLog: [...citados],
    fila,
};

fs.writeFileSync(SAIDA, JSON.stringify(out, null, 1));

console.log(`fila salva em ${SAIDA}\n`);
console.log(`pasta:                 ${PASTA}`);
console.log(`PDFs na pasta:         ${out.totalPdfsNaPasta}`);
console.log(`  CPV/extrato:         ${out.anexosIgnorados}`);
console.log(`  na fila:             ${out.totalNaFila}`);
if (ultimo) {
    console.log(`\núltimo marco no log:   ${ultimo.pct}%  (${ultimo.atual}/${ultimo.total})`);
    console.log(`  último arquivo:      ${ultimo.arquivo.slice(0, 62)}`);
    console.log(`  faltam ~             ${out.faltamAproximadamente}`);
} else {
    console.log('\nnenhum marco de progresso no log ainda.');
}
console.log(`\narquivos citados no log: ${citados.size}`);
console.log('\nNOTA: `forceLocal` relê TUDO do disco e é idempotente — retomar é');
console.log('rodar o mesmo comando de novo. Esta lista serve para CONFERIR o que');
console.log('faltou, não para pular etapas.');
