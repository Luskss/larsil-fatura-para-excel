/**
 * _medir/_emitente-larsil.js — a fusão consertou o CNPJ de vários documentos (o do
 * pagador deu lugar ao do emitente real), mas os 75 contraditos de março não caíram.
 * A inspeção do caso DALIANI mostrou por quê: o campo `Emitente` continua "LARSIL
 * FLORESTAL LTDA" — o nome do PAGADOR gravado como se fosse o do emitente.
 *
 * É a mesma doença de [[cnpj-do-emitente-pega-o-pagador]], num campo diferente: em
 * NFS de serviço prestado A NÓS, o único nome com destaque na página é o nosso.
 *
 * Mede: quantos documentos têm a LARSIL como `Emitente`, por tipo e período, e se o
 * CNPJ gravado ao lado é de terceiro (prova de que o nome está errado, não o CNPJ).
 *
 * Uso: node _medir/_emitente-larsil.js [periodo]
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

const CNPJ_LARSIL = '8420245000180';
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
// A LARSIL aparece com várias razões sociais no acervo (FLORESTAL, SERVIÇOS FLORESTAIS).
const ehLarsil = s => /\bLARSIL\b/i.test(String(s ?? ''));

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let linhas = 0, comEmitente = 0, larsilNome = 0;
    let cnpjTerceiro = 0, cnpjLarsil = 0, semCnpj = 0;
    const porTipo = new Map(), porPeriodo = new Map();
    const exemplos = [];

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        for (const row of rows.slice(1)) {
            if (!row[i('arquivo')]) continue;
            linhas++;
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || typeof d !== 'object') continue;
            const emit = d['Emitente'];
            if (!emit || String(emit).trim() === '' || String(emit).trim() === '—') continue;
            comEmitente++;
            if (!ehLarsil(emit)) continue;
            larsilNome++;

            const c = digitos(row[i('cnpj')] || d['CNPJ emitente']);
            if (!c) semCnpj++;
            else if (c === CNPJ_LARSIL) cnpjLarsil++;
            else {
                cnpjTerceiro++;   // nome nosso + CNPJ de terceiro = o NOME está errado
                if (exemplos.length < 8)
                    exemplos.push(`${rec.PERIODO} · ${row[i('tipo')].padEnd(9)} ${String(row[i('arquivo')]).slice(0, 62)}\n        Emitente "${emit}"  ·  CNPJ ${c}`);
            }
            const t = row[i('tipo')] || '(sem tipo)';
            porTipo.set(t, (porTipo.get(t) || 0) + 1);
            porPeriodo.set(rec.PERIODO, (porPeriodo.get(rec.PERIODO) || 0) + 1);
        }
    }

    const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');
    console.log(`escopo: ${periodoArg || 'todos os meses'}   (${linhas} linhas)\n`);
    console.log(`linhas com Emitente preenchido        ${comEmitente}`);
    console.log(`  com a LARSIL como Emitente          ${larsilNome}  ${pct(larsilNome, comEmitente)}`);
    console.log(`\ndestas, o CNPJ ao lado é:`);
    console.log(`  de TERCEIRO  ${cnpjTerceiro}   ← prova que o NOME está errado, não o CNPJ`);
    console.log(`  da LARSIL    ${cnpjLarsil}   ← nome e CNPJ do pagador; nada aproveitável`);
    console.log(`  ausente      ${semCnpj}`);

    if (porTipo.size) {
        console.log(`\npor tipo de documento:`);
        for (const [k, v] of [...porTipo].sort((a, b) => b[1] - a[1]).slice(0, 10))
            console.log(`   ${String(v).padStart(5)}  ${k}`);
    }
    if (porPeriodo.size) {
        console.log(`\npor período:`);
        for (const [k, v] of [...porPeriodo].sort((a, b) => b[1] - a[1]).slice(0, 8))
            console.log(`   ${String(v).padStart(5)}  ${k}`);
    }
    if (exemplos.length) {
        console.log(`\nexemplos (nome nosso, CNPJ de terceiro):`);
        for (const e of exemplos) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
