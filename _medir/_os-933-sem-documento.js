/**
 * _medir/_os-933-sem-documento.js — o buraco é falta de papel ou falha do motor?
 *
 * MEDIDO (`_o-que-sobrou-para-fazer.js`): 933 lançamentos sem documento,
 * R$ 4.785.579 — 30,5% dos lançamentos de jan–jun. É o maior número em aberto da
 * sessão, e eu nunca o abri por causa.
 *
 * Duas naturezas muito diferentes:
 *   (a) NÃO EXISTE papel — folha, cartão, PIX, tributo sem nota. Esperado; o
 *       projeto até filtra parte disso ([[entidades-sem-nota-fornecedor]],
 *       [[filtro-nao-fiscal-regra-a-regra]]).
 *   (b) EXISTE papel e o motor não achou — aí sim é pool de conserto.
 *
 * Misturar as duas produz um número grande e inútil. O top da lista já sugere (a):
 * FOLHA DE PAGAMENTO R$ 675 mil, CARTAO CRED R$ 454 mil.
 *
 * ── Como separar sem chutar ─────────────────────────────────────────────────
 * Para cada lançamento sem par, procurar no ACERVO INTEIRO (não só na janela) um
 * documento com:
 *   • o mesmo NÚMERO (≥4 dígitos, para não colidir — [[piso-digitos-numero-curto]])
 *   • ou o mesmo VALOR exato + fornecedor parecido
 *
 * Se não acha nada, o papel não existe. Se acha, o motor deixou passar — e aí
 * interessa saber POR QUE (fora da janela? número curto? entidade diferente?).
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

// as famílias que notoriamente não têm nota de fornecedor
const SEM_NOTA = /\bFOLHA\b|\bCARTAO\b|\bPIX\b|\bSALARIO\b|\bPRO ?LABORE\b|\bFGTS\b|\bINSS\b|\bDARF\b|\bIRRF\b|\bPENSAO\b|\bRESCISAO\b|\bFERIAS\b|\b13\b|\bVALE\b|\bADIANTAMENTO\b|\bEMPRESTIMO\b|\bFINANCIAMENTO\b|\bCONSORCIO\b|\bTARIFA\b|\bJUROS\b|\bIOF\b|\bTED\b|\bDOC\b/;

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // ── índice do ACERVO INTEIRO ───────────────────────────────────────────
    const porNumero = new Map(), porValor = new Map();
    let totalDocs = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            totalDocs++;
            const o = idx[a.nome] || {};
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), o);
            const ent = norm(d.emitente || o.emitente || '');
            const val = Math.abs(Number(d.valor || o.valor) || 0);
            const reg = { mes, arq: a.nome, ent, val };
            for (const n of [soDig(o.numero || ''), soDig(p.numeroDoNome ? p.numeroDoNome(a.nome) : '')]) {
                if (!n || n.length < 4) continue;          // piso contra colisão
                if (!porNumero.has(n)) porNumero.set(n, []);
                if (!porNumero.get(n).some(x => x.arq === a.nome)) porNumero.get(n).push(reg);
            }
            if (val) {
                const k = val.toFixed(2);
                if (!porValor.has(k)) porValor.set(k, []);
                porValor.get(k).push(reg);
            }
        }
    console.log(`documentos no acervo: ${totalDocs}\n`);

    // ── os lançamentos sem par ─────────────────────────────────────────────
    const orfaos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        const faltando = r.semDocumento || r.faltantes || r.naoEncontrados || [];
        for (const f of faltando) {
            const l = f.lancamento || f;
            orfaos.push({ periodo, nf: soDig(l.nf), ent: norm(l.entidade || l.fornecedor || ''),
                          valor: Math.abs(Number(l.valor) || 0) });
        }
    }
    console.log(`lançamentos sem documento: ${orfaos.length}\n`);

    // ── (1) quantos são de famílias que não têm nota? ──────────────────────
    const naoFiscal = orfaos.filter(o => SEM_NOTA.test(o.ent));
    const fiscal = orfaos.filter(o => !SEM_NOTA.test(o.ent));
    console.log('═'.repeat(78));
    console.log('(1) O PAPEL DEVERIA EXISTIR?');
    console.log('═'.repeat(78));
    console.log(`\n   família SEM nota (folha, cartão, tributo, financiamento…):`);
    console.log(`      ${naoFiscal.length} lançamentos   ${brl(naoFiscal.reduce((s, o) => s + o.valor, 0))}`);
    console.log(`   os demais (deveriam ter documento):`);
    console.log(`      ${fiscal.length} lançamentos   ${brl(fiscal.reduce((s, o) => s + o.valor, 0))}`);

    // ── (2) dos que deveriam ter, o papel está no acervo? ──────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O PAPEL ESTÁ NO ACERVO E O MOTOR NÃO ACHOU?');
    console.log('═'.repeat(78));
    let achouPorNumero = 0, achouPorValor = 0, naoAchou = 0;
    const exNum = [], exVal = [];
    const entParecida = (a, b) => {
        if (!a || !b) return false;
        return a.slice(0, 8) === b.slice(0, 8) || a.includes(b.slice(0, 8)) || b.includes(a.slice(0, 8));
    };
    for (const o of fiscal) {
        let achado = null;
        if (o.nf && o.nf.length >= 4) {
            const cands = (porNumero.get(o.nf) || []).filter(x => entParecida(o.ent, x.ent));
            if (cands.length) achado = { tipo: 'numero', x: cands[0] };
        }
        if (!achado && o.valor) {
            const cands = (porValor.get(o.valor.toFixed(2)) || []).filter(x => entParecida(o.ent, x.ent));
            if (cands.length) achado = { tipo: 'valor', x: cands[0] };
        }
        if (!achado) { naoAchou++; continue; }
        if (achado.tipo === 'numero') { achouPorNumero++; if (exNum.length < 10) exNum.push({ o, ...achado }); }
        else { achouPorValor++; if (exVal.length < 10) exVal.push({ o, ...achado }); }
    }
    console.log(`\n   achei documento pelo NÚMERO + fornecedor:  ${achouPorNumero}  ${pct(achouPorNumero, fiscal.length)}  ← pool forte`);
    console.log(`   achei pelo VALOR + fornecedor:             ${achouPorValor}  ${pct(achouPorValor, fiscal.length)}  ← pool fraco`);
    console.log(`   nada no acervo:                            ${naoAchou}  ${pct(naoAchou, fiscal.length)}  ← papel não existe`);

    if (exNum.length) {
        console.log('\n── os achados por NÚMERO (o motor deixou passar) ───────────');
        for (const e of exNum) {
            console.log(`\n   ${e.o.periodo}  ${brl(e.o.valor)}  NF=${e.o.nf}  ${e.o.ent.slice(0, 24)}`);
            console.log(`      documento: [${e.x.mes}] ${e.x.arq.slice(0, 52)}`);
            console.log(`      valor do doc: ${e.x.val ? brl(e.x.val) : '—'}   bate? ${e.x.val && Math.abs(e.x.val - e.o.valor) < 0.02 ? 'SIM' : 'não'}`);
            const mesmoMes = e.x.mes === e.o.periodo;
            console.log(`      está no mês do lançamento? ${mesmoMes ? 'sim' : 'NÃO — ' + e.x.mes}`);
        }
    }
    console.log(`\n${'═'.repeat(78)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(78));
    console.log(`\n   dos ${orfaos.length} sem documento, ${naoFiscal.length} são de famílias sem nota.`);
    console.log(`   dos ${fiscal.length} restantes, o pool com documento localizável`);
    console.log(`   pelo número é ${achouPorNumero}.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
