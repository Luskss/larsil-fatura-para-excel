/**
 * _medir/_retencao-aritmetica.js — a divergência é o imposto retido?
 *
 * Hipótese (caso CORREA TRUCK HOUSE NF 377): a planilha lança o valor BRUTO do
 * serviço (3.690,00) e o documento traz o LÍQUIDO (3.505,50), porque o ISSRF de
 * 184,50 foi retido na fonte. Diferença = imposto. Não é erro de ninguém: são
 * dois campos diferentes do mesmo papel.
 *
 * Este medidor NÃO propõe regra ainda. Pergunta três coisas, em ordem:
 *
 *   1. Dos divergentes, quantos têm a diferença batendo com uma ALÍQUOTA de
 *      retenção conhecida (ISS 2..5%, IRRF 1,5%, PIS/COFINS/CSLL 4,65%, INSS 11%)
 *      calculada sobre o valor da PLANILHA? É aritmética exata, não semelhança.
 *   2. Quantos batem com a SOMA de várias dessas alíquotas (o caso comum: ISS +
 *      IRRF juntos, ou o bloco 4,65%)?
 *   3. Quantos têm, no `dados_parser`, um campo `impostos` que já explica a conta?
 *
 * Só depois de saber o tamanho de cada faixa é que se decide o que fazer.
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

function razaoParcela(total, parte) {
    if (!(parte > 0) || parte >= total) return null;
    const n = Math.round(total / parte);
    if (n < 2 || n > 36) return null;
    return Math.abs(total - n * parte) <= 0.02 * n ? n : null;
}

// Alíquotas de retenção na fonte que a legislação brasileira usa neste contexto.
// ISS varia por município (2% a 5%); IRRF de serviço é 1,5%; o bloco
// PIS+COFINS+CSLL é 4,65%; INSS de cessão de mão de obra é 11%.
const ALIQUOTAS = [
    ['ISS 2%', 2], ['ISS 2,5%', 2.5], ['ISS 3%', 3], ['ISS 3,5%', 3.5],
    ['ISS 4%', 4], ['ISS 4,5%', 4.5], ['ISS 5%', 5],
    ['IRRF 1,5%', 1.5], ['IRRF 4,8%', 4.8],
    ['CSLL/PIS/COFINS 4,65%', 4.65],
    ['INSS 11%', 11],
];

// A diferença bate com UMA alíquota, sobre o bruto da planilha?
// Tolerância de 1 centavo: a retenção é calculada e arredondada pelo emissor.
function aliquotaUnica(bruto, dif) {
    for (const [nome, pc] of ALIQUOTAS) {
        const esperado = Math.round(bruto * pc) / 100;
        if (Math.abs(esperado - dif) <= 0.011) return nome;
    }
    return null;
}

// A diferença bate com a SOMA de duas alíquotas (ISS + IRRF é o par mais comum)?
function aliquotaDupla(bruto, dif) {
    for (let i = 0; i < ALIQUOTAS.length; i++)
        for (let j = i + 1; j < ALIQUOTAS.length; j++) {
            const soma = Math.round(bruto * ALIQUOTAS[i][1]) / 100
                       + Math.round(bruto * ALIQUOTAS[j][1]) / 100;
            if (Math.abs(soma - dif) <= 0.021)
                return `${ALIQUOTAS[i][0]} + ${ALIQUOTAS[j][0]}`;
        }
    return null;
}

(async () => {
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();

    let totPares = 0, totDiv = 0, parcelas = 0;
    const classe = {};              // rótulo → contagem
    const somaPorClasse = {};       // rótulo → soma das diferenças
    const exemplos = { unica: [], dupla: [], resto: [] };

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
        totPares += pares.length;

        for (const par of pares) {
            const l = par.lancamento, d = par.documento;
            if (!(l.valor > 0)) continue;
            const v = valorMaisProximo(l, d);
            if (v == null) continue;
            const dif = v - l.valor;
            if (Math.abs(dif) < 0.005) continue;
            if (razaoParcela(l.valor, dif > 0 ? v : v)) { /* checado abaixo */ }
            if (razaoParcela(l.valor, v)) { parcelas++; continue; }
            totDiv++;

            // Retenção SÓ faz sentido quando o documento vale MENOS que o
            // lançamento: reter é descontar. Documento maior que o lançado é
            // outro fenômeno (parcela ao contrário, par errado).
            let rotulo;
            if (dif > 0) {
                rotulo = 'documento MAIOR que o lançado';
            } else {
                const desconto = -dif;
                const u = aliquotaUnica(l.valor, desconto);
                const dd = u ? null : aliquotaDupla(l.valor, desconto);
                if (u) { rotulo = `retenção: ${u}`; if (exemplos.unica.length < 12) exemplos.unica.push({ l, d, v, dif, u }); }
                else if (dd) { rotulo = `retenção: ${dd}`; if (exemplos.dupla.length < 12) exemplos.dupla.push({ l, d, v, dif, u: dd }); }
                else {
                    const pc = desconto / l.valor * 100;
                    rotulo = pc <= 15 ? 'desconto ≤15% NÃO explicado' : 'diferença >15% NÃO explicada';
                    if (exemplos.resto.length < 15) exemplos.resto.push({ l, d, v, dif, u: `${pc.toFixed(2)}%` });
                }
            }
            classe[rotulo] = (classe[rotulo] || 0) + 1;
            somaPorClasse[rotulo] = (somaPorClasse[rotulo] || 0) + Math.abs(dif);
        }
    }

    console.log(`pares ${totPares}   divergentes (fora parcela) ${totDiv}   parcelas ${parcelas}\n`);
    console.log('COMPOSIÇÃO DA DIVERGÊNCIA:');
    const linhas = Object.entries(classe).sort((a, b) => b[1] - a[1]);
    for (const [k, n] of linhas)
        console.log(`  ${String(n).padStart(4)} (${(n / totDiv * 100).toFixed(1).padStart(5)}%)  ` +
            `R$ ${somaPorClasse[k].toLocaleString('pt-BR', { minimumFractionDigits: 2 }).padStart(14)}  ${k}`);

    const explicados = linhas.filter(([k]) => k.startsWith('retenção:')).reduce((s, x) => s + x[1], 0);
    console.log(`\nEXPLICADOS POR ALÍQUOTA DE RETENÇÃO: ${explicados} de ${totDiv} (${(explicados / totDiv * 100).toFixed(1)}%)`);

    const most = (t, arr) => {
        console.log(`\n${t}`);
        for (const e of arr)
            console.log(`  ${String(e.l.entidade).slice(0, 24).padEnd(24)} NF ${String(e.l.nf).padEnd(8)} ` +
                `pl ${e.l.valor.toFixed(2).padStart(10)}  doc ${e.v.toFixed(2).padStart(10)}  ` +
                `dif ${e.dif.toFixed(2).padStart(9)}  ${e.u}\n      ${String(e.d.arquivo).slice(0, 84)}`);
    };
    most('EXEMPLOS — alíquota única:', exemplos.unica);
    most('EXEMPLOS — soma de duas alíquotas:', exemplos.dupla);
    most('EXEMPLOS — não explicados:', exemplos.resto);

    process.exit(0);
})();
