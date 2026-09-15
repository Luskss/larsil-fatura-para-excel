/**
 * _medir/_ver-savana.js — texto cru em volta das duas falhas que a conferência
 * do banco achou: "Razão social = LEGIVEL" e itens sem quantidade/unitário.
 *
 * Uso: node _medir/_ver-savana.js <trecho-do-nome>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { extrairNotaFiscal } = require('../routes/_nf-itens');

const env = {};
for (const linha of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
}
const RAIZ = env.MONITOR_PATH || env.ARQUIVO_PATH;

function varrer(dir, saida, prof = 0) {
    if (prof > 6) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

(async () => {
    const alvo = (process.argv[2] || 'SAVANA').toUpperCase();
    const todos = [];
    varrer(RAIZ, todos);
    const achado = todos.find(p => path.basename(p).toUpperCase().includes(alvo));
    if (!achado) { console.log(`nenhum PDF com "${alvo}"`); process.exit(0); }

    console.log(`arquivo: ${path.basename(achado)}\n`);
    const text = (await new PDFParse({ data: fs.readFileSync(achado) }).getText()).text || '';

    console.log('── linhas com "LEGIVEL" / "RECEBEMOS" ──');
    text.split('\n').forEach((l, i) => {
        if (/LEG[IÍ]VEL|RECEBEMOS/i.test(l))
            console.log(`  [${i}] ${l.replace(/\s+/g, ' ').trim().slice(0, 150)}`);
    });

    console.log('\n── linhas de item (com NCM de 8 dígitos e valor) ──');
    let mostrados = 0;
    text.split('\n').forEach((l, i) => {
        if (mostrados >= 6) return;
        if (/(?<![\d.,])\d{8}(?![\d.,])/.test(l) && /\d,\d{2}/.test(l)) {
            mostrados++;
            console.log(`  [${i}] ${l.replace(/\t/g, ' <TAB> ').slice(0, 190)}`);
        }
    });

    const nf = extrairNotaFiscal(text);
    console.log(`\n→ extraído: nome=${nf.nome || '∅'} | total=${nf.valorTotal ?? '∅'} (${nf.origemTotal || '—'})`);
    for (const it of nf.itens.slice(0, 4))
        console.log(`   · ${(it.descricao || '∅').slice(0, 34).padEnd(34)} ${(it.unidade || '—').padEnd(4)} q=${it.quantidade ?? '?'} u=${it.valorUnitario ?? '?'} t=${it.valorTotal} [${it.confianca}]`);
})();
