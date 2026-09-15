/**
 * _medir/_ganho-itens.js — quanto o modal de detalhe passa a mostrar depois de
 * `itensDoParser` aceitar a forma antiga ("itens" minúsculo) além da nova ("Itens").
 *
 * Roda a função REAL de comparar-notas.js contra o banco, em vez de reimplementá-la,
 * para não medir uma cópia que diverge do que a tela usa.
 *
 * Uso: node _medir/_ganho-itens.js [periodo]
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

// Fatia o fonte até a primeira rota para pegar `itensDoParser` sem subir o Express.
function itensDoParserReal() {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('function itensDoParser');
    const fim = src.indexOf('function detalheOcr');
    const f = new Function(`${src.slice(corte, fim)} return itensDoParser;`);
    return f();
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

(async () => {
    const itensDoParser = itensDoParserReal();
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let linhas = 0, antes = 0, depois = 0, ganhas = 0;
    const amostra = [];
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
            const a = Array.isArray(d['Itens']) && d['Itens'].length > 0;
            const b = !!itensDoParser(d);
            if (a) antes++;
            if (b) depois++;
            if (b && !a) {
                ganhas++;
                if (amostra.length < 3) {
                    const it = itensDoParser(d)[0];
                    amostra.push(`${rec.PERIODO} · ${row[i('arquivo')]}\n        → ${it['Descrição']} | ${it['Unidade']} | ${it['Quantidade']} × ${it['Valor unitário']} = ${it['Valor total']}`);
                }
            }
        }
    }
    const pct = n => (linhas ? (100 * n / linhas).toFixed(1) + '%' : '—');
    console.log(`escopo: ${periodoArg || 'todos os meses'}   (${linhas} linhas)`);
    console.log(`modal com itens ANTES  ${antes}  ${pct(antes)}`);
    console.log(`modal com itens DEPOIS ${depois}  ${pct(depois)}`);
    console.log(`ganhas                 ${ganhas}`);
    if (amostra.length) {
        console.log('\namostra das ganhas (confira se os campos saíram traduzidos certo):');
        for (const a of amostra) console.log(`   · ${a}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
