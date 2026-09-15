/**
 * _medir/_forma-de-um.js — roda o pipeline atual (analyzePdf, o mesmo que o
 * reprocesso usa) num único PDF e imprime o dados_parser que ele PRODUZ agora.
 *
 * A pergunta: as 190 linhas de março com "itens" minúsculo (que deixam o modal de
 * detalhe vazio, porque a tela lê "Itens") são legado de uma versão antiga do
 * código, ou o código de hoje ainda as produz? Comparar esta saída com o que está
 * gravado no banco responde sem adivinhação.
 *
 * Uso: node _medir/_forma-de-um.js "<caminho completo do PDF>" [--ia]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

(async () => {
    const alvo = process.argv[2];
    if (!alvo) { console.error('uso: node _medir/_forma-de-um.js "<caminho do PDF>" [--ia]'); process.exit(1); }
    if (!fs.existsSync(alvo)) { console.error('não existe:', alvo); process.exit(1); }
    const comIA = process.argv.includes('--ia');

    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const corte = src.indexOf('async function processFolderAuto');
    const f = new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return { analyzePdf };
    `);
    const req = require('module').createRequire(path.join(RAIZ, 'routes', 'x.js'));
    const { analyzePdf } = f(req, { exports: {} }, {}, path.join(RAIZ, 'routes'));

    const pdf = { name: path.basename(alvo), path: alvo, folder: path.basename(path.dirname(alvo)) };
    console.log(`arquivo: ${pdf.name}`);
    console.log(`modo   : ${comIA ? 'forceAI' : 'parser local'}\n`);

    const rows = await analyzePdf(pdf, comIA ? { forceAI: true } : {});
    for (const row of rows) {
        console.log(`— row: ${row.arquivo}  (tipo ${row.tipo}, origem ${row.origem})`);
        let d = null;
        try { d = JSON.parse(row.dados_parser || 'null'); } catch (_) {}
        if (!d) { console.log('  dados_parser vazio/inválido'); continue; }
        const mai = Array.isArray(d['Itens']) && d['Itens'].length;
        const min = Array.isArray(d['itens']) && d['itens'].length;
        console.log(`  "Itens" (maiúsculo, a tela lê): ${mai ? mai + ' item(ns)' : 'ausente'}`);
        console.log(`  "itens" (minúsculo, a tela NÃO lê): ${min ? min + ' item(ns)' : 'ausente'}`);
        console.log(`  chaves: ${Object.keys(d).join(', ')}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
