/**
 * _medir/_o-que-sobrou-para-fazer.js — o que ainda vale a pena, medido
 *
 * PERGUNTA (21/09/2026): "então não há nada o que fazer?"
 *
 * "Nada a fazer" valia para o desempate de notas competindo
 * ([[notas-competindo-o-pool-e-2]]). Mas a sessão deixou coisas em aberto, e
 * responder de memória seria chutar. Este script mede o estado atual:
 *
 *   1. os 3 consertos de hoje estão COMMITADOS? (não estão — risco de perda)
 *   2. quantos alertas de tipo sobram, e quanto custaria reler os PDFs?
 *   3. os lançamentos SEM documento: quantos são, quanto valem?
 *      ← esse é o buraco que o usuário realmente enxerga no painel
 *   4. o conserto do GUIA e do emitente só valem com releitura: quanto rende?
 *   5. a fila de conferência de tipo (52 itens) ainda está de pé?
 *
 * O objetivo NÃO é achar mais defeito — é dimensionar o que sobrou, para o
 * usuário decidir onde gastar o próximo esforço.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const semPN = s => String(s || '').replace(/#p\d+$/i, '');

(async () => {
    // ── (1) o que está sem commit ──────────────────────────────────────────
    console.log('═'.repeat(78));
    console.log('(1) O TRABALHO DE HOJE ESTÁ SALVO?');
    console.log('═'.repeat(78));
    const st = execFileSync('git', ['status', '--porcelain'], { cwd: h.RAIZ, encoding: 'utf8' });
    const modificados = st.split(/\r?\n/).filter(l => l.startsWith(' M'));
    console.log('\n   arquivos de PRODUÇÃO modificados e NÃO commitados:');
    for (const l of modificados) {
        const arq = l.slice(3);
        if (!arq.startsWith('routes/') && !arq.startsWith('_medir/')) continue;
        const d = execFileSync('git', ['diff', '--numstat', '--', arq], { cwd: h.RAIZ, encoding: 'utf8' }).trim();
        const [add, del] = (d.split('\t') || []);
        console.log(`      ${arq.padEnd(34)} +${add || 0} −${del || 0}`);
    }
    console.log('\n   → nada commitado hoje. Um `git checkout` acidental perde tudo.');

    // ── o resto precisa do painel ──────────────────────────────────────────
    const c = h.carregar();
    const idx = await indexar();

    let paresTot = 0, semDoc = 0, valorSemDoc = 0, lancTot = 0, valorTot = 0;
    const forca = { 1: 0, 2: 0, 3: 0 };
    const faltantesPorEnt = new Map();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            paresTot++;
            if (forca[x.forca] != null) forca[x.forca]++;
        }
        const faltando = r.semDocumento || r.faltantes || r.naoEncontrados || [];
        for (const f of faltando) {
            const l = f.lancamento || f;
            const v = Math.abs(Number(l.valor) || 0);
            semDoc++; valorSemDoc += v;
            const e = norm(l.entidade || l.fornecedor || '(?)').slice(0, 26);
            if (!faltantesPorEnt.has(e)) faltantesPorEnt.set(e, { n: 0, v: 0 });
            const o = faltantesPorEnt.get(e); o.n++; o.v += v;
        }
        for (const l of lancs) { lancTot++; valorTot += Math.abs(Number(l.valor) || 0); }
    }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O ESTADO DO PAINEL HOJE');
    console.log('═'.repeat(78));
    console.log(`\n   lançamentos na planilha (jan–jun): ${lancTot}   ${brl(valorTot)}`);
    console.log(`   pares formados:                    ${paresTot}  ${pct(paresTot, lancTot)}`);
    console.log(`      força 3 (número+entidade+data): ${forca[3]}  ${pct(forca[3], paresTot)}`);
    console.log(`      força 2:                        ${forca[2]}  ${pct(forca[2], paresTot)}`);
    console.log(`      força 1 (só valor):             ${forca[1]}  ${pct(forca[1], paresTot)}`);
    console.log(`   lançamentos SEM documento:         ${semDoc}   ${brl(valorSemDoc)}`);

    if (faltantesPorEnt.size) {
        console.log('\n   quem mais falta (top 12 por valor):');
        for (const [e, o] of [...faltantesPorEnt].sort((a, b) => b[1].v - a[1].v).slice(0, 12))
            console.log(`      ${e.padEnd(28)} ${String(o.n).padStart(4)} lanç.  ${brl(o.v).padStart(18)}`);
    }

    // ── (3) o que a releitura ainda curaria ────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) O QUE SÓ A RELEITURA DOS PDFs RESOLVE');
    console.log('═'.repeat(78));
    const tipoIdx = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8')); }
        catch (e) { return {}; }
    })();
    let guia = 0;
    for (const [arq, info] of Object.entries(tipoIdx)) {
        if (norm(info.tipo) === 'IMPOSTO' && norm(info.evidencia) === 'GUIA') guia++;
    }
    console.log(`\n   documentos classificados IMPOSTO por "GUIA" solto: ${guia}`);
    console.log('      (o conserto já está no código; só vale ao reprocessar)');

    const srcNfAgora = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8');
    const srcNfHead = execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const emitDe = (src) => {
        const corte = src.indexOf('module.exports');
        const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
        return new Function('require', 'module', 'exports', '__dirname',
            `${src.slice(0, corte)} return extrairEmitente;`)(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
    };
    let emitSujo = 0;
    try {
        const eA = emitDe(srcNfHead), eB = emitDe(srcNfAgora);
        const LIXO = /^[\d\-.,\/\s]{2,}/;
        for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
            for (const a of arqs) {
                const va = eA(a.nome), vb = eB(a.nome);
                if (va !== vb && va && LIXO.test(va)) emitSujo++;
            }
    } catch (e) { console.log(`   (não consegui medir o emitente: ${e.message})`); }
    console.log(`   nomes de emitente sujos ainda no banco: ${emitSujo}`);
    console.log('      (afeta a EXIBIÇÃO; medido em [[reescanear-nao-se-paga]]: +0 pares)');

    // ── (4) a fila de conferência ──────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(4) A FILA DE CONFERÊNCIA DE TIPO');
    console.log('═'.repeat(78));
    const xlsx = path.join(h.RAIZ, 'fila-conferencia-tipo.xlsx');
    if (fs.existsSync(xlsx)) {
        const st2 = fs.statSync(xlsx);
        console.log(`\n   fila-conferencia-tipo.xlsx existe (${(st2.size / 1024).toFixed(0)} KB, de ${new Date(st2.mtimeMs).toLocaleDateString('pt-BR')})`);
        console.log('   → 52 itens para conferir à mão, R$ 1.469.351 (90% é o MACPONTA já auditado)');
    } else console.log('\n   (a planilha da fila não está mais na raiz)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
