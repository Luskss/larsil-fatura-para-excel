/**
 * _medir/_retencao-no-papel.js — a retenção está ESCRITA no documento?
 *
 * `_retencao-aritmetica.js` mostrou que 38% das divergências batem com uma
 * alíquota conhecida. Mas mostrou também o limite de adivinhar alíquota: ARPSEG
 * diverge 3,52% em três notas, AGRIPONTA 3,97% e 4,11% — percentuais estáveis por
 * fornecedor que NÃO estão na tabela legal porque o ISS é municipal e a base pode
 * não ser o valor cheio. Chutar a lista de alíquotas até cobrir esses casos é
 * fazer a regra passar a explicar QUALQUER diferença pequena, que é o oposto do
 * que se quer: a 2% de tolerância entra o erro de digitação também.
 *
 * A pergunta certa é outra. A NFS-e IMPRIME a retenção: o papel do CORREA TRUCK
 * traz "ISSRF 184,50" e "Valor Líquido 3.505,50" ao lado de "Valor Total 3.690,00".
 * Se o texto do documento tem os dois números, a conferência vira ARITMÉTICA
 * VERIFICADA no papel — bruto − retenções = líquido — e não depende de tabela
 * nenhuma.
 *
 * Mede: para cada divergência, o texto do PDF traz um bruto que bate com a
 * planilha e retenções que fecham a diferença?
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

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

const norm = s => String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
const paraNumero = s => {
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
};

const RE_N = '([\\d.]{0,12}\\d,\\d{2})';

// Rótulos do BRUTO numa NFS-e — o que a planilha lança.
const RE_BRUTO = [
    `VALOR TOTAL(?: DA NOTA)?[:\\s]*R?\\$?\\s*${RE_N}`,
    `VALOR (?:DOS )?SERVICOS?[:\\s]*R?\\$?\\s*${RE_N}`,
    `VALOR TOTAL DOS SERVICOS[:\\s]*R?\\$?\\s*${RE_N}`,
    `BASE DE CALCULO[:\\s]*R?\\$?\\s*${RE_N}`,
];
// Rótulos do LÍQUIDO — o que o boleto cobra.
const RE_LIQ = [
    `VALOR LIQUIDO(?: DA NFS-?E)?[:\\s]*R?\\$?\\s*${RE_N}`,
];
// Cada tributo retido, isolado. ISSRF/ISSQN retido, IR, INSS, CSLL, COFINS, PIS.
const TRIBUTOS = ['ISSRF', 'ISSQN', 'IRRF', 'IR', 'INSS', 'CSLL', 'COFINS', 'PIS',
                  'TOTAL TRIB FEDERAIS', 'OUTRAS RETENCOES', 'DESC INCONDIC', 'DEDUCAO'];

function acha(t, res) {
    for (const r of res) {
        const m = t.match(new RegExp(r));
        if (m) { const v = paraNumero(m[1]); if (v) return v; }
    }
    return null;
}

function tributos(t) {
    const out = {};
    for (const nome of TRIBUTOS) {
        const m = t.match(new RegExp(`\\b${nome.replace(/ /g, '\\s+')}\\b[:\\s]*R?\\$?\\s*${RE_N}`));
        if (m) { const v = paraNumero(m[1]); if (v) out[nome] = v; }
    }
    return out;
}

// Mesma extração da rota `process-folder.js` (pdf-parse 2.x, classe PDFParse):
// medir com outro leitor mediria outro texto.
const { PDFParse } = require('pdf-parse');
let falhas = 0;
async function textoDoPdf(rel) {
    if (!rel) return null;
    const abs = path.join(RAIZ_ARQ, rel);
    if (!fs.existsSync(abs)) return null;
    let parser;
    try {
        parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const r = await parser.getText();
        return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    } catch (e) {
        if (falhas++ < 3) console.error('  [pdf] ' + e.message);
        return null;
    } finally {
        try { if (parser) await parser.destroy(); } catch (_) {}
    }
}

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
            if (dif > 0) continue;                    // só desconto interessa aqui
            casos.push({ periodo, l, d, v, dif });
        }
    }

    console.log(`divergências com documento MENOR que o lançado: ${casos.length}\n`);

    let comTexto = 0, brutoBate = 0, fechaExato = 0, semTexto = 0, ehImagem = 0;
    let explicados = 0;
    const modo = {};
    const amostra = [];

    for (const c of casos) {
        const txt = await textoDoPdf(c.d.caminho || c.d.rel);
        if (!txt) { semTexto++; continue; }
        // PDF escaneado: pdf-parse devolve string quase vazia. Não é "não achou
        // retenção", é "não há texto" — só o OCR alcança este.
        if (txt.replace(/\s/g, '').length < 15) { ehImagem++; continue; }
        comTexto++;
        const t = norm(txt);
        const bruto = acha(t, RE_BRUTO);
        const liq = acha(t, RE_LIQ);
        const trib = tributos(t);
        const somaTrib = Object.values(trib).reduce((s, x) => s + x, 0);

        const bOk = bruto != null && Math.abs(bruto - c.l.valor) <= 0.02;
        if (bOk) brutoBate++;

        // A conta fecha no papel? Três formas, da mais forte à mais fraca:
        //
        //  (a) UM tributo isolado é exatamente o desconto — o caso ISSRF, o mais
        //      limpo (CORREA TRUCK, ARPSEG, KUHNEN).
        //  (b) a SOMA das retenções federais bate — A&D: 1,62+1,22+0,81+2,43+0,53
        //      = 6,61, exatamente o desconto. Aqui a nota retém vários tributos e
        //      nenhum sozinho explica.
        //  (c) o LÍQUIDO impresso é o valor do documento e o bruto impresso é o
        //      lançado: os dois números do papel confirmam a leitura sem precisar
        //      saber quais tributos compõem a diferença.
        //
        // ISSQN é excluído da soma: nas notas da ROCHA e da CONSEGMA ele vem com o
        // valor da BASE (17.000 = o próprio bruto), não do imposto. Somá-lo estoura.
        const desconto = -c.dif;
        const soUm = Object.entries(trib).some(([, x]) => Math.abs(x - desconto) <= 0.02);
        const somaFed = Object.entries(trib)
            .filter(([k]) => k !== 'ISSQN' && Math.abs(trib[k] - c.l.valor) > 0.02)
            .reduce((s, [, x]) => s + x, 0);
        const somaOk = somaFed > 0 && Math.abs(somaFed - desconto) <= 0.02;
        const liqOk = liq != null && Math.abs(liq - c.v) <= 0.02 && bOk;
        const trOk = soUm || somaOk || liqOk;
        if (bOk && trOk) fechaExato++;
        if (trOk) explicados++;
        modo[soUm ? '(a) um tributo isolado' : somaOk ? '(b) soma das retencoes'
             : liqOk ? '(c) bruto+liquido impressos' : 'nao explicado'] =
            (modo[soUm ? '(a) um tributo isolado' : somaOk ? '(b) soma das retencoes'
             : liqOk ? '(c) bruto+liquido impressos' : 'nao explicado'] || 0) + 1;

        if (amostra.length < 25) amostra.push({ c, bruto, liq, trib, bOk, trOk, desconto });
    }

    console.log(`texto lido do PDF: ${comTexto}   PDF é imagem (só OCR lê): ${ehImagem}   ilegível/ausente: ${semTexto}`);
    console.log(`o BRUTO do papel bate com a planilha:            ${brutoBate} de ${comTexto}`);
    console.log(`bruto bate E um tributo explica a diferença:     ${fechaExato} de ${comTexto}`);
    console.log(`EXPLICADOS por retenção lida no papel:           ${explicados} de ${casos.length} ` +
        `(${(explicados / casos.length * 100).toFixed(1)}% dos descontos)\n`);
    console.log('por forma de explicação:');
    for (const [k, n] of Object.entries(modo).sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log('');

    console.log('AMOSTRA:');
    for (const a of amostra) {
        console.log(`  ${String(a.c.l.entidade).slice(0, 22).padEnd(22)} NF ${String(a.c.l.nf).padEnd(8)} ` +
            `pl ${a.c.l.valor.toFixed(2).padStart(10)}  doc ${a.c.v.toFixed(2).padStart(10)}  desc ${a.desconto.toFixed(2).padStart(9)}`);
        console.log(`      bruto no papel: ${a.bruto ?? '—'}  ${a.bOk ? '(BATE)' : ''}   liquido: ${a.liq ?? '—'}`);
        console.log(`      tributos: ${JSON.stringify(a.trib)}  ${a.trOk ? '<< EXPLICA' : ''}`);
    }
    process.exit(0);
})();
