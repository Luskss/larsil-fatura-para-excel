/**
 * _medir/_carne-detalhe.js — abre UM carnê linha a linha, para ver se as
 * parcelas repetidas são duplicata de verdade ou artefato do meu limiar.
 *
 * `_carnes.js` marcou como suspeito "9 linhas, 6 vencimentos distintos" usando
 * um corte de 80% que eu escolhi sem base. 6 de 9 pode ser 3 duplicatas reais
 * (ruído) ou 3 parcelas que legitimamente caem no mesmo dia. Só olhando as
 * linhas dá para saber — e a diferença decide se há bug a corrigir.
 *
 * Uso: node _medir/_carne-detalhe.js <trecho-do-nome>
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
    const alvo = (process.argv[2] || 'MAQNELSON AGRICOLA').toUpperCase();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const res = await pool.request().query(
        "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    // uma parcela pode aparecer em VÁRIOS relatórios mensais (cada uma é arquivada
    // no mês do seu vencimento) — por isso guardamos o período de cada linha.
    const achadas = [];
    for (const rec of res.recordset) {
        for (const row of csvToRows(rec.CONTEUDO)) {
            if (!base(row.arquivo).toUpperCase().includes(alvo)) continue;
            achadas.push({ ...row, periodo: rec.PERIODO });
        }
    }
    if (!achadas.length) { console.log(`nada com "${alvo}"`); process.exit(0); }

    const pdf = base(achadas[0].arquivo);
    console.log(`PDF: ${pdf}\n${achadas.length} linha(s) no banco\n`);
    console.log('  relatório  arquivo            parcela   vencimento   valor        nosso número');
    const chave = new Map();
    for (const r of achadas.sort((a, b) => String(a.arquivo).localeCompare(String(b.arquivo)))) {
        let d = {};
        try { d = JSON.parse(r.dados_parser) || {}; } catch (_) {}
        const suf = (String(r.arquivo).match(/#p(\d+)$/) || [])[1] || '-';
        const venc = d['Data de vencimento'] || '—';
        const val = d['Valor total'] || d['Valor do boleto'] || '—';
        const nn = d['Nosso Número'] || '—';
        const parc = d['Parcela'] || '—';
        console.log(`  ${String(r.periodo).padEnd(10)} #p${String(suf).padEnd(4)} ${String(parc).padEnd(9)} ${String(venc).padEnd(12)} ${String(val).padEnd(12)} ${nn}`);
        // a identidade real de um boleto: nosso número, ou (vencimento+valor)
        const k = nn !== '—' ? `nn:${nn}` : `vv:${venc}|${val}`;
        chave.set(k, (chave.get(k) || 0) + 1);
    }

    const repetidas = [...chave.entries()].filter(([, n]) => n > 1);
    console.log(`\n${chave.size} boleto(s) distinto(s) entre ${achadas.length} linha(s).`);
    if (repetidas.length) {
        console.log('\nlinhas que repetem o MESMO boleto:');
        for (const [k, n] of repetidas) console.log(`  ${n}×  ${k}`);
        console.log('\n→ a mesma parcela aparece em mais de um relatório mensal?');
        console.log('   Se sim, é esperado: cada parcela é arquivada no mês do SEU vencimento,');
        console.log('   então o mesmo boleto consta do relatório de cada mês que o contém.');
    } else {
        console.log('nenhuma repetição — cada linha é um boleto distinto.');
    }
    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
