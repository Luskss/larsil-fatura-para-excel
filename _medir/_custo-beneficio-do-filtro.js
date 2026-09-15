/**
 * _medir/_custo-beneficio-do-filtro.js — cada regra de `categoriaNaoFiscal` vale o
 * que custa?
 *
 * ACHADO (15/09/2026): as regras cortam 84 pares de 2+ sinais em jan–jun,
 * R$ 789.671,72 — documentos que existem na pasta, são lidos, e nunca chegam ao
 * pareamento. Vários de força 3 (número + entidade + valor batendo).
 *
 * Mas o corte não está errado por isso: ele existe para tirar da conta o papel que
 * NÃO é nota de fornecedor. A pergunta certa é, por regra:
 *
 *   BENEFÍCIO  documentos cortados que não casariam com lançamento nenhum
 *              (o filtro os esconde e faz bem)
 *   CUSTO      documentos cortados que casariam com 2+ sinais
 *              (o filtro os esconde e faz mal)
 *
 * Uma regra com benefício 500 e custo 3 fica. Uma com benefício 12 e custo 30 é
 * candidata a afinar — provavelmente distinguindo o MEIO de pagamento ("pago por
 * cheque/PIX a um fornecedor") da NATUREZA do papel ("compensação bancária pura").
 *
 * ── Por que "não casaria" não é o mesmo que "não é documento" ────────────────
 * Um comprovante de PIX ao fornecedor X pode não casar simplesmente porque o
 * lançamento dele já casou com a nota fiscal — o PIX é o segundo papel do mesmo
 * pagamento. Por isso o benefício aqui é um LIMITE SUPERIOR: mede quantos não
 * disputam lançamento nenhum, não quantos são de fato lixo.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_custo-beneficio-do-filtro.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const ARQ = process.env.ARQUIVO_PATH || '\\\\larsil-dell\\LA26.EXT.BANC';
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
    const rota = h.internasDaRota();
    const c = h.carregar();
    console.error('[custo-beneficio] reindexando...');
    const idx = await indexar();

    // ── todos os documentos CORTADOS, por categoria ─────────────────────────
    const cortados = [];
    (function anda(dir, rel) {
        let e; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) {
            const filho = path.join(dir, x.name);
            const relFilho = rel ? `${rel}/${x.name}` : x.name;
            if (x.isDirectory()) { anda(filho, relFilho); continue; }
            if (!/\.pdf$/i.test(x.name)) continue;
            if (!rota.ehDoc(x.name)) continue;
            const mes = rota.mesDoDocumento(x.name, rel);
            if (!mes) continue;
            const cat = rota.categoriaNaoFiscal(x.name);
            if (!cat) continue;
            cortados.push({ nome: x.name, rel: relFilho, mes, categoria: cat,
                            doc: p.enriquecerComOcr(p.documentoDoArquivo(x.name, relFilho), idx[x.name]) });
        }
    })(ARQ, '');

    // ── lançamentos sem documento, por mês ──────────────────────────────────
    const semDocPorMes = new Map();
    for (const periodo of h.PERIODOS) {
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        const k = l => `${l.entidade}|${l.nf}|${l.valor}`;
        const casados = new Set([...r.pares, ...r.paresVizinhos].map(x => k(x.lancamento)));
        semDocPorMes.set(periodo, lancs.filter(l => !casados.has(k(l))));
    }

    // ── por categoria: quantos cortados casariam, quantos não ───────────────
    const stat = new Map();   // categoria → { total, casaria, custoValor, exemplosCusto, exemplosOk }
    for (const x of cortados) {
        if (!stat.has(x.categoria))
            stat.set(x.categoria, { total: 0, casaria: 0, custoValor: 0, exC: [], exB: [] });
        const s = stat.get(x.categoria);
        s.total++;

        // procura lançamento pendente que casaria com 2+ sinais, no mês do doc e vizinhos
        let achou = null;
        for (const periodo of h.PERIODOS) {
            const meses = new Set([periodo, ...p.VIZINHANCA.map(o => p.deslocarPeriodo(periodo, o))]);
            if (!meses.has(x.mes)) continue;
            for (const l of (semDocPorMes.get(periodo) || [])) {
                const via = p.casa(l, x.doc, true);
                if (!via) continue;
                const f = (p.valorBate(l, x.doc) ? 1 : 0) + (p.numeroBate(l, x.doc) ? 1 : 0)
                        + (p.entidadeBate(l, x.doc) ? 1 : 0);
                if (f < 2) continue;
                achou = { l, via, f, periodo };
                break;
            }
            if (achou) break;
        }
        if (achou) {
            s.casaria++;
            s.custoValor += Math.abs(achou.l.valor || 0);
            if (s.exC.length < 3) s.exC.push(`${brl(achou.l.valor).padStart(14)} "${String(achou.l.entidade).slice(0,24)}" f${achou.f} → ${x.nome.slice(0,40)}`);
        } else if (s.exB.length < 3) s.exB.push(x.nome.slice(0, 56));
    }

    console.log('═'.repeat(84));
    console.log('CUSTO × BENEFÍCIO DE CADA REGRA DE `categoriaNaoFiscal`');
    console.log('═'.repeat(84));
    console.log(`documentos cortados no acervo: ${cortados.length}\n`);
    console.log('  corta  casaria  ratio   valor perdido       categoria');
    const linhas = [...stat].sort((a, b) => b[1].casaria - a[1].casaria);
    for (const [cat, s] of linhas) {
        const ratio = s.total ? (s.casaria / s.total) : 0;
        const marca = s.casaria === 0 ? '  ' : ratio > 0.05 ? '⚠ ' : '· ';
        console.log(`${marca}${String(s.total).padStart(5)} ${String(s.casaria).padStart(8)}` +
            `  ${(100*ratio).toFixed(1).padStart(5)}%  ${brl(s.custoValor).padStart(17)}   ${cat}`);
    }

    console.log('\n' + '─'.repeat(84));
    console.log('DETALHE das regras com custo (⚠ = mais de 5% do que corta tinha lançamento):\n');
    for (const [cat, s] of linhas) {
        if (!s.casaria) continue;
        const ratio = s.total ? (s.casaria / s.total) : 0;
        console.log(`▸ ${cat}`);
        console.log(`   corta ${s.total}, dos quais ${s.casaria} tinham lançamento esperando (${(100*ratio).toFixed(1)}%) — ${brl(s.custoValor)}`);
        for (const e of s.exC) console.log(`      CUSTO ${e}`);
        for (const e of s.exB) console.log(`      ok    ${e}`);
        console.log('');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
