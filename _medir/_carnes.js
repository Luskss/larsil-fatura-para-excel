/**
 * _medir/_carnes.js — os carnês desmembrados em N parcelas distorcem o painel?
 *
 * O scan de 03/2026 leu 933 PDFs e gravou 4.080 linhas: a IA detectou cotas de
 * consórcio com 32, 33 e até 48 parcelas, e cada parcela vira uma linha própria
 * (arquivo "X.pdf#p1", "#p2"...). A pergunta é se isso é correto ou se está
 * inflando as contagens que a tela mostra.
 *
 * O critério: uma parcela SÓ deveria virar linha se for um boleto distinto de
 * verdade — Nosso Número próprio, vencimento próprio. Se as N linhas repetem o
 * mesmo valor e o mesmo vencimento, a IA contou a mesma parcela N vezes, e aí é
 * ruído puro.
 *
 * Uso: node _medir/_carnes.js [quantosExemplos]
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

const base = a => String(a || '').replace(/#p\d+$/i, '');

(async () => {
    const quantos = Number(process.argv[2] || 8);
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const res = await pool.request().query(
        "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    // agrupa as linhas por PDF de origem
    const porPdf = new Map();
    let linhasTotal = 0;
    for (const rec of res.recordset) {
        for (const row of csvToRows(rec.CONTEUDO)) {
            linhasTotal++;
            const k = `${base(row.arquivo)}|${row.pasta}`;
            if (!porPdf.has(k)) porPdf.set(k, []);
            porPdf.get(k).push(row);
        }
    }

    const carnes = [...porPdf.entries()].filter(([, rows]) => rows.length > 1);
    const linhasDeCarne = carnes.reduce((s, [, r]) => s + r.length, 0);

    console.log(`${linhasTotal} linhas no banco, de ${porPdf.size} PDFs distintos.`);
    console.log(`PDFs desmembrados em parcelas: ${carnes.length}`);
    console.log(`linhas geradas por eles      : ${linhasDeCarne}  (${(100 * linhasDeCarne / linhasTotal).toFixed(1)}% do banco)`);
    console.log(`inflação                     : +${linhasDeCarne - carnes.length} linhas\n`);

    // distribuição do nº de parcelas
    const dist = new Map();
    for (const [, rows] of carnes) {
        const faixa = rows.length <= 3 ? String(rows.length)
                    : rows.length <= 6 ? '4-6'
                    : rows.length <= 12 ? '7-12'
                    : rows.length <= 24 ? '13-24' : '25+';
        dist.set(faixa, (dist.get(faixa) || 0) + 1);
    }
    console.log('── quantas parcelas por PDF ──');
    for (const f of ['2', '3', '4-6', '7-12', '13-24', '25+'])
        if (dist.has(f)) console.log(`  ${f.padStart(5)} parcelas  ${String(dist.get(f)).padStart(4)} PDFs`);

    // ── O teste que importa: as parcelas são DISTINTAS? ──────────────────────
    // Um carnê real tem vencimentos diferentes. Se as N linhas repetem o mesmo
    // vencimento (ou o mesmo Nosso Número), a IA contou a mesma parcela N vezes.
    let okDistintas = 0, suspeitos = 0, semDados = 0;
    const exemplos = [];
    for (const [k, rows] of carnes) {
        const vencs = new Set(), nossos = new Set();
        let comDado = 0;
        for (const r of rows) {
            let d = null;
            try { d = JSON.parse(r.dados_parser); } catch (_) { continue; }
            if (!d) continue;
            const v = d['Data de vencimento'] || '';
            const nn = d['Nosso Número'] || '';
            if (v) { vencs.add(v); comDado++; }
            if (nn) nossos.add(nn);
        }
        if (!comDado) { semDados++; continue; }
        // distintas se os vencimentos (ou os nossos-números) variam
        const distintas = vencs.size >= rows.length * 0.8 || nossos.size >= rows.length * 0.8;
        if (distintas) okDistintas++;
        else {
            suspeitos++;
            if (exemplos.length < quantos)
                exemplos.push({ k, n: rows.length, vencs: [...vencs].slice(0, 4), nVencs: vencs.size, nNossos: nossos.size });
        }
    }

    console.log(`\n── as parcelas são de fato distintas? (${carnes.length} PDFs) ──`);
    console.log(`  vencimentos/nosso-número VARIAM   ${String(okDistintas).padStart(4)}  ← carnê real, correto`);
    console.log(`  REPETEM (mesma parcela N vezes)   ${String(suspeitos).padStart(4)}  ← ruído`);
    console.log(`  sem dados para julgar             ${String(semDados).padStart(4)}`);

    if (exemplos.length) {
        console.log('\n── suspeitos: N linhas mas poucos vencimentos distintos ──');
        for (const e of exemplos) {
            console.log(`  ${e.k.split('|')[0].slice(0, 58)}`);
            console.log(`      ${e.n} linhas · ${e.nVencs} vencimento(s) distinto(s) · ${e.nNossos} nosso-número(s)`);
            console.log(`      vencs: ${e.vencs.join(', ') || '(nenhum)'}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
