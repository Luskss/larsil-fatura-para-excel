/**
 * _medir/_vale-reescanear.js — reescanear muda alguma coisa que o usuário veja?
 *
 * PERGUNTA (21/09/2026): dois consertos aplicados hoje só agem no PROCESSAMENTO —
 * o `\bGUIA\b` do classify ([[guia-solto-classificava-imposto]]) e a data em
 * `extrairEmitente` ([[emitente-sujo-por-centavos-e-hifen]]). O banco guarda o
 * resultado já decidido, então nada mudou ainda.
 *
 * Antes de mandar reescanear 4.541 PDFs, medir o TETO
 * ([[dimensionar-o-pool-antes-de-medir]]): quanto isso move o que o usuário vê?
 *
 * ── O risco que quase me escapou ────────────────────────────────────────────
 * `forceLocal` roda os PARSERS LOCAIS. Mas 87,6% dos documentos têm origem `IA`, e
 * [[ia-vence-o-parser-local-no-valor]] mediu a IA ganhando 121×9 no valor. Se a
 * releitura local sobrescrever linha de IA com extração pior, o conserto de 178
 * emitentes vem acompanhado de regressão em outros campos.
 *
 * O comentário de `precisaReler` (process-folder.js:1332) diz que **forceLocal relê
 * TUDO, inclusive o que já é IA**. Então a pergunta não é só "quanto ganha" — é
 * "o que perde junto".
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. GUIA: quantos documentos mudam de tipo (o pool já medido: 6)
 *   2. EMITENTE: quantos dos 178 corrigidos estão em documentos QUE PAREIAM hoje
 *      (corrigir o emitente de um documento que ninguém usa não muda nada)
 *   3. RISCO: quantos desses documentos têm origem IA e seriam relidos localmente
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
const base = s => String(s || '').replace(/#p\d+$/i, '');

function extrairDe(src) {
    const corte = src.indexOf('module.exports');
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    return new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return { extrairEmitente, classify };
    `)(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8');
    const A = extrairDe(antesSrc), D = extrairDe(depoisSrc);

    const c = h.carregar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    // ── quais arquivos o conserto do emitente muda? ────────────────────────
    const mudam = new Set();
    const todos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            todos.push(a.nome);
            const va = A.extrairEmitente(a.nome), vd = D.extrairEmitente(a.nome);
            if (va !== vd && va && LIXO.test(va)) mudam.add(a.nome);
        }
    console.log(`arquivos no acervo: ${todos.length}`);
    console.log(`emitente muda em:   ${mudam.size}\n`);

    // ── desses, quantos PAREIAM hoje? ──────────────────────────────────────
    const p = require('../routes/_pareamento');
    const { indexar } = require('./ocr');
    const idxOcr = await indexar();
    const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

    const pareados = new Set();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) pareados.add(x.documento.arquivo);
    }

    const mudamEPareiam = [...mudam].filter(n => pareados.has(n));
    const mudamENao = [...mudam].filter(n => !pareados.has(n));
    console.log('── EMITENTE: os 178, cruzados com o pareamento ──────────────');
    console.log(`  já PAREIAM hoje (emitente sujo não impediu): ${mudamEPareiam.length}`);
    console.log(`  NÃO pareiam hoje (candidatos a ganho):       ${mudamENao.length}`);
    console.log('\n  amostra dos que NÃO pareiam (onde o ganho poderia estar):');
    for (const n of mudamENao.slice(0, 10))
        console.log(`    "${String(A.extrairEmitente(n)).slice(0, 28).padEnd(28)}" → "${String(D.extrairEmitente(n)).slice(0, 24)}"  ${n.slice(0, 34)}`);

    // ── RISCO: quantos dos que mudam têm origem IA? ────────────────────────
    let comIA = 0, comLocal = 0, semRegistro = 0;
    for (const n of mudam) {
        const info = idx[base(n)] || idx[n];
        if (!info) { semRegistro++; continue; }
        if (/IA/i.test(String(info.origem || ''))) comIA++;
        else comLocal++;
    }
    console.log('\n── RISCO da releitura LOCAL sobre linha de IA ───────────────');
    console.log(`  dos ${mudam.size} que mudam de emitente:`);
    console.log(`    origem IA   (forceLocal SOBRESCREVE com parser local): ${comIA}`);
    console.log(`    origem local (releitura é equivalente):                ${comLocal}`);
    console.log(`    sem registro no banco:                                 ${semRegistro}`);

    // ── GUIA: o pool ───────────────────────────────────────────────────────
    const impostoGuia = Object.entries(idx).filter(([, i]) =>
        i.tipo === 'IMPOSTO' && /^GUIA$/i.test(String(i.evidencia || '').trim()));
    const guiaPareia = impostoGuia.filter(([a]) => pareados.has(a) || pareados.has(base(a)));
    console.log('\n── GUIA: o pool ─────────────────────────────────────────────');
    console.log(`  documentos IMPOSTO por "GUIA" solto: ${impostoGuia.length}`);
    console.log(`  desses, que PAREIAM hoje:            ${guiaPareia.length}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('O QUE O REESCANEAMENTO ENTREGA');
    console.log('═'.repeat(68));
    console.log(`\n  • ${guiaPareia.length} alertas de tipo somem do painel (os LOCALIZA)`);
    console.log(`  • ${mudamEPareiam.length} documentos ficam com o emitente limpo NA TELA`);
    console.log(`  • ${mudamENao.length} documentos podem GANHAR par (teto, não garantia)`);
    console.log(`\n  RISCO: ${comIA} documentos de origem IA seriam relidos por PARSER LOCAL.`);
    if (comIA > 0) {
        console.log('  [[ia-vence-o-parser-local-no-valor]] mediu a IA ganhando 121×9 no valor —');
        console.log('  então forceLocal nesses pode TROCAR extração boa por pior.');
        console.log('\n  → o escopo seguro é reescanear só o MÊS/pasta dos afetados, ou usar');
        console.log('    forceAI (que preserva linha de IA) em vez de forceLocal.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
