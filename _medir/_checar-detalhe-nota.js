/**
 * _medir/_checar-detalhe-nota.js — confere se `detalhe` (CFOP/Itens/valor da
 * nota/código da receita) está saindo do dados_parser como esperado, sem
 * precisar logar na tela (comparar-notas.js exige sessão IAM).
 *
 * Uso: node _medir/_checar-detalhe-nota.js [periodo]
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
    const periodoArg = process.argv[2] || '03.2026';
    const pool = await getConnection();
    const r = await pool.request()
        .input('p', sql.VarChar(20), periodoArg)
        .query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M' AND PERIODO=@p");
    if (!r.recordset.length) { console.log('sem relatório para', periodoArg); return; }

    const rows = parseCsv(r.recordset[0].CONTEUDO);
    const h = rows[0];
    const i = n => h.indexOf(n);
    const iParser = i('dados_parser');

    let comCfop = 0, comItens = 0, comValor = 0, comCodReceita = 0, total = 0;
    const exemplos = [];
    for (const row of rows.slice(1)) {
        if (!row[i('arquivo')]) continue;
        total++;
        let d = {};
        try { d = JSON.parse(row[iParser] || '{}'); } catch (_) { continue; }
        const semValorReal = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
        const temCfop = !semValorReal(d['CFOP']);
        const temItens = Array.isArray(d['Itens']) && d['Itens'].length > 0;
        const temValor = !!(d['Valor total da nota'] || d['Valor total'] || d['Valor do boleto']);
        const temCodReceita = !semValorReal(d['Código da receita']);
        if (temCfop) comCfop++;
        if (temItens) comItens++;
        if (temValor) comValor++;
        if (temCodReceita) comCodReceita++;
        if ((temCfop || temItens || temCodReceita) && exemplos.length < 5) {
            exemplos.push({
                arquivo: row[i('arquivo')].slice(0, 60),
                cfop: d['CFOP'] || null,
                qtdItens: temItens ? d['Itens'].length : 0,
                codigoReceita: d['Código da receita'] || null,
            });
        }
    }
    console.log(`período ${periodoArg}: ${total} linhas`);
    console.log(`  com CFOP            : ${comCfop}`);
    console.log(`  com Itens           : ${comItens}`);
    console.log(`  com valor (nota)    : ${comValor}`);
    console.log(`  com Código da receita: ${comCodReceita}`);
    console.log('\nexemplos:');
    exemplos.forEach(e => console.log(' ', JSON.stringify(e)));
})().catch(e => { console.error(e); process.exit(1); });
