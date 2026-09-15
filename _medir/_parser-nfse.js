/**
 * _medir/_parser-nfse.js — o parser novo de NFS-e lê o que promete?
 *
 * Roda `parseNfse` sobre os PDFs das divergências reais e confere a ARITMÉTICA
 * do próprio papel: bruto − soma das retenções = líquido. Se a conta fecha, os
 * três números foram lidos certo — não é opinião, é verificação.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { PDFParse } = require('pdf-parse');
const parsers = require('../routes/_nf-parsers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const num = s => {
    if (s == null || s === '—') return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
};
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

const RETIDOS = ['ISS retido', 'IRRF retido', 'INSS retido', 'CSLL retido', 'COFINS retido', 'PIS retido'];

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

    let ehNfs = 0, temBruto = 0, temLiq = 0, temRet = 0;
    let contaFecha = 0, brutoBateComPlanilha = 0, retExplicaDesconto = 0;
    const amostra = [], falhas = [];

    for (const c of casos) {
        const tx = await texto(c.d.caminho);
        if (!tx) continue;
        const cls = parsers.classify(tx, c.d.arquivo);
        if (cls.tipo !== 'NFS') continue;
        ehNfs++;
        const campos = cls.parser ? cls.parser(tx) : {};
        const bruto = num(campos['Valor do serviço']);
        const liq = num(campos['Valor líquido']);
        const rets = RETIDOS.map(k => num(campos[k])).filter(x => x != null);
        const somaRet = rets.reduce((s, x) => s + x, 0);

        if (bruto != null) temBruto++;
        if (liq != null) temLiq++;
        if (rets.length) temRet++;

        // A aritmética do papel: bruto − retenções = líquido.
        const fecha = bruto != null && liq != null && somaRet > 0
            && Math.abs(bruto - somaRet - liq) <= 0.02;
        if (fecha) contaFecha++;
        const bOk = bruto != null && Math.abs(bruto - c.l.valor) <= 0.02;
        if (bOk) brutoBateComPlanilha++;
        const rOk = somaRet > 0 && Math.abs(somaRet - c.desc) <= 0.02;
        if (rOk) retExplicaDesconto++;

        const reg = { c, bruto, liq, somaRet, fecha, bOk, rOk, campos };
        if (amostra.length < 14) amostra.push(reg);
        if (!rOk && !bOk && falhas.length < 20) falhas.push(reg);
    }

    console.log(`descontos analisados: ${casos.length}`);
    console.log(`classificados como NFS-e: ${ehNfs}\n`);
    console.log(`  leu o BRUTO (Valor do serviço): ${temBruto} de ${ehNfs}`);
    console.log(`  leu o LÍQUIDO:                  ${temLiq} de ${ehNfs}`);
    console.log(`  leu alguma RETENÇÃO:            ${temRet} de ${ehNfs}\n`);
    console.log(`  aritmética do papel fecha (bruto−ret=líq): ${contaFecha} de ${ehNfs}`);
    console.log(`  BRUTO lido bate com a PLANILHA:            ${brutoBateComPlanilha} de ${ehNfs}`);
    console.log(`  retenção lida EXPLICA o desconto:          ${retExplicaDesconto} de ${ehNfs}\n`);

    console.log('AMOSTRA:');
    for (const a of amostra) {
        console.log(`  ${String(a.c.l.entidade).slice(0, 24).padEnd(24)} NF ${String(a.c.l.nf).padEnd(8)} ` +
            `pl ${a.c.l.valor.toFixed(2).padStart(10)} doc ${a.c.v.toFixed(2).padStart(10)} desc ${a.c.desc.toFixed(2).padStart(8)}`);
        console.log(`     bruto=${a.bruto ?? '—'} liq=${a.liq ?? '—'} somaRet=${a.somaRet.toFixed(2)} ` +
            `${a.fecha ? '[CONTA FECHA]' : ''} ${a.bOk ? '[BRUTO=PLANILHA]' : ''} ${a.rOk ? '[RET=DESCONTO]' : ''}`);
    }
    if (falhas.length) {
        console.log('\nFALHAS (nem bruto nem retenção bateram):');
        for (const f of falhas)
            console.log(`  ${String(f.c.l.entidade).slice(0, 24).padEnd(24)} pl ${f.c.l.valor.toFixed(2)} ` +
                `desc ${f.c.desc.toFixed(2)} | ${JSON.stringify(f.campos)}`);
    }
    process.exit(0);
})();
