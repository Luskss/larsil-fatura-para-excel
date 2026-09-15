/**
 * _medir/_data-quarto-sinal.js — usar a emissão como 4º sinal PERDE par?
 *
 * `_data-como-sinal.js` mostrou que a emissão discrimina: bate em 70,7% dos pares de
 * força 3 e em 3,3% dos de força 1 (razão de 20×). Dois usos foram propostos:
 *
 *   USO 2  marcar como suspeito o par fraco com emissão divergente  → não mexe no
 *          motor, não perde par; o risco é rotular par CERTO como suspeito
 *   USO 1  somar a emissão em `forcaDoPar`                          → muda a ORDENAÇÃO
 *          do `parear`, e documento que vence desempate diferente = par trocado
 *
 * Este script mede o USO 1, que é o que pode perder, e afere o USO 2 de quebra.
 *
 * ── Por que a inspeção dos deltas é obrigatória ─────────────────────────────
 * Hoje (15/09/2026) a passada única mediu +7 pares e 2º campo +1,35pp, e ao abrir os
 * ganhos 4 dos 6 eram fornecedor errado ([[media-agregada-esconde-par-falso]]). A
 * tabela agregada aprova o que a inspeção reprova. Aqui o script IMPRIME cada par
 * trocado, com as duas datas, para o veredito não sair de uma média.
 *
 * ── Variantes ───────────────────────────────────────────────────────────────
 *   A produção          forcaDoPar = valor + numero + entidade          (baseline)
 *   B emissão soma      + 1 quando as duas emissões existem e batem
 *   C emissão desempata força igual, mas emissão que bate vence o desempate
 *
 * C é mais conservador que B: não altera a força (logo não reordena classes
 * inteiras), só decide entre candidatos que já empataram.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const DIA_MS = 86400000;
const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const dia = t => t == null ? '—' : new Date(t).toISOString().slice(0, 10);

// Reimplementa `parear` com a força e o desempate parametrizáveis. Usa os MESMOS
// predicados do módulo real — não é uma reescrita da regra, só da ordenação.
function parearVariante(lancs, docs, emissaoDoc, modo, dispensa) {
    const cands = [];
    for (let i = 0; i < lancs.length; i++) {
        for (let j = 0; j < docs.length; j++) {
            const via = p.casa(lancs[i], docs[j], dispensa);
            if (!via) continue;
            const l = lancs[i], d = docs[j];
            const base = (p.valorBate(l, d) ? 1 : 0) + (p.numeroBate(l, d) ? 1 : 0)
                       + (p.entidadeBate(l, d) ? 1 : 0);
            const eL = l.dtEmissao, eD = emissaoDoc.get(d.arquivo);
            const temAmbas = eL != null && eD != null;
            const bate = temAmbas && Math.abs(eL - eD) / DIA_MS < 1;
            const forca = modo === 'B' && bate ? base + 1 : base;
            cands.push({ i, j, via, forca, base, bate, temAmbas });
        }
    }
    cands.sort((a, b) => {
        if (b.forca !== a.forca) return b.forca - a.forca;
        // C: entre candidatos de força igual, o de emissão coincidente vem primeiro.
        if (modo === 'C' && a.bate !== b.bate) return a.bate ? -1 : 1;
        const da = p.distanciaDias(lancs[a.i], docs[a.j]);
        const db = p.distanciaDias(lancs[b.i], docs[b.j]);
        const na = da == null ? Infinity : da, nb = db == null ? Infinity : db;
        if (na !== nb) return na - nb;
        const la = lancs[a.i], lb = lancs[b.i];
        if (la !== lb) {
            const ka = `${la.nf}|${la.entidade}`, kb = `${lb.nf}|${lb.entidade}`;
            if (ka !== kb) return ka < kb ? -1 : 1;
        }
        const fa = docs[a.j].arquivo, fb = docs[b.j].arquivo;
        return fa === fb ? 0 : (fa < fb ? -1 : 1);
    });
    const lu = new Array(lancs.length).fill(false);
    const du = new Array(docs.length).fill(false);
    const pares = [];
    for (const c of cands) {
        if (lu[c.i] || du[c.j]) continue;
        lu[c.i] = true; du[c.j] = true;
        pares.push({ lancamento: lancs[c.i], documento: docs[c.j], via: c.via,
                     forca: c.base, bate: c.bate, temAmbas: c.temAmbas });
    }
    return pares;
}

function conferir(lancs, docsPorMes, periodo, emissaoDoc, modo) {
    const doMes = docsPorMes[periodo] || [];
    const noMes = parearVariante(lancs, doMes, emissaoDoc, modo, false);
    const casados = new Set(noMes.map(x => x.lancamento));
    const pend = lancs.filter(l => !casados.has(l));
    const viz = [];
    for (const off of p.VIZINHANCA) {
        const alvo = p.deslocarPeriodo(periodo, off);
        for (const d of (docsPorMes[alvo] || [])) viz.push({ ...d, periodoDocumento: alvo });
    }
    const emViz = parearVariante(pend, viz, emissaoDoc, modo, true);
    return [...noMes, ...emViz];
}

(async () => {
    const c = h.carregar();
    console.error('[4o-sinal] reindexando...');
    const idx = await indexar();
    const emissaoDoc = new Map();
    for (const [nome, o] of Object.entries(idx))
        if (o && o.dtEmissao != null) emissaoDoc.set(nome, o.dtEmissao);

    const chave = x => `${x.lancamento.entidade}|${x.lancamento.nf}|${x.lancamento.valor}`;
    const res = {};
    for (const modo of ['A', 'B', 'C']) {
        const todos = [];
        let lancTotal = 0;
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
            lancTotal += lancs.length;
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            todos.push(...conferir(lancs, docsPorMes, periodo, emissaoDoc, modo));
        }
        res[modo] = { pares: todos, lancTotal,
            porChave: new Map(todos.map(x => [chave(x), x])),
            fortes: todos.filter(x => x.forca >= 2).length,
            fracos: todos.filter(x => x.forca === 1).length };
    }

    console.log('═'.repeat(72));
    console.log('A EMISSÃO COMO 4º SINAL — perde par?');
    console.log('═'.repeat(72));
    console.log('variante                              pares  fortes  fracos   2ºcampo');
    for (const [m, nome] of [['A', 'A produção'], ['B', 'B emissão soma força'], ['C', 'C emissão desempata']]) {
        const r = res[m];
        console.log(`${nome.padEnd(36)} ${String(r.pares.length).padStart(6)} ${String(r.fortes).padStart(7)}` +
            ` ${String(r.fracos).padStart(7)}   ${pct(r.fortes, r.pares.length).padStart(7)}`);
    }

    // ── o que interessa: os DELTAS, par a par
    for (const m of ['B', 'C']) {
        const A = res.A.porChave, X = res[m].porChave;
        const novos = [...X.keys()].filter(k => !A.has(k));
        const perdidos = [...A.keys()].filter(k => !X.has(k));
        // par TROCADO: mesmo lançamento, documento diferente
        const trocados = [...X.keys()].filter(k => A.has(k)
            && A.get(k).documento.arquivo !== X.get(k).documento.arquivo);

        console.log('\n' + '─'.repeat(72));
        console.log(`VARIANTE ${m}:  +${novos.length} novos   -${perdidos.length} perdidos   ~${trocados.length} trocados`);

        for (const k of perdidos.slice(0, 10)) {
            const a = A.get(k);
            console.log(`   PERDEU  ${k.slice(0, 44)}`);
            console.log(`           era ${String(a.documento.arquivo).slice(0, 52)} (força ${a.forca})`);
        }
        for (const k of trocados.slice(0, 12)) {
            const a = A.get(k), x = X.get(k);
            const eL = a.lancamento.dtEmissao;
            console.log(`   TROCOU  ${k.slice(0, 44)}   emissão lanç=${dia(eL)}`);
            console.log(`           de  ${String(a.documento.arquivo).slice(0, 50)}  emis=${dia(emissaoDoc.get(a.documento.arquivo))} ${a.bate ? '✓' : '✗'} força ${a.forca}`);
            console.log(`           por ${String(x.documento.arquivo).slice(0, 50)}  emis=${dia(emissaoDoc.get(x.documento.arquivo))} ${x.bate ? '✓' : '✗'} força ${x.forca}`);
        }
        for (const k of novos.slice(0, 8)) {
            const x = X.get(k);
            console.log(`   NOVO    ${k.slice(0, 44)}  força ${x.forca} via ${x.via}`);
        }
    }

    // ── USO 2: quantos fracos a emissão marcaria, e quantos deles são bons?
    const fracosA = res.A.pares.filter(x => x.forca === 1);
    const comAmbas = fracosA.filter(x => x.temAmbas);
    const divergem = comAmbas.filter(x => !x.bate);
    console.log('\n' + '═'.repeat(72));
    console.log('USO 2 — marcar fraco com emissão divergente (não mexe no motor)');
    console.log(`   pares fracos (força 1):            ${fracosA.length}`);
    console.log(`   com as duas emissões:              ${comAmbas.length}`);
    console.log(`   emissão DIVERGE → marcar suspeito: ${divergem.length}`);
    console.log(`   emissão bate → deixar em paz:      ${comAmbas.length - divergem.length}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
