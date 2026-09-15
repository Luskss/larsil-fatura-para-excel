/**
 * _medir/_achar-extratos.js — onde ficam, no disco, as pastas
 * "AAAA.MM.EXTRATOS CONTABILIDADE" que respondem por 5.226 documentos do banco.
 *
 * O MONITOR_PATH aponta para ".../2º Etapa/SANTANDER" (563 PDFs). Os documentos
 * que faltam foram gravados com pasta "2026.03.EXTRATOS CONTABILIDADE/SANTANDER/..."
 * — outra árvore, com um SANTANDER próprio lá dentro. Este script procura essa
 * árvore a partir das raízes conhecidas do .env.
 *
 * Uso: node _medir/_achar-extratos.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const MONITOR = process.env.MONITOR_PATH || '';
const ARQUIVO = process.env.ARQUIVO_PATH || '';

function listar(dir, rot) {
    console.log(`\n── ${rot} ──\n${dir}`);
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { console.log(`   (não acessível: ${e.code})`); return []; }
    const dirs = [];
    for (const e of ent.slice(0, 30)) {
        console.log(`   ${e.isDirectory() ? '[dir]' : '     '} ${e.name}`);
        if (e.isDirectory()) dirs.push(path.join(dir, e.name));
    }
    if (ent.length > 30) console.log(`   … +${ent.length - 30} entradas`);
    return dirs;
}

// conta PDFs recursivamente, com teto para não varrer o servidor inteiro
function contarPdfs(dir, teto = 100000, prof = 0) {
    if (prof > 8) return 0;
    let n = 0, ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
    for (const e of ent) {
        if (n >= teto) break;
        if (e.isDirectory()) n += contarPdfs(path.join(dir, e.name), teto - n, prof + 1);
        else if (/\.pdf$/i.test(e.name)) n++;
    }
    return n;
}

// procura pastas cujo nome contenha "EXTRATOS CONTABILIDADE"
function procurar(dir, achados, prof = 0) {
    if (prof > 4 || achados.length >= 40) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (/EXTRATOS\s+CONTABILIDADE/i.test(e.name)) { achados.push(p); continue; }
        procurar(p, achados, prof + 1);
    }
}

console.log(`MONITOR_PATH = ${MONITOR}`);
console.log(`ARQUIVO_PATH = ${ARQUIVO}`);

listar(ARQUIVO, 'ARQUIVO_PATH (raiz do arquivo permanente)');

const achados = [];
for (const raiz of [ARQUIVO, path.dirname(path.dirname(MONITOR))]) {
    if (!raiz) continue;
    procurar(raiz, achados);
}

console.log(`\n\n══ pastas "EXTRATOS CONTABILIDADE" encontradas: ${achados.length} ══`);
let total = 0;
for (const p of achados.sort()) {
    const n = contarPdfs(p);
    total += n;
    console.log(`  ${String(n).padStart(5)} PDFs  ${p}`);
}
console.log(`  ${String(total).padStart(5)} PDFs  TOTAL`);
