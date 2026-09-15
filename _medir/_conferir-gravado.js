/**
 * _medir/_conferir-gravado.js — o que foi REALMENTE gravado no banco está certo?
 *
 * Volume gravado não é qualidade. Este script olha o conteúdo das linhas novas:
 * se os itens somam o total da nota, se a unidade veio, e mostra exemplos para
 * conferência humana.
 *
 * Uso: node _medir/_conferir-gravado.js [quantosExemplos]
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
const num = s => { const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };

(async () => {
    const quantos = Number(process.argv[2] || 8);
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const res = await pool.request().query(
        "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    const docs = new Map();
    for (const rec of res.recordset)
        for (const row of csvToRows(rec.CONTEUDO)) docs.set(`${row.arquivo}|${row.pasta}`, row);

    let comItens = 0, itensTotal = 0, comUnidade = 0, comCfopItem = 0, alta = 0, baixa = 0;
    let fecha = 0, naoFecha = 0, semTotal = 0, viaIA = 0;
    const exemplos = [];
    const suspeitos = [];

    for (const row of docs.values()) {
        let d = null;
        try { d = JSON.parse(row.dados_parser); } catch (_) { continue; }
        if (!d || !Array.isArray(d['Itens']) || !d['Itens'].length) continue;
        comItens++;
        if (d['Origem dos itens'] === 'IA') viaIA++;

        let soma = 0;
        for (const it of d['Itens']) {
            itensTotal++;
            if (it['Unidade']) comUnidade++;
            if (it['CFOP']) comCfopItem++;
            if (it['Confiança'] === 'alta') alta++;
            if (it['Confiança'] === 'baixa') baixa++;
            soma += num(it['Valor total']) || 0;
        }
        const tot = num(d['Valor total da nota']);
        if (tot == null) semTotal++;
        else if (Math.abs(soma - tot) <= Math.max(0.05, tot * 0.05)) fecha++;
        else {
            naoFecha++;
            if (suspeitos.length < 6) suspeitos.push({ arq: row.arquivo, soma: soma.toFixed(2), tot, n: d['Itens'].length });
        }
        if (exemplos.length < quantos) exemplos.push({ arq: row.arquivo, d });
    }

    const pct = (n, dd) => (dd ? `${(100 * n / dd).toFixed(1)}%` : '—');
    console.log(`${docs.size} documentos no banco; ${comItens} com itens gravados (${viaIA} pela IA).\n`);
    console.log(`── ${itensTotal} itens gravados ──`);
    console.log(`  com unidade         ${String(comUnidade).padStart(5)}  ${pct(comUnidade, itensTotal)}`);
    console.log(`  com CFOP            ${String(comCfopItem).padStart(5)}  ${pct(comCfopItem, itensTotal)}`);
    console.log(`  confiança alta      ${String(alta).padStart(5)}  ${pct(alta, itensTotal)}`);
    console.log(`  confiança baixa     ${String(baixa).padStart(5)}  ${pct(baixa, itensTotal)}`);
    console.log(`\n── soma dos itens × total da nota (${comItens} notas) ──`);
    console.log(`  fecha               ${String(fecha).padStart(5)}  ${pct(fecha, comItens)}`);
    console.log(`  NÃO fecha           ${String(naoFecha).padStart(5)}  ${pct(naoFecha, comItens)}`);
    console.log(`  sem total p/ comparar ${String(semTotal).padStart(3)}  ${pct(semTotal, comItens)}`);

    if (suspeitos.length) {
        console.log('\n── notas em que a soma NÃO fecha (conferir) ──');
        for (const s of suspeitos) console.log(`  ${s.arq.slice(0, 56).padEnd(56)} ${s.n} itens, soma ${s.soma} vs total ${s.tot}`);
    }

    console.log('\n── exemplos gravados ──');
    for (const { arq, d } of exemplos) {
        console.log(`\n${arq.slice(0, 76)}`);
        console.log(`  Emitente=${d['Emitente'] || '∅'} | Razão social=${d['Razão social (nota)'] || '∅'} | Nome social=${d['Nome social'] || '∅'}`);
        console.log(`  CNPJ=${d['CNPJ emitente'] || '∅'} | CFOP=${d['CFOP'] || '∅'} | chave=${(d['Chave de acesso'] || '∅').slice(0, 44)}`);
        console.log(`  Total=${d['Valor total da nota'] || '∅'} (${d['Origem do valor total'] || '—'})`);
        for (const it of d['Itens'].slice(0, 3))
            console.log(`   · ${String(it['Descrição'] || '∅').slice(0, 38).padEnd(38)} ${String(it['Unidade'] || '—').padEnd(4)} q=${it['Quantidade'] ?? '?'} un=${it['Valor unitário'] || '?'} tot=${it['Valor total']} [${it['Confiança']}]`);
        if (d['Itens'].length > 3) console.log(`   … +${d['Itens'].length - 3}`);
    }
    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
