/**
 * _medir/divergencias.js — dimensiona o card "Valores divergentes".
 *
 * Pergunta: dos pares que o motor faz, em quantos o valor do documento difere do
 * valor do lançamento, e de quanto? O card só se justifica se o número for
 * pequeno o bastante para alguém conferir e grande o bastante para importar.
 *
 * Roda o mesmo `conferirPeriodo` da rota, com o mesmo enriquecimento por OCR.
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

function valorMaisProximo(l, d) {
    const cands = [d.valor, d.valorAlt].filter(v => v != null && v > 0);
    if (!cands.length) return null;
    return cands.reduce((a, b) => Math.abs(l.valor - a) <= Math.abs(l.valor - b) ? a : b);
}

(async () => {
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();

    let totPares = 0, totDiv = 0, totSemValor = 0, somaDif = 0;
    const porVia = {}, faixas = { '<=1%': 0, '1-10%': 0, '10-50%': 0, '>50%': 0 };
    const exemplos = [];

    for (const periodo of h.PERIODOS) {
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
        }
        const lancs = ((planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        const pares = [...r.pares, ...r.paresVizinhos];

        let div = 0, semValor = 0;
        for (const par of pares) {
            const l = par.lancamento, d = par.documento;
            if (!(l.valor > 0)) continue;
            const v = valorMaisProximo(l, d);
            if (v == null) { semValor++; continue; }
            const dif = v - l.valor;
            if (Math.abs(dif) < 0.005) continue;
            div++;
            somaDif += Math.abs(dif);
            porVia[par.via] = (porVia[par.via] || 0) + 1;
            const pc = Math.abs(dif / l.valor) * 100;
            faixas[pc <= 1 ? '<=1%' : pc <= 10 ? '1-10%' : pc <= 50 ? '10-50%' : '>50%']++;
            exemplos.push({ periodo, ent: l.entidade, nf: l.nf, pl: l.valor, doc: v, dif, pc, arq: d.arquivo, via: par.via });
        }
        totPares += pares.length; totDiv += div; totSemValor += semValor;
        console.log(`${periodo}  pares ${String(pares.length).padStart(4)}  ` +
            `divergentes ${String(div).padStart(3)} (${(div / pares.length * 100).toFixed(1)}%)  ` +
            `sem valor no papel ${semValor}`);
    }

    console.log(`\nTOTAL  pares ${totPares}  divergentes ${totDiv} ` +
        `(${(totDiv / totPares * 100).toFixed(1)}%)  sem valor ${totSemValor}`);
    console.log(`soma das diferenças em módulo: R$ ${somaDif.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log('\npor via:', porVia);
    console.log('por faixa de % da diferença:', faixas);

    console.log('\n15 maiores diferenças:');
    exemplos.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
    for (const e of exemplos.slice(0, 15))
        console.log(`  ${e.periodo} ${String(e.ent).slice(0, 26).padEnd(26)} NF ${String(e.nf).padEnd(9)} ` +
            `pl ${e.pl.toFixed(2).padStart(11)}  doc ${e.doc.toFixed(2).padStart(11)}  ` +
            `dif ${e.dif.toFixed(2).padStart(11)} (${e.pc.toFixed(0)}%)  ${e.via}`);

    console.log('\n15 menores diferenças (a retenção/desconto esperado):');
    for (const e of exemplos.slice(-15))
        console.log(`  ${e.periodo} ${String(e.ent).slice(0, 26).padEnd(26)} NF ${String(e.nf).padEnd(9)} ` +
            `pl ${e.pl.toFixed(2).padStart(11)}  doc ${e.doc.toFixed(2).padStart(11)}  ` +
            `dif ${e.dif.toFixed(2).padStart(9)} (${e.pc.toFixed(2)}%)  ${e.via}`);
    process.exit(0);
})();
