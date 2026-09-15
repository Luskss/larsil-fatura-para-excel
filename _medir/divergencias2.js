/**
 * _medir/divergencias2.js — separa PARCELA de divergência real.
 *
 * A primeira medição (`divergencias.js`) achou 247 pares com valor divergindo, e
 * as 15 maiores diferenças eram todas razão inteira exata: CIMAG R$ 30.600 ÷ 5 =
 * R$ 6.120, AGRICOPEL R$ 20.995 ÷ 4 = R$ 5.248,75. Não é divergência, é parcela —
 * o problema que PROGRESSO §13/§14 descreve. Listá-las no card de divergência
 * seria transformar o card em ruído.
 *
 * Aqui a classificação é medida, não presumida.
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const MAX_PARCELAS = 36;

function valorMaisProximo(l, d) {
    const c = [d.valor, d.valorAlt].filter(v => v != null && v > 0);
    if (!c.length) return null;
    return c.reduce((a, b) => Math.abs(l.valor - a) <= Math.abs(l.valor - b) ? a : b);
}

// Razão total ÷ documento inteira (tolerância de centavo por parcela).
function razaoParcela(total, parte) {
    if (!(parte > 0) || parte >= total) return null;
    const r = total / parte;
    const n = Math.round(r);
    if (n < 2 || n > MAX_PARCELAS) return null;
    return Math.abs(total - n * parte) <= 0.02 * n ? n : null;
}

(async () => {
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();

    const grupos = { parcela: [], sobra: [] };

    for (const periodo of h.PERIODOS) {
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
        }
        const lancs = ((planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);

        for (const par of [...r.pares, ...r.paresVizinhos]) {
            const l = par.lancamento, d = par.documento;
            if (!(l.valor > 0)) continue;
            const v = valorMaisProximo(l, d);
            if (v == null) continue;
            const dif = v - l.valor;
            if (Math.abs(dif) < 0.005) continue;
            const n = razaoParcela(l.valor, v);
            const e = { periodo, ent: l.entidade, nf: l.nf, pl: l.valor, doc: v, dif,
                        pc: dif / l.valor * 100, n, arq: d.arquivo };
            grupos[n ? 'parcela' : 'sobra'].push(e);
        }
    }

    const soma = a => a.reduce((s, x) => s + Math.abs(x.dif), 0);
    console.log(`parcela (razão inteira 2..${MAX_PARCELAS}): ${grupos.parcela.length} pares, ` +
        `R$ ${soma(grupos.parcela).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} de diferença`);
    console.log(`divergência real:                  ${grupos.sobra.length} pares, ` +
        `R$ ${soma(grupos.sobra).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} de diferença`);

    const f = { '<=1%': 0, '1-5%': 0, '5-15%': 0, '15-50%': 0, '>50%': 0 };
    for (const e of grupos.sobra) {
        const pc = Math.abs(e.pc);
        f[pc <= 1 ? '<=1%' : pc <= 5 ? '1-5%' : pc <= 15 ? '5-15%' : pc <= 50 ? '15-50%' : '>50%']++;
    }
    console.log('\ndivergência real, por faixa de %:', f);

    console.log('\nas 25 maiores divergências REAIS:');
    grupos.sobra.sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
    for (const e of grupos.sobra.slice(0, 25))
        console.log(`  ${e.periodo} ${String(e.ent).slice(0, 28).padEnd(28)} NF ${String(e.nf).padEnd(9)} ` +
            `pl ${e.pl.toFixed(2).padStart(11)}  doc ${e.doc.toFixed(2).padStart(11)}  ` +
            `dif ${e.dif.toFixed(2).padStart(11)} (${e.pc.toFixed(0)}%)\n      ${e.arq}`);

    console.log('\nN das parcelas detectadas:');
    const porN = {};
    for (const e of grupos.parcela) porN[e.n] = (porN[e.n] || 0) + 1;
    console.log(Object.entries(porN).sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}x:${c}`).join('  '));
    process.exit(0);
})();
