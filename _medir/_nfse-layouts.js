/**
 * _medir/_nfse-layouts.js — que rótulos as NFS-e que o parser NÃO lê usam?
 *
 * `_nfse-sem-retencao.js` isolou 21 notas que declaram retenção e nas quais o
 * parser não achou bruto NEM líquido, mais 17 em que achou só um dos dois. Antes
 * de inventar regex nova, é preciso ver o que está ESCRITO nesses papéis: a NFS-e
 * não tem layout nacional, cada município emite o seu.
 *
 * Não propõe regra. Imprime o texto ao redor dos números, agrupado por emitente,
 * para a decisão vir do que a amostra mostra — o mesmo método que achou o `IR` e o
 * `TOTAL TRIB. FEDERAIS` da GENUSCLIN.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA_MES = process.argv[2] || '2026.03.EXTRATOS CONTABILIDADE';

function internasRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname',
        `${src.slice(0, corte)} return { retencaoDoParser };`);
    return f(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

const norm = s => String(s || '').toUpperCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const num = s => {
    if (s == null || s === '—') return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
};

async function texto(abs) {
    let pr;
    try {
        pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const r = await pr.getText();
        return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    } catch (e) { return null; }
    finally { try { if (pr) await pr.destroy(); } catch (_) {} }
}
function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(p, out);
        else if (/\.pdf$/i.test(e.name)) out.push(p);
    }
    return out;
}

// Todo rótulo seguido de valor monetário, para ver o vocabulário real do papel.
const RE_ROTULO_VALOR = /([A-Z][A-Z .\/()-]{2,38}?)[:\s]+R?\$?\s*([\d.]{0,12}\d,\d{2})/g;

(async () => {
    const { retencaoDoParser } = internasRota();
    const raizMes = path.join(RAIZ_ARQ, PASTA_MES);
    const pdfs = listarPdfs(raizMes);

    const casos = [];
    for (const abs of pdfs) {
        const nome = path.basename(abs);
        const tx = await texto(abs);
        if (!tx || tx.replace(/\s/g, '').length < 15) continue;
        let cls; try { cls = parsers.classify(tx, nome); } catch (e) { continue; }
        if (cls.tipo !== 'NFS' || !cls.parser) continue;
        let campos; try { campos = cls.parser(tx); } catch (e) { continue; }
        if (retencaoDoParser(campos)) continue;              // já resolvida

        const t = norm(tx);
        const declara = /ISS\s*RETIDO|ISSRF|RETENCAO|RETIDO NA FONTE|IRRF|VALOR LIQUIDO/.test(t);
        const nega = /ISS\s*RETIDO[:\s]*NAO|RETIDO NA FONTE[:\s]*NAO|SEM RETENCAO|NAO RETIDO/.test(t);
        if (!declara || nega) continue;

        const bruto = num(campos['Valor do serviço']);
        const liq = num(campos['Valor líquido']);
        if (bruto != null && liq != null) continue;          // outro problema

        // Rótulos monetários presentes, para ver o vocabulário deste layout.
        const rotulos = [];
        let m; RE_ROTULO_VALOR.lastIndex = 0;
        while ((m = RE_ROTULO_VALOR.exec(t)) !== null) {
            const r = m[1].trim().replace(/^[^A-Z]+/, '');
            if (r.length >= 3) rotulos.push(`${r}=${m[2]}`);
        }
        casos.push({ nome, bruto, liq, rotulos: rotulos.slice(0, 14) });
    }

    console.log(`NFS-e que declaram retenção e o parser não fecha: ${casos.length}\n`);

    // Que rótulos aparecem nesses papéis, e com que frequência?
    const freq = {};
    for (const c of casos)
        for (const r of c.rotulos) {
            const k = r.split('=')[0];
            freq[k] = (freq[k] || 0) + 1;
        }
    console.log('RÓTULOS MONETÁRIOS mais comuns nestes documentos:');
    for (const [k, n] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30))
        console.log(`  ${String(n).padStart(4)}  ${k}`);

    console.log('\n─── AMOSTRA (o que cada papel mostra) ───');
    for (const c of casos.slice(0, 14)) {
        console.log(`\n${c.nome.slice(0, 70)}`);
        console.log(`  parser leu: bruto=${c.bruto ?? '—'}  líquido=${c.liq ?? '—'}`);
        console.log(`  rótulos: ${c.rotulos.join(' | ').slice(0, 300)}`);
    }
    process.exit(0);
})();
