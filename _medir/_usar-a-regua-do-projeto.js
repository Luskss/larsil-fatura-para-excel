/**
 * _medir/_usar-a-regua-do-projeto.js — `entidadeBate` faz o que minha régua fez?
 *
 * DESCOBERTA: o motor JÁ TEM a função que eu reimplementei. `_pareamento.js:477`:
 *
 *     const entidadeBate = (l, d) => compartilhaToken(l.tokens, d.tokens);
 *
 * E `casa()` (linha 583-584) já a consulta na via do valor solto — só que para
 * ROTULAR, não para decidir:
 *
 *     if (valorBate(l, d) && dentroDaJanela(...))
 *         return entidadeBate(l, d) ? 'valor+entidade' : 'valor';   ← 'valor' = força 1
 *
 * Ou seja, a variante C (cortar os pares de valor solto cujo fornecedor não bate) é
 * literalmente **não devolver 'valor'** — a informação já está calculada ali.
 *
 * Isso é muito melhor que injetar a minha régua: usa a tokenização do projeto, que
 * já trata acento, ruído e nome fantasia ([[emitente-nao-vem-do-extrator]]).
 *
 * ── O que se confere ────────────────────────────────────────────────────────
 *   1. `entidadeBate` classifica os 147 pares de força 1 como a minha régua?
 *   2. se divergir, em quais casos? (a do projeto é a que vale)
 *   3. o A/B com a régua do projeto dá o mesmo ganho?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// minha régua, para comparar
const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|REC|VIA|COPIA|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A|EM|NA|NO)$/;
function meusTokens(txt, ehArquivo) {
    let t = norm(txt);
    if (ehArquivo) t = t.replace(/\.PDF$/i, '').replace(/\d{1,4}\.DOC-?/i, ' ')
                        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ');
    return t.replace(/[\d.,\/+#;&-]+/g, ' ').split(/\s+/)
            .filter(x => x.length >= 3 && !RUIDO.test(x));
}
function minhaRegua(entLanc, arq, emit) {
    const alvo = meusTokens(entLanc, false);
    const doDoc = [...new Set([...meusTokens(arq, true), ...meusTokens(emit, false)])];
    if (!alvo.length || !doDoc.length) return 'indecidivel';
    for (const a of alvo) for (const t of doDoc) {
        if (a === t) return 'bate';
        const n = Math.min(a.length, t.length, 5);
        if (n >= 4 && a.slice(0, n) === t.slice(0, n)) return 'bate';
    }
    return 'nao';
}

(async () => {
    console.log(`entidadeBate exportada? ${typeof p.entidadeBate === 'function' ? 'SIM' : 'NÃO ⚠'}`);
    console.log(`casa exportada?         ${typeof p.casa === 'function' ? 'SIM' : 'NÃO ⚠'}\n`);

    const c = h.carregar();
    const idx = await indexar();

    const f1 = [];
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
            if (x.forca !== 1) continue;
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            f1.push({
                periodo, arq: x.documento.arquivo, via: x.via,
                ent: String(x.lancamento.entidade || ''), emit: String(o.emitente || ''),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                doProjeto: p.entidadeBate(x.lancamento, x.documento),
                minha: minhaRegua(x.lancamento.entidade, x.documento.arquivo, o.emitente),
            });
        }
    }

    console.log('═'.repeat(78));
    console.log(`(1) AS DUAS RÉGUAS NOS ${f1.length} PARES DE FORÇA 1`);
    console.log('═'.repeat(78));
    const doProjetoBate = f1.filter(x => x.doProjeto).length;
    console.log(`\n   entidadeBate (do projeto) diz que BATE: ${doProjetoBate}`);
    console.log(`   minha régua diz 'bate':                 ${f1.filter(x => x.minha === 'bate').length}`);
    console.log(`   minha régua diz 'indecidível':          ${f1.filter(x => x.minha === 'indecidivel').length}`);

    console.log('\n   → por definição, força 1 = só UM sinal bate. Se o valor bate,');
    console.log('     entidadeBate tem de ser FALSO em todos. Confirmando:');
    console.log(`     entidadeBate verdadeiro em força 1: ${doProjetoBate}  ${doProjetoBate === 0 ? '✓ como esperado' : '⚠ inesperado'}`);

    // ── a via, que é o que interessa ───────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) POR QUAL VIA ESSES PARES SE FORMARAM?');
    console.log('═'.repeat(78));
    const porVia = new Map();
    for (const x of f1) porVia.set(x.via || '(?)', (porVia.get(x.via || '(?)') || 0) + 1);
    console.log('');
    for (const [v, n] of [...porVia].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(v).padEnd(24)} ${String(n).padStart(4)}  ${pct(n, f1.length)}`);
    console.log('\n   → a via "valor" é exatamente o que `casa()` devolve quando o');
    console.log('     valor bate e a entidade NÃO. Cortar a força 1 incompatível =');
    console.log('     não devolver essa via.');

    // ── os 4-5 legítimos: por que são força 1 se o nome bate? ──────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) OS LEGÍTIMOS: por que a régua do projeto não os reconhece?');
    console.log('═'.repeat(78));
    const legitimos = f1.filter(x => x.minha === 'bate' || x.minha === 'indecidivel');
    for (const x of legitimos.sort((a, b) => b.valor - a.valor)) {
        console.log(`\n   ${x.periodo}  ${brl(x.valor)}   via=${x.via}`);
        console.log(`      lanç: ${x.ent.slice(0, 46)}`);
        console.log(`      doc:  ${x.arq.slice(0, 52)}`);
        console.log(`      entidadeBate do projeto: ${x.doProjeto}   minha régua: ${x.minha}`);
    }
    console.log('\n   → se `entidadeBate` fosse verdadeira neles, eles teriam força 2.');
    console.log('     São força 1 porque a tokenização do projeto NÃO liga os nomes.');
    console.log('     Cortá-los é o preço; medido em _forca1-veredito.js: 4-5 pares.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
