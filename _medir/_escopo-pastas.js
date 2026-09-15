/**
 * _medir/_escopo-pastas.js — quanto do acervo está FORA do MONITOR_PATH.
 *
 * O reprocessamento roda sobre MONITOR_PATH, que hoje aponta só para SANTANDER.
 * O banco, porém, tem 7.160 linhas vindas de vários lugares. Este script mede o
 * que ficaria de fora e o que custaria incluir, para a decisão de escopo ser
 * tomada com número.
 *
 * Uso: node _medir/_escopo-pastas.js
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

const COLS = ['arquivo', 'pasta', 'paginas', 'conteudo', 'tipo', 'evidencia', 'origem', 'ocr_usado', 'dados_parser', 'cnpj'];
function parseCsvLine(line) {
    const f = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
        else { if (ch === '"') inQ = true; else if (ch === ';') { f.push(cur); cur = ''; } else cur += ch; }
    }
    f.push(cur); return f;
}
function csvToRows(csv) {
    const lines = String(csv || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
        const f = parseCsvLine(line); const r = {};
        COLS.forEach((c, i) => { r[c] = f[i] ?? ''; });
        return r;
    });
}

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const res = await pool.request().query(
        "SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    // Uma linha por documento (arquivo|pasta), para não contar o mesmo PDF em
    // vários relatórios mensais.
    const docs = new Map();
    for (const rec of res.recordset) {
        for (const row of csvToRows(rec.CONTEUDO)) {
            docs.set(`${row.arquivo}|${row.pasta}`, row);
        }
    }

    // A raiz do documento é o 1º segmento da coluna `pasta`; vazio = raiz do
    // MONITOR_PATH (os PDFs soltos em SANTANDER).
    const porRaiz = new Map();
    for (const row of docs.values()) {
        const raiz = String(row.pasta || '').split('/')[0] || '(raiz do MONITOR_PATH)';
        if (!porRaiz.has(raiz)) porRaiz.set(raiz, { n: 0, ia: 0, comItens: 0, comCfop: 0, comChave: 0, nf: 0 });
        const g = porRaiz.get(raiz);
        g.n++;
        if (/\bIA\b/i.test(row.origem || '')) g.ia++;
        if (row.tipo === 'NF' || row.tipo === 'NFS' || row.tipo === 'CTE') g.nf++;
        let d = null;
        try { d = JSON.parse(row.dados_parser); } catch (_) {}
        if (d && typeof d === 'object') {
            if (d['Itens']) g.comItens++;
            if (d['CFOP']) g.comCfop++;
            if (d['Chave de acesso'] && d['Chave de acesso'] !== '—') g.comChave++;
        }
    }

    const monitor = process.env.MONITOR_PATH || '';
    console.log(`MONITOR_PATH = ${monitor}\n`);
    console.log(`${docs.size} documentos distintos nos relatórios mensais.\n`);
    console.log('raiz da coluna `pasta`                          docs    já IA   c/itens  c/CFOP  c/chave   fiscais');
    const ord = [...porRaiz.entries()].sort((a, b) => b[1].n - a[1].n);
    let total = 0, totIa = 0, totFiscais = 0;
    for (const [raiz, g] of ord) {
        total += g.n; totIa += g.ia; totFiscais += g.nf;
        console.log(`  ${raiz.slice(0, 42).padEnd(44)} ${String(g.n).padStart(5)}  ${String(g.ia).padStart(6)}  ${String(g.comItens).padStart(7)}  ${String(g.comCfop).padStart(6)}  ${String(g.comChave).padStart(7)}  ${String(g.nf).padStart(7)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(44)} ${String(total).padStart(5)}  ${String(totIa).padStart(6)}                            ${String(totFiscais).padStart(7)}`);

    // Quantos PDFs existem hoje sob o MONITOR_PATH (o alcance real do scan)
    let noDisco = 0;
    (function varrer(dir, prof = 0) {
        if (prof > 6) return;
        let ent; try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ent) {
            if (e.isDirectory()) varrer(path.join(dir, e.name), prof + 1);
            else if (/\.pdf$/i.test(e.name)) noDisco++;
        }
    })(monitor);

    console.log(`\nPDFs sob o MONITOR_PATH agora: ${noDisco}`);
    console.log(`Documentos no banco: ${docs.size}`);
    console.log(`→ fora do alcance do scan: ${Math.max(0, docs.size - noDisco)} documento(s)`);
    console.log(`→ falta passar pela IA: ${total - totIa} documento(s)`);
    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
