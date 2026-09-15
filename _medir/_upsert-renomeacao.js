/**
 * _medir/_upsert-renomeacao.js — prova a correção do upsert contra a renomeação de
 * pasta, sem tocar no banco: monta mapas de linhas em memória e roda a MESMA lógica
 * de `upsertRelatorio`, fatiada do fonte.
 *
 * Cenários:
 *   1. pasta renomeada        → a linha velha some, sobra só a nova (o bug corrigido);
 *   2. mesma pasta            → atualiza no lugar, como sempre fez;
 *   3. nome ambíguo (2 linhas antigas com o mesmo nome em pastas diferentes)
 *                             → NÃO apaga nada: a remoção exige unicidade;
 *   4. arquivo novo           → só insere, não mexe em vizinho;
 *   5. parcelas #pN           → o bloco do PDF é reescrito (regressão do fix anterior).
 *
 * Uso: node _medir/_upsert-renomeacao.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

// Reproduz o trecho de mesclagem de upsertRelatorio operando sobre um Map já montado.
// Fatiar o fonte garante que o teste não diverge silenciosamente da implementação.
function mesclarReal() {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('        // ── Parcelas: o PDF inteiro é reescrito');
    const fim = src.indexOf('        for (const row of novasRows) map.set(');
    if (ini < 0 || fim < 0) throw new Error('não achei o trecho de mesclagem em process-folder.js');
    const corpo = src.slice(ini, fim);
    return new Function('map', 'novasRows', `${corpo}\n        for (const row of novasRows) map.set(\`\${row.arquivo}|\${row.pasta}\`, row);\n        return map;`);
}

const mesclar = mesclarReal();
const chaves = m => [...m.keys()].sort();
let falhas = 0;
function teste(nome, antigas, novas, esperado) {
    const map = new Map(antigas.map(([a, p]) => [`${a}|${p}`, { arquivo: a, pasta: p }]));
    const novasRows = novas.map(([a, p]) => ({ arquivo: a, pasta: p }));
    const r = mesclar(map, novasRows);
    const obtido = chaves(r);
    const ok = JSON.stringify(obtido) === JSON.stringify([...esperado].sort());
    if (!ok) falhas++;
    console.log(`${ok ? '  ok  ' : ' FALHA'} ${nome}`);
    if (!ok) {
        console.log(`         esperado: ${JSON.stringify([...esperado].sort())}`);
        console.log(`         obtido  : ${JSON.stringify(obtido)}`);
    }
}

const NOVA = '2026.03.EXTRATOS CONTABILIDADE/SANTANDER/2026.03.30';
const VELHA = 'SANTANDER/2026.03.30';
const A = '070.DOC- 72,57 - 2026.03.10. DALIANI CRISTINI. NFS 886 + AUT.pdf';
const B = '071.DOC- 10,00 - 2026.03.11. OUTRO. NF 1 + BOL.pdf';

teste('1. pasta renomeada: a velha some',
    [[A, VELHA]], [[A, NOVA]], [`${A}|${NOVA}`]);

teste('2. mesma pasta: atualiza no lugar',
    [[A, NOVA]], [[A, NOVA]], [`${A}|${NOVA}`]);

teste('3. nome ambíguo em 2 pastas: não apaga nada',
    [[A, VELHA], [A, 'OUTRA/PASTA']], [[A, NOVA]],
    [`${A}|${VELHA}`, `${A}|OUTRA/PASTA`, `${A}|${NOVA}`]);

teste('4. arquivo novo: não mexe no vizinho',
    [[A, VELHA]], [[B, NOVA]], [`${A}|${VELHA}`, `${B}|${NOVA}`]);

teste('5. parcelas: bloco do PDF reescrito (6 antigas → 3 novas)',
    [[`${A}#p1`, NOVA], [`${A}#p2`, NOVA], [`${A}#p3`, NOVA],
     [`${A}#p4`, NOVA], [`${A}#p5`, NOVA], [`${A}#p6`, NOVA]],
    [[`${A}#p1`, NOVA], [`${A}#p2`, NOVA], [`${A}#p3`, NOVA]],
    [`${A}#p1|${NOVA}`, `${A}#p2|${NOVA}`, `${A}#p3|${NOVA}`]);

teste('6. parcelas + renomeação: velhas #pN somem',
    [[`${A}#p1`, VELHA], [`${A}#p2`, VELHA]],
    [[`${A}#p1`, NOVA], [`${A}#p2`, NOVA]],
    [`${A}#p1|${NOVA}`, `${A}#p2|${NOVA}`]);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodos os cenários passaram');
process.exit(falhas ? 1 : 0);
