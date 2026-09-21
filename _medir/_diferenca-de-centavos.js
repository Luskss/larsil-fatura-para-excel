/**
 * _medir/_diferenca-de-centavos.js — o motor perde par por diferença mínima?
 *
 * ACHADO (`_os-933-sem-documento.js`): dos 933 lançamentos sem documento, 97,7%
 * não têm papel no acervo — o motor não falhou, o documento não foi arquivado.
 * Mas entre os 5 localizáveis por número apareceu isto:
 *
 *     06.2026  lançado R$ 1.385,20  NF=11225  DHL
 *        documento: 017.DOC- 1383,60 … DHL. NFS 11225 + BOL   ← R$ 1,60 de diferença
 *
 * Mesmo fornecedor, MESMO número de nota, R$ 1,60 de diferença. Se o motor exige
 * valor exato e o número não bastou para casar, uma tolerância de centavos poderia
 * recuperar pares — a diferença típica é desconto, arredondamento ou juros.
 *
 * ── Antes de propor tolerância, DIMENSIONAR ─────────────────────────────────
 * [[dimensionar-o-pool-antes-de-medir]]. E cuidado: tolerância afrouxa a régua, e
 * régua frouxa inventa par ([[media-agregada-esconde-par-falso]]). O teste tem de
 * ser: quantos lançamentos órfãos têm um documento do MESMO FORNECEDOR com valor
 * a menos de X% — e quantos deles têm também o número batendo (prova forte).
 *
 *   • com número igual + valor próximo → par quase certo, tolerância se paga
 *   • só valor próximo, sem número     → risco de par falso
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
const SEM_NOTA = /\bFOLHA\b|\bCARTAO\b|\bPIX\b|\bSALARIO\b|\bPRO ?LABORE\b|\bFGTS\b|\bINSS\b|\bDARF\b|\bIRRF\b|\bPENSAO\b|\bRESCISAO\b|\bFERIAS\b|\bVALE\b|\bADIANTAMENTO\b|\bEMPRESTIMO\b|\bFINANCIAMENTO\b|\bCONSORCIO\b|\bTARIFA\b|\bJUROS\b|\bIOF\b/;

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // acervo por fornecedor
    const porEnt = new Map();
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const o = idx[a.nome] || {};
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), o);
            const ent = norm(d.emitente || o.emitente || '');
            if (!ent) continue;
            const k = ent.slice(0, 8);
            if (!porEnt.has(k)) porEnt.set(k, []);
            porEnt.get(k).push({ mes, arq: a.nome, ent,
                                  val: Math.abs(Number(d.valor || o.valor) || 0),
                                  num: soDig(o.numero || '') || soDig(p.numeroDoNome ? p.numeroDoNome(a.nome) : '') });
        }

    // órfãos que deveriam ter papel
    const orfaos = [];
    const usados = new Set();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) usados.add(x.documento.arquivo);
        const faltando = r.semDocumento || r.faltantes || r.naoEncontrados || [];
        for (const f of faltando) {
            const l = f.lancamento || f;
            const ent = norm(l.entidade || l.fornecedor || '');
            if (SEM_NOTA.test(ent)) continue;
            orfaos.push({ periodo, nf: soDig(l.nf), ent, valor: Math.abs(Number(l.valor) || 0) });
        }
    }
    console.log(`órfãos que deveriam ter papel: ${orfaos.length}\n`);

    // ── procurar documento do mesmo fornecedor com valor PRÓXIMO ───────────
    const FAIXAS = [0.001, 0.005, 0.01, 0.02, 0.05];
    console.log('═'.repeat(78));
    console.log('DOCUMENTO DO MESMO FORNECEDOR COM VALOR PRÓXIMO');
    console.log('═'.repeat(78));
    console.log('\n tolerância   com nº igual   só valor   doc já usado   total');
    for (const tol of FAIXAS) {
        let comNum = 0, soValor = 0, jaUsado = 0;
        for (const o of orfaos) {
            const cands = porEnt.get(o.ent.slice(0, 8)) || [];
            let achou = null;
            for (const x of cands) {
                if (!x.val || !o.valor) continue;
                const dif = Math.abs(x.val - o.valor) / o.valor;
                if (dif > tol || dif === 0) continue;       // dif 0 já casaria
                const numIgual = o.nf && o.nf.length >= 4 && x.num === o.nf;
                if (!achou || numIgual) achou = { x, numIgual };
                if (numIgual) break;
            }
            if (!achou) continue;
            if (usados.has(achou.x.arq)) jaUsado++;
            else if (achou.numIgual) comNum++;
            else soValor++;
        }
        console.log(`  ${(tol * 100).toFixed(1).padStart(5)}%   ${String(comNum).padStart(11)}   ${String(soValor).padStart(8)}   ${String(jaUsado).padStart(12)}   ${String(comNum + soValor).padStart(5)}`);
    }

    // ── os casos com número igual, detalhados ──────────────────────────────
    console.log('\n── os com NÚMERO IGUAL e valor próximo (≤5%) ───────────────');
    let n = 0;
    for (const o of orfaos) {
        if (!o.nf || o.nf.length < 4) continue;
        const cands = porEnt.get(o.ent.slice(0, 8)) || [];
        for (const x of cands) {
            if (x.num !== o.nf || !x.val || !o.valor) continue;
            const dif = Math.abs(x.val - o.valor);
            const rel = dif / o.valor;
            if (rel === 0 || rel > 0.05) continue;
            if (usados.has(x.arq)) continue;
            n++;
            if (n <= 12) {
                console.log(`\n   ${o.periodo}  lançado ${brl(o.valor)}  NF=${o.nf}  ${o.ent.slice(0, 22)}`);
                console.log(`      doc: [${x.mes}] ${x.arq.slice(0, 50)}`);
                console.log(`      valor do doc ${brl(x.val)}   diferença ${brl(dif)} (${(rel * 100).toFixed(2)}%)`);
            }
            break;
        }
    }
    console.log(`\n   total: ${n}`);
    console.log('\n   → esses são pares que o motor perde por diferença de centavos,');
    console.log('     com número e fornecedor confirmando. Pool pequeno, mas limpo.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
