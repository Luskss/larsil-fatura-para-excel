/**
 * _medir/_total-nf.js — qual estratégia acha o VALOR TOTAL DA NOTA sem errar.
 *
 * A hipótese posicional (contar colunas do cabeçalho) foi REPROVADA em
 * `_cabecalho-nf.js`: a extração embaralha rótulos e números, e a coluna nº 5
 * devolvia 3,15 onde o valor real era 842,31.
 *
 * Aqui as candidatas são medidas contra um gabarito INDEPENDENTE: o valor que o
 * arquivista escreveu no NOME DO ARQUIVO ("020.DOC- 842,31 - ..."), que é o
 * valor lançado e conferido por gente. Não é o total da nota em 100% dos casos
 * (nota parcial, boleto de parcela), mas é o único gabarito em escala que temos.
 *
 * Uso: node _medir/_total-nf.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify, norm } = require('../routes/_nf-parsers');
const { extrairItens } = require('../routes/_nf-itens');

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

// ── candidatas ───────────────────────────────────────────────────────────────

// A) rótulo colado ao número (o que o código tem hoje)
function colado(t) {
    const m = t.match(new RegExp(`VALOR TOTAL DA NOTA[:\\s]*R?\\$?\\s*${RE_N}`));
    return m ? num(m[1]) : null;
}

// B) primeiro número DEPOIS do rótulo, saltando até 200 chars de outros rótulos
function apos(t) {
    const i = t.search(/VALOR TOTAL DA NOTA/);
    if (i < 0) return null;
    const m = t.slice(i).match(new RegExp(RE_N));
    return m ? num(m[1]) : null;
}

// C) "VALOR TOTAL: R$ X" do canhoto — a frase "RECEBEMOS DE ... VALOR TOTAL: X"
function canhoto(t) {
    const m = t.match(new RegExp(`VALOR TOTAL[:\\s]*R?\\$?\\s*${RE_N}`));
    return m ? num(m[1]) : null;
}

// D) NFS-e: valor líquido / total dos serviços
function servico(t) {
    for (const re of [
        `VALOR LIQUIDO DA NFS-?E[:\\s]*R?\\$?\\s*${RE_N}`,
        `VALOR TOTAL DOS SERVICOS[:\\s]*R?\\$?\\s*${RE_N}`,
        `VALOR LIQUIDO[:\\s]*R?\\$?\\s*${RE_N}`,
    ]) { const m = t.match(new RegExp(re)); if (m) return num(m[1]); }
    return null;
}

// E) soma dos itens extraídos
function somaItens(text) {
    const its = extrairItens(text);
    if (!its.length) return null;
    const s = its.reduce((a, i) => a + (i.valorTotal || 0), 0);
    return s > 0 ? Math.round(s * 100) / 100 : null;
}

const ESTRATEGIAS = [
    ['A colado (hoje)', (t) => colado(t.n)],
    ['B após rótulo',   (t) => apos(t.n)],
    ['C canhoto',       (t) => canhoto(t.n)],
    ['D serviço',       (t) => servico(t.n)],
    ['E soma itens',    (t) => somaItens(t.bruto)],
];

(async () => {
    const quantos = Number(process.argv[2] || 150);
    const todos = [];
    varrer(RAIZ, todos);

    const acc = ESTRATEGIAS.map(([nome]) => ({ nome, achou: 0, bate: 0, erra: 0 }));
    let comGabarito = 0, lidos = 0;
    const errosB = [];

    for (const p of todos) {
        if (lidos >= quantos) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        const base = path.basename(p);
        if (classify(text, base).tipo !== 'NF') continue;
        lidos++;

        const g = base.match(/-\s*(\d{1,3}(?:\.\d{3})*,\d{2})/);
        const gab = g ? num(g[1]) : null;
        if (gab == null) continue;
        comGabarito++;

        const ctx = { n: norm(text), bruto: text };
        ESTRATEGIAS.forEach(([nome, fn], k) => {
            let v = null;
            try { v = fn(ctx); } catch (_) {}
            if (v == null) return;
            acc[k].achou++;
            if (Math.abs(v - gab) <= 0.02) acc[k].bate++;
            else { acc[k].erra++; if (nome.startsWith('B') && errosB.length < 8) errosB.push({ base, v, gab }); }
        });
    }

    console.log(`${lidos} DANFEs lidos, ${comGabarito} com valor no nome do arquivo (gabarito).\n`);
    console.log('estratégia         achou        bate c/ gabarito     erra');
    for (const a of acc) {
        const pAchou = comGabarito ? (100 * a.achou / comGabarito).toFixed(1) : '0';
        const pBate = a.achou ? (100 * a.bate / a.achou).toFixed(1) : '0';
        console.log(`  ${a.nome.padEnd(16)} ${String(a.achou).padStart(4)} (${pAchou.padStart(5)}%)   ${String(a.bate).padStart(4)} (${pBate.padStart(5)}% do achado)   ${String(a.erra).padStart(4)}`);
    }
    console.log('\nerros da B (após rótulo) — onde ela diverge do nome do arquivo:');
    for (const e of errosB) console.log(`  ${e.base.slice(0, 62).padEnd(62)} leu ${e.v}  vs nome ${e.gab}`);
})();
