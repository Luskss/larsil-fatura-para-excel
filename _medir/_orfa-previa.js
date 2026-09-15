/**
 * _medir/_orfa-previa.js — mostra, para um arquivo específico, as duas linhas e o que
 * `fundir-orfas.js` produziria. Serve para conferir a fusão em casos conhecidos ANTES
 * de gravar: PRIMO ROSSI (a velha tem o CNPJ certo), CIMAG (a velha tem a chave certa).
 *
 * Uso: node _medir/_orfa-previa.js "<trecho do nome>" [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

function parseCsv(txt) {
    txt = String(txt || '').replace(/^﻿/, '');
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === ';') { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

// reaproveita a fusão real, fatiando o fonte — para a prévia não divergir do que grava
function fundirReal() {
    const src = fs.readFileSync(path.join(__dirname, 'fundir-orfas.js'), 'utf8');
    const ini = src.indexOf('// ── validação da chave');
    const fim = src.indexOf('(async () => {');
    const f = new Function(`${src.slice(ini, fim)} return { fundirParser, RE_PASTA_NOVA };`);
    return f();
}

(async () => {
    const { fundirParser, RE_PASTA_NOVA } = fundirReal();
    const trecho = (process.argv[2] || 'PRIMO ROSSI').toUpperCase();
    const periodoArg = process.argv[3] || null;

    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let mostrados = 0;
    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        const porArquivo = new Map();
        for (const row of rows.slice(1)) {
            const a = row[i('arquivo')];
            if (!a || !a.toUpperCase().includes(trecho)) continue;
            if (!porArquivo.has(a)) porArquivo.set(a, []);
            porArquivo.get(a).push(row);
        }
        for (const [arq, grupo] of porArquivo) {
            if (grupo.length < 2) continue;
            const novas  = grupo.filter(g => RE_PASTA_NOVA.test(g[i('pasta')]));
            const velhas = grupo.filter(g => !RE_PASTA_NOVA.test(g[i('pasta')]));
            if (!novas.length || !velhas.length) continue;
            if (mostrados++ >= 2) return;

            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const dN = pj(novas[0]), dV = pj(velhas[0]);
            const log = { ganhos: 0, conflitos: 0, novaVence: 0, velhaVence: 0, ambasLixo: 0 };
            const fundido = fundirParser(dN, dV, log);

            console.log(`${rec.PERIODO} · ${arq}`);
            console.log(`   nova : ${novas[0][i('pasta')]}`);
            console.log(`   velha: ${velhas[0][i('pasta')]}\n`);
            const campos = [...new Set([...Object.keys(dN), ...Object.keys(dV)])].sort();
            const cur = v => { const s = v == null ? '—' : (typeof v === 'object' ? `[${Array.isArray(v) ? v.length + ' itens' : 'obj'}]` : String(v)); return s.length > 46 ? s.slice(0, 44) + '…' : s; };
            console.log(`   ${'campo'.padEnd(24)} ${'NOVA'.padEnd(46)} ${'VELHA'.padEnd(46)} FUNDIDO`);
            for (const k of campos) {
                const a = cur(dN[k]), b = cur(dV[k]), c = cur(fundido[k]);
                const marca = (a !== b && b !== '—' && a !== '—') ? ' ⚑' : '';
                console.log(`   ${k.padEnd(24)} ${a.padEnd(46)} ${b.padEnd(46)} ${c}${marca}`);
            }
            console.log(`\n   ganhos ${log.ganhos} · conflitos ${log.conflitos} (nova ${log.novaVence}, velha ${log.velhaVence})`);
            console.log('='.repeat(100) + '\n');
        }
    }
    if (!mostrados) console.log('nenhuma duplicata encontrada para', trecho);
})().catch(e => { console.error(e); process.exit(1); });
