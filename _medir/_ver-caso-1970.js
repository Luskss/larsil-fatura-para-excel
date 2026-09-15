/**
 * _medir/_ver-caso-1970.js — o que a IA estava lendo quando devolveu 31/12/1970?
 *
 * Pergunta do usuário (11/09/2026): o problema não é talvez o PROMPT?
 *
 * A pergunta é boa porque a trava que eu acabei de pôr (`dataPlausivel`) FILTRA a
 * data ruim mas não a impede. Se o prompt está pedindo algo que a IA não consegue
 * entregar, o campo fica vazio — e vazio também é perda, só mais honesta.
 *
 * Fica em `_medir/` e não no scratchpad porque `require` resolve pela pasta do
 * script: de fora do projeto, `require('pdf-parse')` falha (é o que o cabeçalho de
 * `harness.js` já avisa).
 */
'use strict';
const h = require('./harness');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const ALVO = process.argv[2] || 'CM 453-LAR-VENC 27.08.2026';
const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const achados = [];
(function anda(d) {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const x of e) {
        const q = path.join(d, x.name);
        if (x.isDirectory()) anda(q);
        else if (x.name.includes(ALVO)) achados.push(q);
    }
})(raiz);

(async () => {
    console.log(`arquivos contendo "${ALVO}": ${achados.length}`);
    if (!achados.length) { process.exit(0); }
    const abs = achados[0];
    console.log(`lendo: ${path.basename(abs)}`);
    console.log(`pasta: ${path.relative(raiz, abs).split(path.sep)[0]}\n`);

    const pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
    const r = await pr.getText(); await pr.destroy();
    const txt = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    console.log(`páginas: ${r.total}   caracteres: ${txt.replace(/\s/g, '').length}`);

    const datas = txt.match(/\d{2}[\/.\-]\d{2}[\/.\-]\d{2,4}/g) || [];
    console.log(`\ndatas no texto (${datas.length} ocorrências, ${new Set(datas).size} distintas):`);
    console.log('   ' + [...new Set(datas)].slice(0, 24).join('   '));

    console.log('\ncontexto dos rótulos de data:');
    const up = txt.toUpperCase();
    for (const rot of ['EMISS', 'VIGÊNCIA', 'VIGENCIA', 'VENCIMENTO', 'APÓLICE', 'APOLICE', 'PARCELA', 'PROPOSTA']) {
        let i = up.indexOf(rot);
        if (i < 0) continue;
        console.log(`   [${rot}] ...${txt.slice(Math.max(0, i - 45), i + 95).replace(/\s+/g, ' ')}...`);
    }

    console.log('\nprimeiros 700 caracteres do papel:');
    console.log(txt.replace(/\s+/g, ' ').slice(0, 700));
    process.exit(0);
})();
