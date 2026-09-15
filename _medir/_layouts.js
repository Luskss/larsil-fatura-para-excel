/**
 * _medir/_layouts.js — quantos DANFEs do arquivo têm cada âncora de extração.
 * Mede a viabilidade ANTES de escrever regex: qual fração traz chave de acesso,
 * bloco de produtos, CFOP, e quantos itens dá para contar por ancoragem no NCM.
 *
 * Uso: node _medir/_layouts.js [quantosPDFs]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');

const env = {};
for (const linha of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
}
const RAIZ = env.ARQUIVO_PATH || env.MONITOR_PATH;

function varrer(dir, saida, prof = 0) {
    if (prof > 4) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// NCM: 8 dígitos. É a âncora mais estável da linha de item — todo produto tem um,
// e ele não se confunde com valores (que trazem vírgula) nem com CFOP (4 dígitos).
const RE_NCM = /(?<![\d.,])(\d{8})(?![\d.,])/;
const RE_CFOP = /(?<![\d.,])([1-7][._]?\d{3})(?![\d,])/;

(async () => {
    const limite = Number(process.argv[2] || 400);
    const todos = [];
    varrer(RAIZ, todos);
    for (let i = todos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [todos[i], todos[j]] = [todos[j], todos[i]];
    }

    const c = {
        lidos: 0, danfe: 0, chave: 0, blocoProduto: 0, cfop: 0,
        cabecalhoCanonico: 0, linhasComNcm: 0, totalNota: 0, cnpjEmit: 0, nomeEmit: 0,
    };
    const semBloco = [];

    for (const p of todos) {
        if (c.danfe >= limite) break;
        let text = '';
        try {
            const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(p)) });
            const r = await parser.getText();
            text = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
            await parser.destroy();
        } catch (_) { continue; }
        c.lidos++;
        const T = norm(text);
        if (!/DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL/.test(T)) continue;
        c.danfe++;

        if (/(?<!\d)(?:\d[\s]*){44}(?!\d)/.test(text)) c.chave++;
        if (/VALOR TOTAL DA NOTA/.test(T)) c.totalNota++;
        if (/\bCNPJ/.test(T)) c.cnpjEmit++;
        if (/(?:NOME|RAZAO SOCIAL)/.test(T)) c.nomeEmit++;

        const iBloco = T.search(/DADOS DO PRODUTO\s*\/?\s*SERVI/);
        if (iBloco < 0) { semBloco.push(path.basename(p)); continue; }
        c.blocoProduto++;

        const bloco = text.slice(iBloco, iBloco + 4000);
        const B = norm(bloco);
        if (RE_CFOP.test(B)) c.cfop++;
        // cabeçalho canônico: COD ... NCM ... CFOP na MESMA linha, na ordem esperada
        if (/C[OÓ]D.*(?:DESCRI).*NCM.*CFOP/.test(B.split('\n')[1] || '')) c.cabecalhoCanonico++;
        const nLinhas = bloco.split('\n').filter(l => RE_NCM.test(l) && /\d+,\d{2}/.test(l)).length;
        if (nLinhas > 0) c.linhasComNcm++;
    }

    const pct = n => c.danfe ? `${(n * 100 / c.danfe).toFixed(1)}%` : '—';
    console.log(`\nPDFs lidos: ${c.lidos}   DANFEs: ${c.danfe}\n`);
    console.log(`  chave de acesso (44 díg)     ${String(c.chave).padStart(4)}  ${pct(c.chave)}`);
    console.log(`  "VALOR TOTAL DA NOTA"        ${String(c.totalNota).padStart(4)}  ${pct(c.totalNota)}`);
    console.log(`  bloco DADOS DO PRODUTO       ${String(c.blocoProduto).padStart(4)}  ${pct(c.blocoProduto)}`);
    console.log(`  CFOP no bloco                ${String(c.cfop).padStart(4)}  ${pct(c.cfop)}`);
    console.log(`  cabeçalho canônico           ${String(c.cabecalhoCanonico).padStart(4)}  ${pct(c.cabecalhoCanonico)}`);
    console.log(`  ≥1 linha ancorável no NCM    ${String(c.linhasComNcm).padStart(4)}  ${pct(c.linhasComNcm)}`);
    if (semBloco.length) {
        console.log(`\n  ${semBloco.length} DANFEs sem bloco de produto, ex.:`);
        for (const n of semBloco.slice(0, 5)) console.log(`    ${n}`);
    }
})();
