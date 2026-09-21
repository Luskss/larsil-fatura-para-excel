/**
 * _medir/_veredito-final-da-excecao.js — o número correto, medido na linha certa
 *
 * HISTÓRIA (21/09/2026) — errei duas vezes e as duas foram por escolher a linha errada:
 *
 *   1. `_conferir-o-implementado.js` deduplicava por `base()` (remove `#pN`) e
 *      guardava a PRIMEIRA linha vista — às vezes uma parcela. Disse "11 curados".
 *   2. `_quantos-documentos-de-verdade.js` corrigiu para o outro extremo e concluiu
 *      "0 documentos, tudo parcela" — mas ele também pegava a primeira linha, e
 *      classificava o caso pelo nome DESSA linha.
 *
 * `_resolver-a-contradicao.js` mostrou o que decide: o carnê TEM linha sem sufixo,
 * o índice do pareamento tem **4.844 chaves e ZERO com `#pN`**, e o valor que o
 * painel exibe para o LOCALIZA de R$ 91.288,49 é R$ 5.368,68 — o valor errado que
 * a exceção corrige.
 *
 * ── Este script mede na linha que o PAINEL usa ──────────────────────────────
 * Chave = nome do arquivo SEM sufixo, e o `dados_parser` é o da linha SEM sufixo
 * (não a primeira que aparecer). É a única que o `enriquecerComOcr` consulta.
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
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function valorDoNomeArquivo(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();

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
    // SÓ as linhas SEM sufixo — as que o índice do pareamento enxerga
    const pdDoDocumento = new Map();
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
            if (!arq || ehParcela(arq)) continue;        // ← a diferença
            if (pdDoDocumento.has(arq)) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { pdDoDocumento.set(arq, JSON.parse(bruto)); } catch (e) {}
        }
    }
    console.log(`linhas de DOCUMENTO (sem #pN) com dados_parser: ${pdDoDocumento.size}\n`);

    // ── A/B sobre os pares do painel ───────────────────────────────────────
    let pares = 0, age = 0, cura = 0, quebra = 0, indif = 0;
    const exemplos = [];
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
            const arq = x.documento.arquivo;
            const pd = pdDoDocumento.get(arq);
            if (!pd) continue;
            pares++;
            const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
            if (!vLanc) continue;
            const vNome = valorDoNomeArquivo(arq);
            const antes = V.valorPorPrecedencia(pd);
            const depois = V.valorPorPrecedencia(pd, vNome);
            if (antes.valor == null || depois.valor == null) continue;
            if (Math.abs(antes.valor - depois.valor) < 0.02) continue;
            age++;
            const certoAntes = Math.abs(antes.valor - vLanc) < 0.02;
            const certoDepois = Math.abs(depois.valor - vLanc) < 0.02;
            if (!certoAntes && certoDepois) { cura++; if (exemplos.length < 16) exemplos.push({ arq, antes, depois, vLanc }); }
            else if (certoAntes && !certoDepois) { quebra++; exemplos.push({ arq, antes, depois, vLanc, RUIM: true }); }
            else indif++;
        }
    }

    console.log('═'.repeat(74));
    console.log('VEREDITO — medido na linha que o PAINEL usa');
    console.log('═'.repeat(74));
    console.log(`\n   pares com linha de documento no banco: ${pares}`);
    console.log(`   a exceção MUDA o valor em:             ${age}`);
    console.log(`      CURA:                               ${String(cura).padStart(3)}`);
    console.log(`      QUEBRA:                             ${String(quebra).padStart(3)}`);
    console.log(`      indiferente:                        ${String(indif).padStart(3)}`);

    for (const e of exemplos) {
        console.log(`\n   ${e.RUIM ? '⚠ QUEBRA  ' : ''}${e.arq.slice(0, 62)}`);
        console.log(`      lançado=${brl(e.vLanc).padStart(14)}`);
        console.log(`      ${brl(e.antes.valor)} (${e.antes.origem}) → ${brl(e.depois.valor)} (${e.depois.origem})`);
    }

    // ── regressão: SENATRAN ────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('REGRESSÃO: SENATRAN / MINISTÉRIO DA JUSTIÇA');
    console.log('═'.repeat(74));
    let mexeu = 0;
    for (const [arq, pd] of pdDoDocumento) {
        if (!/SENATRAN|MINISTERIO DA JUSTI/i.test(arq)) continue;
        const antes = V.valorPorPrecedencia(pd);
        const depois = V.valorPorPrecedencia(pd, valorDoNomeArquivo(arq));
        if (antes.valor == null || depois.valor == null) continue;
        if (Math.abs(antes.valor - depois.valor) > 0.02) {
            mexeu++;
            console.log(`   ⚠ ${arq.slice(0, 54)}  ${brl(antes.valor)} → ${brl(depois.valor)}`);
        }
    }
    console.log(`   documentos alterados: ${mexeu}  ${mexeu ? '⚠' : '✓ nenhum'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
