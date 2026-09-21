/**
 * ⚠️ REPROVADO — NÃO USAR. Mantido só como registro do erro.
 *
 * Este script acusou 38 trocas de vencedor que NÃO EXISTEM: ele reproduz o bloco
 * de desempate à mão, omitindo o GUARD DE ENTIDADE (_baseline.js:935-953) e usando
 * um `vOk` sintético no lugar do `valorBate` real. O resultado é um motor MAIS
 * FROUXO que a produção, que põe SANCOR contra SANCOE na mesma disputa.
 *
 * O veredito correto está em `_tipo-trocas-importam.js` (64 cenários, valor nunca
 * piora, todos em grupos 1↔N). A lição virou memória:
 * [[tipobate-mexe-no-desempate-1-para-n]].
 *
 * _medir/_tipo-desempate-real.js — prova EMPÍRICA sobre os candidatos reais.
 *
 * `_tipo-pares-intactos.js` não rodou: a conferência do painel vive DENTRO do
 * handler HTTP de `_baseline.js` (a partir da linha 680), sem função exportada
 * que dê para chamar de fora.
 *
 * Então em vez de rodar o fluxo, reproduzimos o BLOCO DE DESEMPATE exatamente
 * como ele está no fonte (_baseline.js:955-964) sobre os candidatos REAIS do
 * acervo, com as duas versões de `tipoBate`. Se o vencedor nunca muda, o
 * conjunto de pares está intacto.
 *
 * Os candidatos vêm do índice do próprio `_baseline.js` (indiceNF/indiceOCP),
 * reconstruído aqui a partir do MESMO CSV do banco que a rota lê — ou seja, dados
 * de produção, não sintéticos.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function tipoBateDe(src) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const A = tipoBateDe(antesSrc), D = tipoBateDe(depoisSrc);

    // ── candidatos REAIS: o CSV do banco, agrupado por número, como a rota faz ──
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    const separar = (linha) => {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (aspas) {
                if (ch === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
                else atual += ch;
            } else if (ch === '"') aspas = true;
            else if (ch === ';') { out.push(atual); atual = ''; }
            else atual += ch;
        }
        out.push(atual); return out;
    };

    const porNumero = new Map();   // número → [ {arquivo, tipo, valor} ]
    let linhas = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iT = cols.indexOf('tipo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iT < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = separar(ls[i]);
            const arquivo = String(f[iA] || '').trim();
            if (!arquivo) continue;
            linhas++;
            let num = '', valor = 0;
            const bruto = iD >= 0 ? (f[iD] || '').trim() : '';
            if (bruto.startsWith('{')) {
                try {
                    const d = JSON.parse(bruto);
                    for (const k of ['Nº da NF-e', 'Nº do CT-e', 'Nº da NFS-e', 'Número do documento', 'Numero da NF']) {
                        if (d[k] && d[k] !== '—') { num = String(d[k]).replace(/\D/g, ''); break; }
                    }
                    for (const k of ['Valor total da nota', 'Valor total', 'Valor da prestação', 'Valor do boleto']) {
                        if (d[k] && d[k] !== '—') {
                            let s = String(d[k]).replace(/^R\$\s*/i, '').replace(/\s/g, '');
                            if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
                            const n = Number(s); if (isFinite(n) && n > 0) { valor = n; break; }
                        }
                    }
                } catch (e) {}
            }
            if (!num) continue;
            if (!porNumero.has(num)) porNumero.set(num, []);
            porNumero.get(num).push({ arquivo, tipo: String(f[iT] || '').trim(), valor });
        }
    }

    const grupos = [...porNumero.values()].filter(g => g.length >= 2);
    console.log(`linhas do banco: ${linhas}`);
    console.log(`números com 2+ candidatos (onde o desempate existe): ${grupos.length}\n`);

    // ── o bloco de desempate, reproduzido do fonte ──────────────────────────
    // _baseline.js:955-964 → score = (vOk?2:0) + (tOk?1:0), `>` estrito
    const escolher = (cands, nota, tipoBate) => {
        let melhor = null;
        for (const c of cands) {
            const vOk = nota.valor > 0 && c.valor > 0 && Math.abs(c.valor - nota.valor) <= 0.02;
            const tOk = tipoBate(c.tipo, nota, c);
            const score = (vOk ? 2 : 0) + (tOk ? 1 : 0);
            if (!melhor || score > melhor.score) melhor = { c, score };
        }
        return melhor;
    };

    // Para cada grupo, testa TODOS os tipos de planilha possíveis e ambos os
    // valores plausíveis (o de cada candidato) — cobre o espaço de lançamentos
    // que poderia cair nesse número.
    const TIPOS_PLAN = ['NF', 'NFS', 'FATURA', 'IMPOSTO', '*', ''];
    let cenarios = 0, divergiram = 0;
    const exemplos = [];

    for (const g of grupos) {
        const valores = [...new Set(g.map(c => c.valor).filter(v => v > 0))];
        if (!valores.length) valores.push(0);
        for (const tp of TIPOS_PLAN) {
            for (const v of valores) {
                const nota = { tipoBanco: tp, valor: v };
                cenarios++;
                const a = escolher(g, nota, A);
                const d = escolher(g, nota, D);
                if (a.c.arquivo !== d.c.arquivo) {
                    divergiram++;
                    if (exemplos.length < 10) exemplos.push({
                        tp, v,
                        antes: `${a.c.tipo} ${a.c.arquivo.slice(0, 44)}`,
                        depois: `${d.c.tipo} ${d.c.arquivo.slice(0, 44)}`,
                    });
                }
            }
        }
    }

    console.log(`cenários de desempate testados: ${cenarios}`);
    console.log(`cenários em que o VENCEDOR muda: ${divergiram}\n`);
    if (exemplos.length) {
        console.log('exemplos de troca:');
        for (const e of exemplos) {
            console.log(`  planilha=${e.tp || '(vazio)'} valor=${e.v}`);
            console.log(`    antes : ${e.antes}`);
            console.log(`    depois: ${e.depois}`);
        }
    }
    console.log(divergiram === 0
        ? '→ CONFIRMADO empiricamente: o vencedor do desempate NUNCA muda.\n  O conserto age apenas no rótulo do alerta, não no pareamento.'
        : '→ ⚠ o desempate MUDA em algum cenário; investigar antes de manter.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
