/**
 * _medir/_gemeos-o-mes-nao-e-o-criterio.js — "mês do lançamento" é régua errada
 *
 * MEDIDO (`_gemeos-o-motor-ja-acerta.js`): dos 94 pares envolvendo documentos
 * gêmeos, 68 "escolheram outro mês" — mas em **0** deles existia o gêmeo do mês do
 * lançamento. O motor escolheu o único documento disponível.
 *
 * Ou seja, minha régua ("o documento certo é o do mês do lançamento") está errada:
 * um lançamento de 01.2026 é pago com documento de 02.2026 o tempo todo, e isso é
 * normal — é a vizinhança, que o projeto tem de propósito
 * ([[vizinhanca-mistura-meses]], [[veto-de-janela-so-no-mes]]).
 *
 * Seria o terceiro erro de régua desta sessão ([[rcb-no-nome-e-numero-nao-tipo]],
 * [[nf-para-cte-nao-e-defeito]]) se eu reportasse "72,3% erram".
 *
 * ── A pergunta REAL ─────────────────────────────────────────────────────────
 * Competição só existe quando DOIS gêmeos estão disponíveis para o MESMO
 * lançamento e o motor escolhe um. Então:
 *
 *   1. em quantos pares havia REALMENTE mais de um gêmeo candidato?
 *      (mesmo grupo, ambos na janela de busca do período)
 *   2. quando há disputa, dois lançamentos diferentes recebem documentos
 *      diferentes do mesmo grupo — ou o mesmo documento é usado 2×?
 *   3. um documento é usado por MAIS DE UM lançamento? ← isso sim é defeito
 *
 * O item 3 é o teste que importa: se cada arquivo é consumido uma vez só, não há
 * competição — há distribuição correta.
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

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    const docs = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]);
            const o = idx[a.nome] || {};
            docs.push({ mes, arq: a.nome, numero: String(d.numero || o.numero || ''),
                        ent: norm(d.emitente || o.emitente || ''),
                        valor: Math.abs(Number(d.valor || o.valor) || 0) });
        }
    const porChave = new Map();
    for (const d of docs) {
        if (!d.numero || !d.ent) continue;
        const k = `${d.ent}|${d.numero}`;
        if (!porChave.has(k)) porChave.set(k, []);
        porChave.get(k).push(d);
    }
    const gemeos = new Map();
    for (const [k, g] of porChave) {
        if (g.length < 2) continue;
        const vs = [...new Set(g.map(x => x.valor).filter(Boolean).map(v => v.toFixed(2)))];
        if (vs.length === 1) gemeos.set(k, g);
    }
    const chaveDoArquivo = new Map();
    for (const [k, g] of gemeos) for (const d of g) chaveDoArquivo.set(d.arq, k);

    // ── rodar o painel guardando o uso de cada documento ───────────────────
    const usosPorArquivo = new Map();     // arquivo → [{periodo, vLanc, forca}]
    const paresDoGrupo = new Map();       // chave → [{periodo, arq, vLanc}]
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        const candidatosNaJanela = new Set();
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            const lista = (c.pasta.arquivosPorMes[alvo] || []);
            for (const a of lista) candidatosNaJanela.add(a.nome);
            docsPorMes[alvo] = lista.map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const arq = x.documento.arquivo;
            const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
            if (!usosPorArquivo.has(arq)) usosPorArquivo.set(arq, []);
            usosPorArquivo.get(arq).push({ periodo, vLanc, forca: x.forca });
            const k = chaveDoArquivo.get(arq);
            if (k) {
                if (!paresDoGrupo.has(k)) paresDoGrupo.set(k, []);
                // quantos gêmeos do grupo estavam na janela deste período?
                const g = gemeos.get(k) || [];
                const disponiveis = g.filter(d => candidatosNaJanela.has(d.arq));
                paresDoGrupo.get(k).push({ periodo, arq, vLanc, nDisponiveis: disponiveis.length });
            }
        }
    }

    console.log('═'.repeat(78));
    console.log('(1) HAVIA DISPUTA DE VERDADE?');
    console.log('═'.repeat(78));
    let comDisputa = 0, semDisputa = 0;
    for (const [, lista] of paresDoGrupo)
        for (const u of lista) { if (u.nDisponiveis > 1) comDisputa++; else semDisputa++; }
    console.log(`\n   pares de gêmeos onde havia MAIS DE UM candidato na janela: ${comDisputa}`);
    console.log(`   pares onde só havia UM candidato:                          ${semDisputa}`);
    console.log('\n   → onde só há um candidato não existe escolha, logo não há');
    console.log('     nada a desempatar.');

    // ── (2) o MESMO documento serve a dois lançamentos? ───────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) UM DOCUMENTO É USADO POR MAIS DE UM LANÇAMENTO?');
    console.log('═'.repeat(78));
    const reusados = [...usosPorArquivo].filter(([, u]) => u.length > 1);
    console.log(`\n   documentos usados em mais de um par: ${reusados.length}  de ${usosPorArquivo.size}`);
    const reusadosGemeos = reusados.filter(([a]) => chaveDoArquivo.has(a));
    console.log(`   desses, que são gêmeos: ${reusadosGemeos.length}`);
    for (const [a, u] of reusados.slice(0, 10)) {
        console.log(`\n   ${a.slice(0, 62)}`);
        for (const x of u) console.log(`      ${x.periodo}  ${brl(x.vLanc)}  força ${x.forca}`);
        const k = chaveDoArquivo.get(a);
        if (k) {
            const g = gemeos.get(k) || [];
            const naoUsados = g.filter(d => !usosPorArquivo.has(d.arq));
            console.log(`      grupo tem ${g.length} gêmeos; NÃO usados: ${naoUsados.length}`);
            for (const n of naoUsados.slice(0, 3)) console.log(`         ocioso: [${n.mes}] ${n.arq.slice(0, 48)}`);
        }
    }

    // ── (3) distribuição: o grupo tem tantos pares quanto documentos? ──────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) O GRUPO DISTRIBUI BEM SEUS DOCUMENTOS?');
    console.log('═'.repeat(78));
    let equilibrado = 0, sobraDoc = 0, faltaDoc = 0;
    const exSobra = [];
    for (const [k, g] of gemeos) {
        const lista = paresDoGrupo.get(k) || [];
        const usados = new Set(lista.map(x => x.arq));
        if (!lista.length) continue;
        if (usados.size === lista.length && usados.size === g.length) equilibrado++;
        else if (usados.size < g.length) {
            sobraDoc++;
            if (exSobra.length < 8) exSobra.push({ k, g, lista, usados });
        } else faltaDoc++;
    }
    console.log(`\n   grupos com pelo menos 1 par: ${[...paresDoGrupo.keys()].length}`);
    console.log(`      todos os documentos usados, 1 par cada: ${equilibrado}`);
    console.log(`      sobram documentos sem par:              ${sobraDoc}`);
    for (const e of exSobra) {
        console.log(`\n   ${e.k}   ${e.g.length} documentos, ${e.lista.length} pares`);
        for (const u of e.lista) console.log(`      par: ${u.periodo}  ${brl(u.vLanc)}  ${u.arq.slice(0, 44)}`);
        for (const d of e.g) if (!e.usados.has(d.arq)) console.log(`      OCIOSO: [${d.mes}] ${d.arq.slice(0, 48)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
