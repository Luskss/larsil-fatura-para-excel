/**
 * _medir/_texto-do-pdf.js — o texto nativo de um PDF, como o pipeline o vê.
 *
 * Para a NFS 886 da DALIANI: a linha do banco não tem `Itens` e traz
 * `Nº da NFS-e = "02"` onde o nome diz 886. Antes de culpar o extrator de itens,
 * ver o texto — são 9 páginas ("NFS 886 + AUT"), e pacote de nota + autorização é
 * exatamente onde o parser pode ancorar no documento errado
 * ([[acessorio-nao-separa-do-fiscal]]).
 *
 * Uso: node _medir/_texto-do-pdf.js "trecho do nome" [--tudo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
// pdf-parse 2.x: classe `PDFParse`, não função — é a forma que `process-folder.js` usa.
const { PDFParse } = require('pdf-parse');

const TRECHO = process.argv[2];
const TUDO = process.argv.includes('--tudo');
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

(async () => {
    let achado = null;
    (function anda(d) {
        if (achado) return;
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) {
            if (achado) return;
            const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q);
            else if (x.name.includes(TRECHO)) achado = q;
        }
    })(RAIZ_ARQ);

    if (!achado) { console.log('não achei no disco:', TRECHO); process.exit(1); }
    console.log('arquivo:', achado, '\n');

    const buf = fs.readFileSync(achado);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const r = await parser.getText();
    try { await parser.destroy(); } catch (_) {}
    const txt = String(r.text || '');
    const nPag = r.total || (Array.isArray(r.pages) ? r.pages.length : 1);
    console.log(`páginas=${nPag}  caracteres=${txt.length}` +
        `  sem espaços=${txt.replace(/\s/g, '').length}\n`);

    // Separa por página usando o marcador do pdf-parse, se houver.
    const paginas = txt.split(/-{2}\s*\d+\s*of\s*\d+\s*-{2}/i).filter(s => s.trim());
    console.log(`blocos por marcador: ${paginas.length}\n`);

    if (TUDO) { console.log(txt); process.exit(0); }

    paginas.forEach((p, i) => {
        const c = p.replace(/\s/g, '').length;
        console.log('─'.repeat(70));
        console.log(`PÁGINA ${i + 1}  (${c} chars sem espaço)`);
        console.log(p.trim().slice(0, 900));
    });
    process.exit(0);
})();
