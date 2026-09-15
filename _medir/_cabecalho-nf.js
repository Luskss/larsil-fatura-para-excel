/**
 * _medir/_cabecalho-nf.js — testa a hipótese: no DANFE o rótulo "VALOR TOTAL DA
 * NOTA" fica numa linha de CABEÇALHO e o número vem numa linha SEGUINTE, na
 * mesma posição ordinal da coluna. Se for verdade, dá para ler o total contando
 * a posição do rótulo entre os rótulos da linha e pegando o n-ésimo número da
 * linha de valores — sem depender de o rótulo estar colado ao número.
 *
 * Uso: node _medir/_cabecalho-nf.js [quantos]
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

// Os rótulos do quadro "CÁLCULO DO IMPOSTO" do DANFE, na ordem em que a ANP os
// define. Cada um vira uma coluna; o número correspondente aparece na linha de
// valores na MESMA posição ordinal.
const ROTULOS = [
    'VALOR TOTAL DA NOTA', 'VALOR TOTAL DOS PRODUTOS', 'VALOR DO FRETE',
    'VALOR DO SEGURO', 'DESCONTO', 'OUTRAS DESPESAS', 'VALOR DO IPI',
    'VALOR DO ICMS', 'BASE DE CALCULO', 'VALOR DO PIS', 'VALOR DO COFINS',
    'VALOR ICMS SUBST', 'TOTAL DOS TRIBUTOS', 'VALOR APROX',
];

const RE_NUM = /(?<![\d.,])(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?![\d])/g;

(async () => {
    const quantos = Number(process.argv[2] || 8);
    const todos = [];
    varrer(RAIZ, todos);
    let vistos = 0, mostrados = 0;

    for (const p of todos) {
        if (mostrados >= quantos) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        if (classify(text, path.basename(p)).tipo !== 'NF') continue;
        vistos++;
        // procura linha que tenha "VALOR TOTAL DA NOTA" e NENHUM número
        const linhas = text.split('\n');
        const i = linhas.findIndex(l => /VALOR TOTAL DA NOTA/.test(norm(l)) && !/\d,\d{2}/.test(l));
        if (i < 0) continue;
        mostrados++;

        const cab = norm(linhas[i]);
        // quais rótulos aparecem nesta linha, na ordem de posição no texto
        const cols = ROTULOS.filter(r => cab.includes(r))
            .map(r => ({ rot: r, pos: cab.indexOf(r) }))
            .sort((a, b) => a.pos - b.pos);
        const idxNota = cols.findIndex(c => c.rot === 'VALOR TOTAL DA NOTA');

        // a linha de valores: a próxima linha que seja (quase) só números
        let j = -1;
        for (let k = i + 1; k < Math.min(linhas.length, i + 6); k++) {
            const nums = String(linhas[k]).match(RE_NUM) || [];
            if (nums.length >= 2) { j = k; break; }
        }
        const nums = j >= 0 ? (linhas[j].match(RE_NUM) || []) : [];

        console.log(`\n${'─'.repeat(96)}\n${path.basename(p)}`);
        console.log(`  cabeçalho: ${cab.slice(0, 100)}`);
        console.log(`  colunas   : ${cols.map(c => c.rot).join(' | ')}`);
        console.log(`  "TOTAL DA NOTA" é a coluna nº ${idxNota + 1} de ${cols.length}`);
        console.log(`  valores   : ${nums.join('  ')}   (${nums.length} números)`);
        console.log(`  → pela posição daria: ${nums[idxNota] ?? '(fora do alcance)'}`);
        const noNome = path.basename(p).match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
        console.log(`  valor no NOME do arquivo: ${noNome ? noNome[1] : '—'}`);
    }
    console.log(`\n\n${mostrados} casos de ${vistos} DANFEs lidos.`);
})();
