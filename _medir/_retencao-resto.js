/**
 * _medir/_retencao-resto.js — os 65 descontos que a retenção NÃO explicou são o quê?
 *
 * `_retencao-no-papel.js` explicou 45 de 110 lendo o próprio PDF. Antes de aceitar
 * esse número é preciso saber se os 65 restantes são (i) retenção que a regex não
 * pegou — e aí a regra deve melhorar — ou (ii) outro fenômeno, que não é assunto
 * desta regra. Confundir os dois leva a afrouxar a tolerância até "explicar" erro
 * de verdade, que é o pior desfecho possível.
 *
 * Para cada não explicado, imprime o percentual e um trecho do texto ao redor dos
 * rótulos de valor, para inspeção humana.
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

const RE_N = '([\\d.]{0,12}\\d,\\d{2})';
const paraNumero = s => { const n = Number(String(s).replace(/\./g, '').replace(',', '.')); return isFinite(n) && n > 0 ? n : null; };

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
            if (Math.abs(dif) < 0.005 || dif > 0) continue;
            if (razaoParcela(l.valor, v)) continue;
            casos.push({ l, d, v, desc: -dif, pc: -dif / l.valor * 100 });
        }
    }

    // Reaplica a mesma explicação de `_retencao-no-papel.js` para isolar o resto.
    const TRIB = ['ISSRF', 'ISSQN', 'IRRF', 'IR', 'INSS', 'CSLL', 'COFINS', 'PIS'];
    const resto = [];
    for (const c of casos) {
        const tx = await texto(c.d.caminho);
        const t = tx ? norm(tx) : '';
        const trib = {};
        for (const nm of TRIB) {
            const m = t.match(new RegExp(`\\b${nm}\\b[:\\s]*R?\\$?\\s*${RE_N}`));
            if (m) { const v = paraNumero(m[1]); if (v) trib[nm] = v; }
        }
        const soUm = Object.values(trib).some(x => Math.abs(x - c.desc) <= 0.02);
        const somaFed = Object.entries(trib).filter(([k]) => k !== 'ISSQN' && Math.abs(trib[k] - c.l.valor) > 0.02)
            .reduce((s, [, x]) => s + x, 0);
        const somaOk = somaFed > 0 && Math.abs(somaFed - c.desc) <= 0.02;
        if (soUm || somaOk) continue;
        resto.push({ ...c, temTexto: !!tx, trib, temISS: /ISS(RF|QN)?/.test(t), temRet: /RETEN|RETID/.test(t) });
    }

    console.log(`descontos: ${casos.length}   NÃO explicados: ${resto.length}\n`);
    const faixa = { '≤2%': 0, '2-6%': 0, '6-15%': 0, '15-50%': 0, '>50%': 0 };
    for (const r of resto)
        faixa[r.pc <= 2 ? '≤2%' : r.pc <= 6 ? '2-6%' : r.pc <= 15 ? '6-15%' : r.pc <= 50 ? '15-50%' : '>50%']++;
    console.log('não explicados por faixa de desconto:', faixa);
    console.log(`  destes, com texto legível: ${resto.filter(r => r.temTexto).length}`);
    console.log(`  com a palavra ISS no papel: ${resto.filter(r => r.temISS).length}`);
    console.log(`  com "RETENCAO/RETIDO":      ${resto.filter(r => r.temRet).length}\n`);

    resto.sort((a, b) => a.pc - b.pc);
    console.log('OS NÃO EXPLICADOS (ordenados por % do desconto):');
    for (const r of resto)
        console.log(`  ${r.pc.toFixed(2).padStart(6)}%  ${String(r.l.entidade).slice(0, 24).padEnd(24)} ` +
            `NF ${String(r.l.nf).padEnd(8)} pl ${r.l.valor.toFixed(2).padStart(10)} doc ${r.v.toFixed(2).padStart(10)} ` +
            `desc ${r.desc.toFixed(2).padStart(9)} ${r.temTexto ? '' : '[SEM TEXTO]'} ${JSON.stringify(r.trib)}`);
    process.exit(0);
})();
