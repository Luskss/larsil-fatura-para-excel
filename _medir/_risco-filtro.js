/**
 * _medir/_risco-filtro.js — filtrar por "NNN.DOC" no collectPdfs descartaria
 * alguma NOTA de verdade?
 *
 * A amostra de `_quanto-e-doc.js` mostrou nomes como
 * "1322,24 - 2025.12.21. SASCAR. NFS 750492. DEB AUTOMATICO.pdf" — sem o prefixo
 * NNN.DOC, mas com cara de nota fiscal. O comparador já os ignora hoje; a questão
 * aqui é se o EXTRATOR também deveria, ou se filtrar perderia documento fiscal.
 *
 * Mede: dos não-DOC, quantos o classificador reconhece como documento fiscal
 * (NF/NFS/CTE) — esses seriam a perda real de um filtro por nome.
 *
 * Uso: node _medir/_risco-filtro.js [quantosLer]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify } = require('../routes/_nf-parsers');

const RAIZ = path.join(__dirname, '..');
for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const RE_DOC = /^\s*\d+\s*\.\s*DOC\b/i;
const ehDoc = n => RE_DOC.test(String(n || ''));
const ehCpv = n => /^\s*\d+\s*\.\s*CPV\b/i.test(String(n || ''));
const ehExtratoDia = n => /^0+\s*\./.test(String(n || ''));

function varrer(dir, saida, prof = 0) {
    if (prof > 8) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push({ p, nome: e.name });
    }
}

// embaralha para a amostra não ser só de janeiro
function embaralhar(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

(async () => {
    const quantos = Number(process.argv[2] || 150);
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    const todos = [];
    varrer(raiz, todos);

    // os 3 grupos que um filtro trataria de forma diferente
    const cpv    = embaralhar(todos.filter(t => ehCpv(t.nome)));
    const extr   = embaralhar(todos.filter(t => ehExtratoDia(t.nome)));
    const outros = embaralhar(todos.filter(t => !ehDoc(t.nome) && !ehCpv(t.nome) && !ehExtratoDia(t.nome)));

    const grupos = [
        ['CPV (NNN.CPV)', cpv, Math.min(quantos, cpv.length)],
        ['extrato do dia (000.*)', extr, Math.min(40, extr.length)],
        ['outros sem NNN.DOC', outros, Math.min(60, outros.length)],
    ];

    for (const [rot, lista, n] of grupos) {
        const cont = new Map();
        const fiscaisExemplo = [];
        for (let i = 0; i < n; i++) {
            let text = '';
            try { text = (await new PDFParse({ data: fs.readFileSync(lista[i].p) }).getText()).text || ''; }
            catch (_) { continue; }
            const t = classify(text, lista[i].nome).tipo;
            cont.set(t, (cont.get(t) || 0) + 1);
            if ((t === 'NF' || t === 'NFS' || t === 'CTE') && fiscaisExemplo.length < 6)
                fiscaisExemplo.push(`${lista[i].nome.slice(0, 66)}  → ${t}`);
        }
        const fiscais = (cont.get('NF') || 0) + (cont.get('NFS') || 0) + (cont.get('CTE') || 0);
        console.log(`\n══ ${rot} — ${lista.length} no acervo, ${n} lidos ══`);
        for (const [t, c] of [...cont.entries()].sort((a, b) => b[1] - a[1]))
            console.log(`   ${String(c).padStart(4)}  ${t}`);
        console.log(`   → fiscais (NF/NFS/CTE): ${fiscais}/${n}  ${(100 * fiscais / n).toFixed(1)}%`);
        if (fiscaisExemplo.length) {
            console.log('   exemplos de fiscais neste grupo:');
            for (const e of fiscaisExemplo) console.log(`     ${e}`);
        }
    }
})();
