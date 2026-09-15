/**
 * _medir/_forma-itens.js — o dados_parser grava itens em DUAS formas diferentes:
 * "Itens" (maiúsculo, com 'Descrição'/'Valor unitário' — o que process-folder.js
 * normaliza) e "itens" (minúsculo, com 'descricao'/'valorUnitario' — o objeto cru
 * da IA). A tela de detalhe só lê a primeira, então documentos gravados na segunda
 * forma abrem o modal sem nenhum item.
 *
 * Esta medição responde: quantas linhas estão em cada forma, e o prefixo de pasta
 * separa as duas (indicando qual caminho de gravação produz qual)?
 *
 * Uso: node _medir/_forma-itens.js [periodo]   (sem período = todos os meses)
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
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let linhas = 0, soMai = 0, soMin = 0, ambas = 0, nenhuma = 0;
    const pastaPorForma = { maiuscula: new Map(), minuscula: new Map() };
    const exemplos = { maiuscula: [], minuscula: [] };

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
            const mai = Array.isArray(d['Itens']) && d['Itens'].length > 0;
            const min = Array.isArray(d['itens']) && d['itens'].length > 0;
            if (mai && min) ambas++; else if (mai) soMai++; else if (min) soMin++; else { nenhuma++; continue; }
            // primeiro segmento da pasta: separa o caminho de gravação
            const raiz = String(row[i('pasta')] || '').split('/')[0] || '(vazio)';
            if (mai) {
                pastaPorForma.maiuscula.set(raiz, (pastaPorForma.maiuscula.get(raiz) || 0) + 1);
                if (exemplos.maiuscula.length < 3) exemplos.maiuscula.push(`${rec.PERIODO} · ${row[i('pasta')]} · ${row[i('arquivo')]}`);
            }
            if (min) {
                pastaPorForma.minuscula.set(raiz, (pastaPorForma.minuscula.get(raiz) || 0) + 1);
                if (exemplos.minuscula.length < 3) exemplos.minuscula.push(`${rec.PERIODO} · ${row[i('pasta')]} · ${row[i('arquivo')]}`);
            }
        }
    }

    const pct = n => (linhas ? (100 * n / linhas).toFixed(1) + '%' : '—');
    console.log(`escopo: ${periodoArg || 'todos os meses'}`);
    console.log(`linhas totais            ${linhas}`);
    console.log(`só "Itens" (maiúsculo)   ${soMai}  ${pct(soMai)}   ← a tela LÊ esta`);
    console.log(`só "itens" (minúsculo)   ${soMin}  ${pct(soMin)}   ← a tela NÃO lê: modal vazio`);
    console.log(`as duas formas juntas    ${ambas}  ${pct(ambas)}`);
    console.log(`sem itens                ${nenhuma}  ${pct(nenhuma)}`);

    for (const forma of ['maiuscula', 'minuscula']) {
        const m = pastaPorForma[forma];
        if (!m.size) continue;
        console.log(`\npastas-raiz com forma ${forma}:`);
        for (const [p, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(n).padStart(5)}  ${p}`);
        console.log('  exemplos:');
        for (const e of exemplos[forma]) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
