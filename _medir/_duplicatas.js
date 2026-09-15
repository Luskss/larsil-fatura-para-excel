/**
 * _medir/_duplicatas.js — quantas linhas do banco são o MESMO boleto repetido.
 *
 * O bug (corrigido em 09/09/2026): o upsert é por `arquivo|pasta`, e a parcela leva
 * sufixo #pN. Quando uma releitura detectava menos parcelas que a anterior, as
 * sobras da rodada antiga ficavam para sempre. Resultado visto na NF 218459 da
 * MAQNELSON: 6 boletos distintos ocupando 38 linhas, com "#p1 1/3" e "#p1 1/6"
 * convivendo.
 *
 * Aqui a duplicação é medida DENTRO de cada relatório (mesmo TIPO+PERIODO), que é
 * o escopo em que ela é erro. A mesma parcela em relatórios de meses diferentes é
 * legítima: cada uma é arquivada no mês do seu próprio vencimento.
 *
 * Uso: node _medir/_duplicatas.js
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
        "SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA");

    let linhas = 0, redundantes = 0, relatoriosAfetados = 0;
    const piores = [];

    for (const rec of res.recordset) {
        const rows = csvToRows(rec.CONTEUDO);
        linhas += rows.length;

        // identidade do BOLETO dentro deste relatório: o nosso número identifica
        // sem ambiguidade; sem ele, (arquivo-base + vencimento + valor).
        const vistos = new Map();
        let dup = 0;
        for (const r of rows) {
            let d = {};
            try { d = JSON.parse(r.dados_parser) || {}; } catch (_) {}
            const base = String(r.arquivo).replace(/#p\d+$/i, '');
            const nn = d['Nosso Número'] || '';
            const venc = d['Data de vencimento'] || '';
            const val = d['Valor total'] || d['Valor do boleto'] || '';
            // só faz sentido para linhas de parcela; documento normal é 1 por arquivo
            if (!/#p\d+$/i.test(r.arquivo)) continue;
            const k = nn ? `${base}|${r.pasta}|nn:${nn}` : `${base}|${r.pasta}|${venc}|${val}`;
            const n = (vistos.get(k) || 0) + 1;
            vistos.set(k, n);
            if (n > 1) dup++;
        }
        if (dup) {
            redundantes += dup;
            relatoriosAfetados++;
            piores.push({ rel: `${rec.TIPO} ${rec.PERIODO}`, linhas: rows.length, dup });
        }
    }

    console.log(`${linhas} linhas em ${res.recordset.length} relatórios (M + D + C).\n`);
    console.log(`linhas que repetem um boleto já presente no MESMO relatório: ${redundantes}`);
    console.log(`relatórios afetados: ${relatoriosAfetados}`);
    console.log(`→ ${(100 * redundantes / linhas).toFixed(1)}% do banco é duplicata do bug do #pN\n`);

    piores.sort((a, b) => b.dup - a.dup);
    console.log('── relatórios com mais duplicatas ──');
    for (const p of piores.slice(0, 12))
        console.log(`  ${p.rel.padEnd(14)} ${String(p.dup).padStart(5)} duplicatas de ${p.linhas} linhas`);
    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
