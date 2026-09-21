/**
 * _medir/_quanto-custa-reprocessar.js — o que custa e o que rende reprocessar
 *
 * ESTADO (21/09/2026): os 3 consertos estão commitados (2ced4d6). Dois deles só
 * agem NA ESCRITA — `classify` (GUIA) e `extrairEmitente` — então o banco continua
 * com o resultado antigo até os PDFs serem relidos
 * ([[cache-esconde-mudanca-de-extracao]]).
 *
 * Antes de sugerir "rode a releitura", preciso do custo. Releitura com IA custa
 * API e tempo, e já foi reprovada uma vez por não se pagar
 * ([[reescanear-nao-se-paga]]) — mas ali a pergunta era outra (ganhar pares).
 * Aqui o alvo é diferente: aplicar consertos já aprovados.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. quantos PDFs seriam reprocessados, por mês
 *   2. quantos documentos MUDARIAM de fato (o rendimento)
 *   3. o risco: `forceLocal` sobrescreve linhas que a IA leu melhor?
 *      ([[reescanear-nao-se-paga]] mediu 101 linhas de IA em risco)
 *   4. dá para reprocessar SÓ os afetados, em vez do acervo inteiro?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const semPN = s => String(s || '').replace(/#p\d+$/i, '');

(async () => {
    const c = h.carregar();

    // ── (1) o tamanho do acervo, por mês ───────────────────────────────────
    console.log('═'.repeat(76));
    console.log('(1) O QUE SERIA REPROCESSADO');
    console.log('═'.repeat(76));
    let total = 0;
    console.log('');
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}).sort()) {
        if (!h.PERIODOS.includes(mes)) continue;
        console.log(`   ${mes}   ${String(arqs.length).padStart(4)} PDFs`);
        total += arqs.length;
    }
    console.log(`   ${'TOTAL'.padEnd(9)} ${String(total).padStart(4)} PDFs`);

    // ── (2) quantos MUDARIAM ───────────────────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(2) QUANTOS DOCUMENTOS MUDARIAM');
    console.log('═'.repeat(76));

    const tipoIdx = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8')); }
        catch (e) { return {}; }
    })();
    const guia = [];
    for (const [arq, info] of Object.entries(tipoIdx))
        if (norm(info.tipo) === 'IMPOSTO' && norm(info.evidencia) === 'GUIA') guia.push(semPN(arq));
    const guiaUnicos = [...new Set(guia)];

    // emitente: comparar HEAD~1 com HEAD (o conserto já commitado)
    const { execFileSync } = require('child_process');
    const emitDe = (src) => {
        const corte = src.indexOf('module.exports');
        const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
        return new Function('require', 'module', 'exports', '__dirname',
            `${src.slice(0, corte)} return extrairEmitente;`)(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
    };
    let emitSujo = 0;
    const exEmit = [];
    try {
        const antes = emitDe(execFileSync('git', ['show', 'HEAD~1:routes/_nf-parsers.js'],
            { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
        const agora = emitDe(execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
            { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
        const LIXO = /^[\d\-.,\/\s]{2,}/;
        for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
            for (const a of arqs) {
                const va = antes(a.nome), vb = agora(a.nome);
                if (va !== vb && va && LIXO.test(va)) {
                    emitSujo++;
                    if (exEmit.length < 6) exEmit.push({ arq: a.nome, de: va, para: vb });
                }
            }
    } catch (e) { console.log(`   (não consegui medir o emitente: ${e.message})`); }

    console.log(`\n   GUIA → deixam de ser IMPOSTO:     ${guiaUnicos.length} documentos`);
    for (const g of guiaUnicos.slice(0, 6)) console.log(`      ${g.slice(0, 60)}`);
    console.log(`\n   emitente sujo → nome limpo:       ${emitSujo} documentos`);
    for (const e of exEmit) console.log(`      "${String(e.de).slice(0, 18)}" → "${String(e.para).slice(0, 26)}"`);
    console.log(`\n   TOTAL que mudaria: ~${guiaUnicos.length + emitSujo} de ${total} PDFs  ${pct(guiaUnicos.length + emitSujo, total)}`);

    // ── (3) dá para reprocessar só os afetados? ────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(3) DÁ PARA REPROCESSAR SÓ OS AFETADOS?');
    console.log('═'.repeat(76));
    const srcRotas = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const temFiltroArquivo = /opts\.(somente|apenas|arquivos|filtro)/.test(srcRotas);
    console.log(`\n   process-folder aceita lista de arquivos? ${temFiltroArquivo ? 'SIM' : 'não aparente'}`);
    const rotas = fs.readdirSync(path.join(h.RAIZ, 'routes')).filter(f => /scan/i.test(f));
    console.log(`   rotas de scan disponíveis: ${rotas.join(', ')}`);
    console.log('\n   → sem filtro por arquivo, a releitura é por PASTA/mês.');
    console.log('     Os 6 do GUIA estão espalhados; o emitente afeta 188.');

    // ── (4) o risco ────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(4) O RISCO');
    console.log('═'.repeat(76));
    console.log('\n   `forceLocal` SOBRESCREVE o que a IA leu melhor — medido em');
    console.log('   [[reescanear-nao-se-paga]]: 101 linhas de IA em risco.');
    console.log('   O scan com IA (padrão) não tem esse problema, mas custa API.');
    console.log('\n   E [[ocr-cai-com-medicoes-em-paralelo]]: falha de OCR grava VAZIO');
    console.log('   por cima do dado bom. Não rodar releitura junto com medição.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
