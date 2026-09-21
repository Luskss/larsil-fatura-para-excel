/**
 * _medir/_forca1-regua-corrigida.js — a régua tinha furo; remedir
 *
 * FURO ENCONTRADO (21/09/2026): `tokensNome` exigia token com ≥4 letras, mas os
 * fornecedores do acervo incluem siglas curtas — BRV, TMJ, TIM, GM & S. Nesses
 * arquivos a lista de tokens vem VAZIA e a função devolvia `true` por "falta de
 * base", classificando como COMPATÍVEL o que ela não conseguiu avaliar.
 *
 *     "JOEL SPELINO"  ×  "...BRV ;NF 177+ BOL.pdf"  → tokens []  → "compatível"
 *
 * Era [[regua-frouxa-inventa-confirmacao]] de novo: um teste que não reprova nada
 * quando não tem dados não é teste — e aqui ele inflava o lado BOM, escondendo
 * falsos entre os "14 preservados".
 *
 * ── O conserto ──────────────────────────────────────────────────────────────
 *   • aceitar token de 3 letras (pega BRV, TMJ, TIM)
 *   • separar explicitamente três estados, em vez de dois:
 *       BATE          — o fornecedor aparece no documento
 *       NÃO BATE      — há tokens dos dois lados e nenhum casa
 *       INDECIDÍVEL   — um dos lados não tem token utilizável
 *
 * O terceiro estado é o que faltava. Uma regra de produção não pode tratar
 * "indecidível" como "bate" — nem como "não bate", que cortaria par bom.
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
const soDig = s => String(s || '').replace(/\D/g, '');

// RUIDO agora inclui as siglas de documento de 3 letras, senão "NFS"/"RCB" viram
// nome de fornecedor quando baixamos o piso para 3.
const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|REC|VIA|COPIA|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A|DAS|EM|NA|NO)$/;
const PISO = 3;

function tokens(txt, ehArquivo) {
    let t = norm(txt);
    if (ehArquivo) {
        t = t.replace(/\.PDF$/i, '')
             .replace(/\d{1,4}\.DOC-?/i, ' ')
             .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ');
    }
    return t.replace(/[\d.,\/+#;&-]+/g, ' ')
            .split(/\s+/)
            .filter(x => x.length >= PISO && !RUIDO.test(x));
}

// devolve 'bate' | 'nao' | 'indecidivel'
function avaliar(entLanc, arq, emitenteDoc) {
    const alvo = tokens(entLanc, false);
    const doArq = tokens(arq, true);
    const doEmit = tokens(emitenteDoc, false);
    const doDoc = [...new Set([...doArq, ...doEmit])];
    if (!alvo.length || !doDoc.length) return 'indecidivel';
    for (const a of alvo) for (const t of doDoc) {
        if (a === t) return 'bate';
        const n = Math.min(a.length, t.length, 5);
        if (n >= 4 && a.slice(0, n) === t.slice(0, n)) return 'bate';
    }
    return 'nao';
}

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    const pares = [];
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
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            pares.push({
                periodo, arq: x.documento.arquivo, forca: x.forca,
                ent: String(x.lancamento.entidade || ''), emit: String(o.emitente || ''),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                estado: avaliar(x.lancamento.entidade, x.documento.arquivo, o.emitente),
            });
        }
    }

    console.log('═'.repeat(78));
    console.log('A RÉGUA CORRIGIDA (piso 3 letras + estado "indecidível")');
    console.log('═'.repeat(78));
    console.log('\nforça    pares    bate    NÃO bate   indecidível');
    for (const f of [3, 2, 1]) {
        const g = pares.filter(x => x.forca === f);
        const b = g.filter(x => x.estado === 'bate').length;
        const n = g.filter(x => x.estado === 'nao').length;
        const i = g.filter(x => x.estado === 'indecidivel').length;
        console.log(`  ${f}    ${String(g.length).padStart(6)}  ${String(b).padStart(6)}  ${String(n).padStart(10)}  ${String(i).padStart(12)}`);
    }

    const f1 = pares.filter(x => x.forca === 1);
    const f1nao = f1.filter(x => x.estado === 'nao');
    const f1bate = f1.filter(x => x.estado === 'bate');
    const f1ind = f1.filter(x => x.estado === 'indecidivel');
    console.log(`\n── a força 1 em detalhe ────────────────────────────────────`);
    console.log(`   NÃO bate (falso):   ${String(f1nao.length).padStart(4)}   ${brl(f1nao.reduce((s, x) => s + x.valor, 0))}`);
    console.log(`   bate (preservar):   ${String(f1bate.length).padStart(4)}   ${brl(f1bate.reduce((s, x) => s + x.valor, 0))}`);
    console.log(`   indecidível:        ${String(f1ind.length).padStart(4)}   ${brl(f1ind.reduce((s, x) => s + x.valor, 0))}`);

    console.log('\n── os que BATEM (força 1 legítima) ─────────────────────────');
    for (const x of f1bate.sort((a, b) => b.valor - a.valor)) {
        console.log(`\n   ${x.periodo} ${brl(x.valor).padStart(13)}`);
        console.log(`      lanç: ${x.ent.slice(0, 46)}`);
        console.log(`      doc:  ${x.arq.slice(0, 52)}`);
    }

    console.log('\n── os INDECIDÍVEIS (a régua não consegue julgar) ───────────');
    for (const x of f1ind.sort((a, b) => b.valor - a.valor).slice(0, 12)) {
        console.log(`\n   ${x.periodo} ${brl(x.valor).padStart(13)}`);
        console.log(`      lanç: ${x.ent.slice(0, 46)}`);
        console.log(`      doc:  ${x.arq.slice(0, 52)}   emitente="${x.emit.slice(0, 20)}"`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
