/**
 * _medir/_status-reproc.js — checa o andamento do reprocesso de 03.2026 direto no
 * banco (proxy: quantas linhas com CFOP/Itens preenchidos, campos que só a rodada
 * nova grava), já que o stdout do processo em segundo plano não sobreviveu ao
 * restart do server.
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
    const pool = await getConnection();
    const r = await pool.request()
        .input('p', sql.VarChar(20), '03.2026')
        .query("SELECT PERIODO, CONTEUDO, DATALENGTH(CONTEUDO) AS bytes FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M' AND PERIODO=@p");
    if (!r.recordset.length) { console.log('sem linha M/03.2026 ainda'); return; }
    const row = r.recordset[0];
    console.log(`tamanho do CONTEUDO: ${(row.bytes / 1024).toFixed(0)} KB`);
    const rows = parseCsv(row.CONTEUDO);
    const h = rows[0];
    const i = n => h.indexOf(n);
    let total = 0, comCfop = 0, comItens = 0, comChave = 0;
    for (const rr of rows.slice(1)) {
        if (!rr[i('arquivo')]) continue;
        total++;
        if (rr[i('cfop')]) comCfop++;
        if (rr[i('itens')]) comItens++;
        if (rr[i('chave_acesso')]) comChave++;
    }
    console.log(`linhas: ${total}`);
    console.log(`com CFOP (campo novo)   : ${comCfop}  ${(comCfop*100/total).toFixed(1)}%`);
    console.log(`com Itens (campo novo)  : ${comItens}  ${(comItens*100/total).toFixed(1)}%`);
    console.log(`com chave de acesso     : ${comChave}  ${(comChave*100/total).toFixed(1)}%`);
})().catch(e => { console.error(e); process.exit(1); });
