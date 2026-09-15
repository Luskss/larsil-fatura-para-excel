/**
 * _medir/_retencao-regra.js — a regra candidata, medida contra os dois erros.
 *
 * O que `_retencao-resto.js` mostrou, e que define o desenho:
 *
 *   3,00–6,15%   47 casos   percentual ESTÁVEL e REPETIDO por fornecedor
 *                           (SKILLHUB 48,59 seis vezes; MRD 184,79 cinco vezes;
 *                           LOCALIZA 4,65% em seis notas). É retenção.
 *   14–32%        4 casos   zona cinzenta, poucos
 *   >50%         20 casos   par errado / entrada de carnê. NÃO é retenção.
 *
 * Ler o tributo do PDF pega 40 dos 110 e falha nos 47 acima por uma razão
 * concreta: no quadro de impostos da NFS-e o rótulo `ISSQN` costuma vir seguido
 * da BASE (ISSQN 513,44 = o próprio bruto), e os tributos reais ficam em colunas
 * que a extração de texto separa do rótulo. É o mesmo problema que
 * `_nf-itens.js` já documenta para o total da nota: ler por posição de coluna
 * está REPROVADO.
 *
 * Então a regra não deve depender de achar o número do imposto. O sinal robusto
 * é a CONJUNÇÃO de três fatos verificáveis:
 *
 *   1. o documento vale MENOS que o lançamento (reter é descontar);
 *   2. o desconto está na faixa plausível de retenção (≤ TETO);
 *   3. o papel é uma NFS-e COM retenção declarada — tem o vocabulário
 *      ("ISS RETIDO", "RETENCAO", "VALOR LIQUIDO", "TRIBUTADA ... RETENCAO NA
 *      FONTE"). Sem isso, desconto pequeno pode ser erro de digitação.
 *
 * Mede TETO de 6,5% a 20% para escolher o corte com dado, e reporta os dois
 * erros: retenção não reconhecida (fica na lista à toa) e — o caro — divergência
 * real classificada como retenção (some da lista).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const norm = s => String(s || '').toUpperCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

function valorMaisProximo(l, d) {
    const c = [d.valor, d.valorAlt].filter(v => v != null && v > 0);
    if (!c.length) return null;
    return c.reduce((a, b) => Math.abs(l.valor - a) <= Math.abs(l.valor - b) ? a : b);
}
function razaoParcela(total, parte) {
    if (!(parte > 0) || parte >= total) return null;
    const n = Math.round(total / parte);
    if (n < 2 || n > 36) return null;
    return Math.abs(total - n * parte) <= 0.02 * n ? n : null;
}
async function texto(rel) {
    const abs = path.join(RAIZ_ARQ, rel || '');
    if (!rel || !fs.existsSync(abs)) return null;
    let pr;
    try {
        pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const r = await pr.getText();
        return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    } catch (e) { return null; }
    finally { try { if (pr) await pr.destroy(); } catch (_) {} }
}

// O papel DECLARA retenção na fonte? Vocabulário da NFS-e, não número.
const RE_RETENCAO = /ISS\s*RETIDO|ISSRF|RETENCAO NA FONTE|RETIDO NA FONTE|VALOR LIQUIDO|TRIBUTADA INTEGRALMENTE COM RETENCAO|IRRF|RETENCOES/;
// E é mesmo nota de SERVIÇO? Retenção na fonte é fenômeno de serviço; em venda
// de mercadoria o ICMS já está embutido no total e não gera esta diferença.
const RE_SERVICO = /NFS-?E|NOTA FISCAL DE SERVICO|PRESTADOR DE SERVICO|DESCRICAO DOS SERVICOS|LISTA DE SERVICO|TOMADOR DO SERVICO/;

(async () => {
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();
    const casos = [];
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
            if (razaoParcela(l.valor, v)) continue;
            casos.push({ l, d, v, dif, desc: -dif, pc: -dif / l.valor * 100 });
        }
    }

    // Lê o texto uma vez só por caso (é a parte cara: I/O de rede).
    console.error(`lendo ${casos.length} PDFs...`);
    for (const c of casos) {
        const tx = await texto(c.d.caminho);
        const t = tx ? norm(tx) : '';
        c.temTexto = !!tx;
        c.declara = RE_RETENCAO.test(t);
        c.servico = RE_SERVICO.test(t);
    }

    // A verdade de referência: >15% NÃO é retenção (é par errado / carnê), o que a
    // inspeção de `_retencao-resto.js` mostrou caso a caso. Abaixo disso, com
    // vocabulário de retenção no papel, é retenção.
    const ehRetencaoReal = c => c.dif < 0 && c.pc <= 15 && c.declara;

    console.log(`\ndivergências (fora parcela): ${casos.length}`);
    console.log(`  documento menor que o lançado: ${casos.filter(c => c.dif < 0).length}`);
    console.log(`  destes, papel DECLARA retenção: ${casos.filter(c => c.dif < 0 && c.declara).length}`);
    console.log(`  destes, papel é de SERVIÇO:     ${casos.filter(c => c.dif < 0 && c.servico).length}\n`);

    console.log('TETO   classificados   perdidos(>15% marcados como retenção)   retenções que ficam na lista');
    for (const teto of [6.5, 8, 10, 12, 15, 20]) {
        const regra = c => c.dif < 0 && c.pc <= teto && c.declara && c.servico;
        const marcados = casos.filter(regra);
        // O erro CARO: uma divergência real (par errado, valor errado) sumir da lista.
        const falsos = marcados.filter(c => !ehRetencaoReal(c));
        // O erro barato: retenção que continua na lista, poluindo mas não escondendo.
        const perdidas = casos.filter(c => ehRetencaoReal(c) && !regra(c));
        console.log(`${String(teto).padStart(5)}%  ${String(marcados.length).padStart(13)}  ` +
            `${String(falsos.length).padStart(38)}  ${String(perdidas.length).padStart(27)}`);
    }

    const TETO = 15;
    const regra = c => c.dif < 0 && c.pc <= TETO && c.declara && c.servico;
    const marcados = casos.filter(regra);
    console.log(`\n=== COM TETO ${TETO}% + declara retenção + é serviço ===`);
    console.log(`classificados como RETENÇÃO: ${marcados.length} de ${casos.length} ` +
        `(${(marcados.length / casos.length * 100).toFixed(1)}%)`);
    console.log(`soma retida: R$ ${marcados.reduce((s, c) => s + c.desc, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log(`RESTAM na lista de divergências: ${casos.length - marcados.length}`);

    const falsos = marcados.filter(c => !ehRetencaoReal(c));
    console.log(`\nfalsos positivos (some da lista sem ser retenção): ${falsos.length}`);
    for (const c of falsos)
        console.log(`  ${c.pc.toFixed(2)}%  ${String(c.l.entidade).slice(0, 26).padEnd(26)} NF ${c.l.nf}  ` +
            `pl ${c.l.valor.toFixed(2)} doc ${c.v.toFixed(2)}`);

    console.log('\nO QUE RESTA na lista (a divergência de verdade), por % :');
    const resta = casos.filter(c => !regra(c)).sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));
    for (const c of resta.slice(0, 30))
        console.log(`  ${(c.dif < 0 ? -c.pc : c.pc).toFixed(1).padStart(7)}%  ${String(c.l.entidade).slice(0, 26).padEnd(26)} ` +
            `NF ${String(c.l.nf).padEnd(8)} pl ${c.l.valor.toFixed(2).padStart(11)} doc ${c.v.toFixed(2).padStart(11)}` +
            `${c.declara ? '' : '  [sem vocab. retenção]'}`);
    process.exit(0);
})();
