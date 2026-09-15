/**
 * _medir/_chave-dv.js — a chave de acesso de 44 dígitos valida-se sozinha (DV mod-11).
 * Achado em 09/09/2026 (`_medir/_orfa-chave.js`): nas linhas órfãs, a leitura VELHA
 * tinha chave de 44 dígitos com DV ok em 80 de 80 casos, e a NOVA nunca — 42, 45, 40,
 * 47 dígitos, DV inválido. A IA lê a chave e perde/inventa dígitos.
 *
 * A pergunta aqui é maior que as órfãs: no acervo INTEIRO, quantas chaves gravadas
 * hoje são inválidas? Uma chave inválida é lixo verificável — não identifica nota
 * nenhuma, e pior, pode casar por engano.
 *
 * Uso: node _medir/_chave-dv.js [periodo]
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

const RE_PASTA_NOVA = /^\d{4}\.\d{2}\.[^/]*EXTRATOS/i;
function chaveValida(ch) {
    const s = String(ch ?? '').replace(/\D/g, '');
    if (s.length !== 44) return false;
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return dv === Number(s[43]);
}

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    const conta = { total: 0, comChave: 0, ok: 0, tam44ruim: 0, tamErrado: 0 };
    // separa por lado, para ver se o problema é da leitura nova ou geral
    const porLado = { nova: { c: 0, ok: 0 }, velha: { c: 0, ok: 0 } };
    const tamanhos = new Map();

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = c => h.indexOf(c);
        for (const row of rows.slice(1)) {
            if (!row[i('arquivo')]) continue;
            conta.total++;
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            const ch = d && d['Chave de acesso'];
            if (!ch || String(ch).trim() === '' || String(ch).trim() === '—') continue;
            conta.comChave++;
            const s = String(ch).replace(/\D/g, '');
            tamanhos.set(s.length, (tamanhos.get(s.length) || 0) + 1);
            const ok = chaveValida(ch);
            if (ok) conta.ok++;
            else if (s.length === 44) conta.tam44ruim++;
            else conta.tamErrado++;

            const lado = RE_PASTA_NOVA.test(row[i('pasta')]) ? 'nova' : 'velha';
            porLado[lado].c++;
            if (ok) porLado[lado].ok++;
        }
    }

    const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');
    console.log(`escopo: ${periodoArg || 'todos os meses'}   (${conta.total} linhas)\n`);
    console.log(`linhas com chave de acesso    ${conta.comChave}`);
    console.log(`  DV válido (44 díg)          ${conta.ok}  ${pct(conta.ok, conta.comChave)}`);
    console.log(`  44 dígitos mas DV errado    ${conta.tam44ruim}  ${pct(conta.tam44ruim, conta.comChave)}`);
    console.log(`  não tem 44 dígitos          ${conta.tamErrado}  ${pct(conta.tamErrado, conta.comChave)}`);

    console.log(`\npor lado da duplicata (pasta):`);
    for (const lado of ['velha', 'nova'])
        console.log(`  ${lado.padEnd(6)} ${String(porLado[lado].c).padStart(5)} com chave, ${String(porLado[lado].ok).padStart(5)} válidas  ${pct(porLado[lado].ok, porLado[lado].c)}`);

    console.log(`\ntamanhos encontrados:`);
    for (const [k, v] of [...tamanhos].sort((a, b) => b[1] - a[1]).slice(0, 10))
        console.log(`   ${String(v).padStart(5)} × ${k} dígitos${k === 44 ? '' : '   ← impossível'}`);
})().catch(e => { console.error(e); process.exit(1); });
