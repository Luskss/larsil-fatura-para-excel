/**
 * _medir/_harness-anatomia-do-conflito.js — quantas linhas disputam cada arquivo?
 *
 * DEFEITO (21/09/2026, [[trava-do-boleto-maior-barra-a-ld]]): `_medir/ocr.js:95`
 * remove o sufixo `#pN` e a linha 112 fica com o PRIMEIRO valor visto. As linhas
 * de parcela vêm antes no CSV, então o índice descreve o documento com o valor da
 * parcela — em 88 arquivos.
 *
 * Antes de escolher COMO consertar, preciso saber o que existe. Escolher a regra
 * sem ver a distribuição é o que me levou a três conclusões contraditórias ontem.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. quantos arquivos têm mais de uma linha? de que tipos?
 *   2. existe SEMPRE uma linha sem sufixo quando há `#pN`?
 *   3. quantas linhas sem sufixo DUPLICADAS existem (mesmo arquivo, 2 relatórios)?
 *      → se houver, "preferir a sem sufixo" ainda deixa ambiguidade
 *   4. quando há várias linhas sem sufixo, elas divergem no valor?
 *   5. os OUTROS campos (numero, emitente, cnpj, data) também são afetados?
 *      → o defeito pode ser maior do que só o valor
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const { paraNumero, soDigitos } = require('./ocr');
function primeiro(obj, chaves) {
    for (const k of chaves) { const v = obj[k]; if (v != null && String(v).trim() !== '') return v; }
    return null;
}
const CAMPOS = {
    numero:   ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF'],
    emitente: ['Emitente', 'Razão social', 'Nome do emitente'],
    valor:    ['Valor total da nota', 'Valor total', 'Valor do boleto'],
    cnpj:     ['CNPJ emitente', 'CNPJ / CPF', 'CNPJ'],
    dtEmi:    ['Data de emissão', 'Data emissao'],
};

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT ID_RELATORIO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo ORDER BY ID_RELATORIO');
    const sep = (l) => {
        const o = []; let a = '', q = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (q) { if (ch === '"') { if (l[i + 1] === '"') { a += '"'; i++; } else q = false; } else a += ch; }
            else if (ch === '"') q = true;
            else if (ch === ';') { o.push(a); a = ''; }
            else a += ch;
        }
        o.push(a); return o;
    };

    // todas as linhas, na ORDEM em que o índice as vê
    const linhas = [];
    let ordem = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo'), iParser = cols.indexOf('dados_parser'),
              iCnpj = cols.indexOf('cnpj'), iOrig = cols.indexOf('origem');
        if (iArq < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const campos = sep(ls[i]);
            const arqExato = String(campos[iArq] || '').trim();
            if (!arqExato) continue;
            let d = {};
            const b = iParser >= 0 ? (campos[iParser] || '').trim() : '';
            if (b.startsWith('{')) { try { d = JSON.parse(b); } catch (e) {} }
            linhas.push({
                ordem: ordem++, relatorio: row.ID_RELATORIO, periodo: row.PERIODO,
                arqExato, base: semPN(arqExato),
                parcela: ehParcela(arqExato), d,
                origem: iOrig >= 0 ? String(campos[iOrig] || '').trim() : '',
                cnpjCol: iCnpj >= 0 ? String(campos[iCnpj] || '').trim() : '',
            });
        }
    }
    console.log(`linhas no banco: ${linhas.length}\n`);

    // ── (1) agrupar por arquivo base ───────────────────────────────────────
    const grupos = new Map();
    for (const l of linhas) {
        if (!grupos.has(l.base)) grupos.set(l.base, []);
        grupos.get(l.base).push(l);
    }
    console.log('═'.repeat(76));
    console.log('(1) COMPOSIÇÃO DOS GRUPOS');
    console.log('═'.repeat(76));
    const perfil = new Map();
    for (const [, g] of grupos) {
        const nDoc = g.filter(x => !x.parcela).length;
        const nPar = g.filter(x => x.parcela).length;
        const k = `${nDoc} doc + ${nPar} parcela${nPar === 1 ? '' : 's'}`;
        perfil.set(k, (perfil.get(k) || 0) + 1);
    }
    console.log(`\n   arquivos distintos: ${grupos.size}\n`);
    for (const [k, n] of [...perfil].sort((a, b) => b[1] - a[1]).slice(0, 12))
        console.log(`   ${k.padEnd(28)} ${String(n).padStart(5)}  ${pct(n, grupos.size)}`);

    // ── (2) há #pN SEM linha de documento? ─────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(2) EXISTE #pN ÓRFÃO (sem linha de documento)?');
    console.log('═'.repeat(76));
    const orfaos = [...grupos].filter(([, g]) => g.some(x => x.parcela) && !g.some(x => !x.parcela));
    console.log(`\n   grupos só com parcelas: ${orfaos.length}`);
    if (orfaos.length) {
        console.log('   ⚠ "preferir a linha sem sufixo" deixaria esses SEM valor.');
        for (const [b, g] of orfaos.slice(0, 8))
            console.log(`      ${b.slice(0, 54)}  (${g.length} parcelas)`);
    } else {
        console.log('   ✓ todo carnê tem linha de documento — a regra sempre acha uma.');
    }

    // ── (3) linhas de DOCUMENTO duplicadas ─────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(3) O MESMO ARQUIVO EM VÁRIOS RELATÓRIOS?');
    console.log('═'.repeat(76));
    const multiDoc = [...grupos].filter(([, g]) => g.filter(x => !x.parcela).length > 1);
    console.log(`\n   arquivos com MAIS DE UMA linha de documento: ${multiDoc.length}`);
    let divergemValor = 0, divergemOutro = 0;
    const exDiv = [];
    for (const [b, g] of multiDoc) {
        const docs = g.filter(x => !x.parcela);
        const vals = [...new Set(docs.map(x => {
            const v = paraNumero(primeiro(x.d, CAMPOS.valor));
            return v == null ? null : v.toFixed(2);
        }).filter(Boolean))];
        if (vals.length > 1) {
            divergemValor++;
            if (exDiv.length < 8) exDiv.push({ b, docs, vals });
        }
        const nums = [...new Set(docs.map(x => soDigitos(primeiro(x.d, CAMPOS.numero) || '')).filter(Boolean))];
        if (nums.length > 1) divergemOutro++;
    }
    console.log(`      desses, com VALOR divergente entre si: ${divergemValor}`);
    console.log(`      com NÚMERO divergente entre si:        ${divergemOutro}`);
    for (const e of exDiv) {
        console.log(`\n      ${e.b.slice(0, 56)}`);
        for (const d of e.docs)
            console.log(`         rel ${String(d.relatorio).padStart(4)} [${d.periodo || '—'}]  origem=${(d.origem || '—').padEnd(18)} valor=${paraNumero(primeiro(d.d, CAMPOS.valor)) == null ? '—' : brl(paraNumero(primeiro(d.d, CAMPOS.valor)))}`);
    }

    // ── (4) quais CAMPOS a parcela contamina ───────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(4) ALÉM DO VALOR, QUE CAMPOS A PARCELA CONTAMINA?');
    console.log('═'.repeat(76));
    const contamina = { numero: 0, emitente: 0, valor: 0, cnpj: 0, dtEmi: 0 };
    let gruposMistos = 0;
    for (const [, g] of grupos) {
        const docs = g.filter(x => !x.parcela);
        const pars = g.filter(x => x.parcela);
        if (!docs.length || !pars.length) continue;
        gruposMistos++;
        for (const campo of Object.keys(CAMPOS)) {
            // o que o índice ATUAL pegaria (primeira linha na ordem do CSV)
            const naOrdem = g.slice().sort((a, b) => a.ordem - b.ordem);
            let doIndice = null;
            for (const l of naOrdem) { const v = primeiro(l.d, CAMPOS[campo]); if (v != null) { doIndice = v; break; } }
            // o que a linha de DOCUMENTO diz
            let doDoc = null;
            for (const l of docs) { const v = primeiro(l.d, CAMPOS[campo]); if (v != null) { doDoc = v; break; } }
            if (doIndice == null || doDoc == null) continue;
            const a = campo === 'valor' ? String(paraNumero(doIndice)) : String(doIndice).trim();
            const b2 = campo === 'valor' ? String(paraNumero(doDoc)) : String(doDoc).trim();
            if (a !== b2) contamina[campo]++;
        }
    }
    console.log(`\n   grupos com documento E parcela: ${gruposMistos}\n`);
    for (const [c, n] of Object.entries(contamina))
        console.log(`   ${c.padEnd(12)} ${String(n).padStart(4)} arquivos descritos errado  ${pct(n, gruposMistos)}`);

    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
