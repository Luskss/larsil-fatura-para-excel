/**
 * _medir/_o-que-sobrou-dos-58.js — se o ganho é 0, o que eram os 58?
 *
 * REPROVAÇÃO (21/09/2026): `_quantos-documentos-de-verdade.js` mostrou que os
 * "11 curados" eram 21 linhas `#pN` de 11 carnês. Documentos únicos curados: **0**.
 * Em carnê, `process-folder.js:619` sobrescreve `Valor total` com o valor DA
 * PARCELA, então a exceção não muda nada do que o usuário vê.
 *
 * Isso reabre a pergunta original: os 58 pares com valor divergente do nome E do
 * lançamento — o que são, afinal?
 *
 * Hipótese nova: se 11 dos principais são carnês, talvez a maioria dos 58 seja o
 * mesmo fenômeno — a linha exibida é uma PARCELA, e comparar a parcela com o total
 * lançado dá "divergência" que não existe. Seria o erro de
 * [[total-da-nota-nao-e-valor-lancado]] pela terceira vez nesta sessão.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. dos 58, quantos são linha `#pN`?
 *   2. dos que NÃO são, o valor divergente tem explicação (parcela declarada no
 *      campo `Parcela`, retenção, etc.)?
 *   3. sobra algum defeito de verdade?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const V = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const vn = p.valorDoNome;

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
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
    const porArquivo = new Map();          // chave: arquivo EXATO, com #pN
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iD < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = String(f[iA] || '').trim();
            if (!arq || porArquivo.has(arq)) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { porArquivo.set(arq, JSON.parse(bruto)); } catch (e) {}
        }
    }

    // ── os 58, mantendo o nome EXATO que o pareamento usou ─────────────────
    const casos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const vL = Math.abs(Number(x.lancamento.valor) || 0);
            const vD = Math.abs(Number(x.documento.valor) || 0);
            const vNome = Math.abs(Number(vn(x.documento.arquivo)) || 0);
            if (!vL || !vD || !vNome) continue;
            if (Math.abs(vNome - vL) > 0.02) continue;
            if (Math.abs(vD - vL) < 0.02) continue;
            const arqExato = x.documento.arquivo;
            casos.push({ arqExato, vL, vD, forca: x.forca,
                         pd: porArquivo.get(arqExato) || porArquivo.get(semPN(arqExato)) || {} });
        }
    }

    console.log('═'.repeat(74));
    console.log(`OS ${casos.length} — quantos são parcela disfarçada?`);
    console.log('═'.repeat(74));

    const parcelas = casos.filter(k => ehParcela(k.arqExato));
    const docs = casos.filter(k => !ehParcela(k.arqExato));
    console.log(`\n   linhas #pN (parcela de carnê):  ${String(parcelas.length).padStart(3)}  ${pct(parcelas.length, casos.length)}`);
    console.log(`   linhas de documento único:      ${String(docs.length).padStart(3)}  ${pct(docs.length, casos.length)}`);

    // ── dos que são documento, o campo `Parcela` explica? ──────────────────
    console.log('\n── dos documentos únicos, quantos declaram ser parcela? ────');
    let comCampoParcela = 0;
    const semExplicacao = [];
    for (const k of docs) {
        const par = String(k.pd['Parcela'] || '').trim();
        if (par && !/^1\/1$/.test(par)) { comCampoParcela++; continue; }
        semExplicacao.push(k);
    }
    console.log(`   campo \`Parcela\` preenchido (ex. "2/3"): ${comCampoParcela}`);
    console.log(`   sem explicação:                          ${semExplicacao.length}`);

    // ── a razão é inteira nos sem explicação? ──────────────────────────────
    console.log('\n── nos sem explicação, a razão lançado/lido é inteira? ─────');
    let razaoInteira = 0;
    const duros = [];
    for (const k of semExplicacao) {
        const r = k.vL / k.vD;
        const n = Math.round(r);
        if (n >= 2 && n <= 24 && Math.abs(r - n) / n < 0.01) razaoInteira++;
        else duros.push({ ...k, r });
    }
    console.log(`   razão inteira (parcelamento não declarado): ${razaoInteira}`);
    console.log(`   razão quebrada — CANDIDATOS A DEFEITO:      ${duros.length}`);

    if (duros.length) {
        console.log('\n── os que sobram, um a um ──────────────────────────────────');
        for (const d of duros.sort((a, b) => b.vL - a.vL)) {
            console.log(`\n   ${d.arqExato.slice(0, 64)}`);
            console.log(`      lançado=${brl(d.vL).padStart(14)}   lido=${brl(d.vD).padStart(14)}   razão=${d.r.toFixed(2)}  força ${d.forca}`);
            const ld = d.pd['Linha digitável'];
            const vLD = V.valorDaLinhaDigitavel(ld);
            console.log(`      LD=${vLD == null ? '(sem LD de 47 díg.)' : brl(vLD)}   boleto=${d.pd['Valor do boleto'] || '—'}`);
            console.log(`      Parcela="${d.pd['Parcela'] || '—'}"   origem do valor="${d.pd['Origem do valor pago'] || '—'}"`);
        }
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(74));
    console.log(`\n   Dos ${casos.length} "valores errados", ${parcelas.length} são linha de PARCELA —`);
    console.log('   comparar a parcela com o total lançado inventa divergência.');
    console.log(`   Sobram ${duros.length} candidatos reais a defeito de extração.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
