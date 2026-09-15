/**
 * _medir/_razao-nf.js — o "erro" da leitura do total é erro, ou é o nome do
 * arquivo falando de outra coisa?
 *
 * Em `_total-nf.js` a leitura após o rótulo divergiu do valor do nome do arquivo
 * em 27 de 37 casos — mas as divergências pareciam MÚLTIPLOS exatos (999,42 vs
 * 249,86 = 4×; 4250,50 vs 425,05 = 10×). Se a razão for inteira na maioria, o
 * extrator está certo e o nome do arquivo traz a PARCELA/boleto, não o total.
 *
 * Isso decide o desenho: total da nota e valor lançado são CAMPOS DIFERENTES, e
 * gravar um no lugar do outro quebraria o comparador.
 *
 * Uso: node _medir/_razao-nf.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify, norm } = require('../routes/_nf-parsers');

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

const num = s => { const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const RE_N = '(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})';

(async () => {
    const quantos = Number(process.argv[2] || 200);
    const todos = [];
    varrer(RAIZ, todos);

    let lidos = 0, comparados = 0;
    const razoes = new Map();
    const naoInteiras = [];

    for (const p of todos) {
        if (lidos >= quantos) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        const base = path.basename(p);
        if (classify(text, base).tipo !== 'NF') continue;
        lidos++;

        const g = base.match(/-\s*(\d{1,3}(?:\.\d{3})*,\d{2})/);
        if (!g) continue;
        const nome = num(g[1]);
        const t = norm(text);
        const i = t.search(/VALOR TOTAL DA NOTA/);
        if (i < 0 || !nome) continue;
        const m = t.slice(i).match(new RegExp(RE_N));
        if (!m) continue;
        const lido = num(m[1]);
        if (!lido || !nome) continue;
        comparados++;

        const r = lido / nome;
        // arredonda para 2 casas para agrupar
        const chave = Math.abs(r - Math.round(r)) < 0.005 ? `${Math.round(r)}×` : r.toFixed(2) + '×';
        razoes.set(chave, (razoes.get(chave) || 0) + 1);
        if (Math.abs(r - Math.round(r)) >= 0.005 && naoInteiras.length < 12) {
            naoInteiras.push({ base, lido, nome, r: r.toFixed(3) });
        }
    }

    console.log(`${lidos} DANFEs lidos, ${comparados} com leitura E valor no nome.\n`);
    console.log('razão (valor lido no PDF ÷ valor no nome do arquivo):');
    const ord = [...razoes.entries()].sort((a, b) => b[1] - a[1]);
    let inteiras = 0;
    for (const [k, v] of ord) {
        const ehInt = /^\d+×$/.test(k);
        if (ehInt) inteiras += v;
        console.log(`  ${k.padStart(8)}  ${String(v).padStart(3)}  ${'█'.repeat(v)}${ehInt ? '' : '   ← não inteira'}`);
    }
    console.log(`\nrazão inteira: ${inteiras}/${comparados} (${(100 * inteiras / comparados).toFixed(1)}%)`);
    console.log('  1× = o nome traz o total da nota | N× = o nome traz a parcela/boleto\n');
    if (naoInteiras.length) {
        console.log('casos de razão NÃO inteira (candidatos a erro real de leitura):');
        for (const e of naoInteiras) console.log(`  ${e.base.slice(0, 58).padEnd(58)} lido ${String(e.lido).padStart(10)}  nome ${String(e.nome).padStart(9)}  r=${e.r}`);
    }
})();
