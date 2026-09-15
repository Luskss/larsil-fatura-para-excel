/**
 * _medir/_campos-retencao.js — quais campos de RETENÇÃO o parser já grava?
 *
 * Pergunta: a divergência "valor do documento < valor lançado" costuma ser o
 * imposto retido na fonte (ISSRF/IR/INSS/CSLL/PIS/COFINS). Antes de inventar
 * regra, é preciso saber se o número já está gravado em `dados_parser` — se
 * estiver, conferir "diferença == retenção" é aritmética, não heurística.
 *
 * Varre TODAS as chaves de todos os JSONs de dados_parser e conta frequência.
 */
'use strict';
const h = require('./harness');

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    function separarCsv(linha) {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const c = linha[i];
            if (aspas) { if (c === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; } else atual += c; }
            else if (c === '"') aspas = true;
            else if (c === ';') { out.push(atual); atual = ''; }
            else atual += c;
        }
        out.push(atual); return out;
    }

    const freq = {};      // chave → quantas vezes apareceu
    const exemplo = {};   // chave → um valor de amostra
    let docs = 0;

    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iParser = cols.indexOf('dados_parser');
        if (iParser < 0) continue;

        for (let i = 1; i < ls.length; i++) {
            const campos = separarCsv(ls[i]);
            const bruto = (campos[iParser] || '').trim();
            if (!bruto.startsWith('{')) continue;
            let d; try { d = JSON.parse(bruto); } catch (e) { continue; }
            docs++;
            for (const [k, v] of Object.entries(d)) {
                freq[k] = (freq[k] || 0) + 1;
                if (exemplo[k] == null && v != null && String(v).trim()) exemplo[k] = String(v).slice(0, 40);
            }
        }
    }

    console.log(`documentos com dados_parser: ${docs}\n`);
    const chaves = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    console.log('TODAS as chaves, por frequência:');
    for (const [k, n] of chaves)
        console.log(`  ${String(n).padStart(6)}  ${k.padEnd(38)} ex: ${exemplo[k] || ''}`);

    const RET = /ISS|IR\b|IRRF|INSS|CSLL|PIS|COFINS|RETEN|RETID|LIQUID|DEDUC|DESCONT|TRIBUT/i;
    console.log('\nas que cheiram a retenção/líquido:');
    for (const [k, n] of chaves) if (RET.test(k))
        console.log(`  ${String(n).padStart(6)}  ${k.padEnd(38)} ex: ${exemplo[k] || ''}`);

    process.exit(0);
})();
