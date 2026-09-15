/**
 * _medir/_ver-parser-recibo.js — dados_parser bruto de um arquivo específico, para
 * ver de onde a extração tirou o CNPJ que aparece repetido em vários recibos
 * diferentes (08420245000180). Uso: node _medir/_ver-parser-recibo.js <trecho do nome> [periodo]
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

(async () => {
    const trecho = process.argv[2] || 'DALIANI';
    const periodoArg = process.argv[3] || '03.2026';
    const pool = await getConnection();
    const r = await pool.request().input('p', sql.VarChar(20), periodoArg)
        .query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M' AND PERIODO=@p");
    const rows = parseCsv(r.recordset[0].CONTEUDO);
    const h = rows[0];
    const i = n => h.indexOf(n);
    const achados = rows.slice(1).filter(row => String(row[i('arquivo')]).toUpperCase().includes(trecho.toUpperCase()));
    for (const row of achados) {
        console.log('arquivo :', row[i('arquivo')]);
        console.log('pasta   :', row[i('pasta')]);
        console.log('tipo    :', row[i('tipo')]);
        console.log('origem  :', row[i('origem')]);
        console.log('cnpj col:', row[i('cnpj')]);
        console.log('conteudo:', row[i('conteudo')]);
        try {
            const d = JSON.parse(row[i('dados_parser')] || '{}');
            console.log('dados_parser:', JSON.stringify(d, null, 2));
        } catch (e) { console.log('dados_parser (raw):', row[i('dados_parser')]); }
        console.log('='.repeat(70));
    }
})().catch(e => { console.error(e); process.exit(1); });
