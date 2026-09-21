/**
 * _medir/_emitente-efeito-do-conserto.js — o conserto aplicado, contra git HEAD.
 *
 * A v4 foi medida em simulação (`_emitente-conserto-v4.js`: 178 corrigidos, 0
 * regressões) e IMPLEMENTADA em `_nf-parsers.js:extrairEmitente`. Este script
 * confirma no CÓDIGO REAL, comparando com a versão de `git show HEAD:`.
 *
 * Mede também o que a simulação não via: o efeito no PAREAMENTO. O emitente é o
 * campo que `_pareamento.js` usa para casar — limpar 178 nomes pode mover pares.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const LIXO = /^[\d\-.,\/\s]{2,}/;

function extrairDe(src, rotulo) {
    const corte = src.indexOf('module.exports');
    if (corte < 0) throw new Error(`sem module.exports em ${rotulo}`);
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    return new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return extrairEmitente;
    `)(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8');
    const A = extrairDe(antesSrc, 'HEAD'), D = extrairDe(depoisSrc, 'disco');

    const c = h.carregar();
    const todos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) todos.push(a.nome);

    let corr = 0, reg = 0, lixoA = 0, lixoD = 0, vazioVirouNome = 0, nomeVirouVazio = 0;
    const exReg = [], exCorr = [];
    for (const n of todos) {
        const a = A(n), d = D(n);
        const al = a && LIXO.test(a), dl = d && LIXO.test(d);
        if (al) lixoA++;
        if (dl) lixoD++;
        if (a === d) continue;
        if (al && !dl) { corr++; if (exCorr.length < 8) exCorr.push([a, d]); }
        else if (!a && d) vazioVirouNome++;
        else if (a && !d) { nomeVirouVazio++; if (exReg.length < 8) exReg.push([a, d, n]); }
        else if (!al) { reg++; if (exReg.length < 8) exReg.push([a, d, n]); }
    }

    console.log(`arquivos: ${todos.length}\n`);
    console.log(`  emitentes com lixo ANTES:  ${String(lixoA).padStart(4)}  ${pct(lixoA, todos.length)}`);
    console.log(`  emitentes com lixo DEPOIS: ${String(lixoD).padStart(4)}  ${pct(lixoD, todos.length)}`);
    console.log(`\n  CORRIGIDOS:        ${String(corr).padStart(4)}`);
    console.log(`  regressões:        ${String(reg).padStart(4)}`);
    console.log(`  nome → vazio:      ${String(nomeVirouVazio).padStart(4)}  ${nomeVirouVazio ? '(⚠ perda de campo)' : '(ok)'}`);
    console.log(`  vazio → nome:      ${String(vazioVirouNome).padStart(4)}  (ganho)`);

    if (exReg.length) {
        console.log('\n  ⚠ mudanças a conferir:');
        for (const [a, d, n] of exReg) {
            console.log(`     "${a}" → "${d}"`);
            console.log(`        ${String(n).slice(0, 64)}`);
        }
    }
    console.log('\n  amostra dos corrigidos:');
    for (const [a, d] of exCorr)
        console.log(`     "${String(a).slice(0, 34).padEnd(34)}" → "${String(d).slice(0, 30)}"`);

    // ── efeito no PAREAMENTO ────────────────────────────────────────────────
    // O emitente entra nos tokens do documento; limpar 178 nomes pode mover pares.
    console.log(`\n${'═'.repeat(66)}`);
    console.log('EFEITO NO PAREAMENTO');
    console.log('═'.repeat(66));
    const p = require('../routes/_pareamento');
    const { indexar } = require('./ocr');
    const idxOcr = await indexar();
    const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

    let totalAntes = 0, totalDepois = 0;
    console.log('\n  mês       pares (o emitente do NOME entra via documentoDoArquivo)');
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        const n = r.pares.length + r.paresVizinhos.length;
        totalDepois += n;
        console.log(`  ${periodo}   ${String(n).padStart(4)}`);
    }
    console.log(`  TOTAL     ${String(totalDepois).padStart(4)}`);
    console.log('\n  (`_pareamento.js` NÃO chama extrairEmitente — o emitente vem do OCR/banco.');
    console.log('   Este conserto muda o que process-folder GRAVA, então o efeito no');
    console.log('   pareamento só aparece APÓS releitura, como o do GUIA.)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
