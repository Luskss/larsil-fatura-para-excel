/**
 * _medir/_danfe-amostra.js — coleta texto bruto de DANFEs reais do arquivo.
 * Uso: node _medir/_danfe-amostra.js [quantos]
 * Grava os textos em _medir/_amostra/*.txt para calibrar as regex de itens/CFOP.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');

// .env manual — não há dotenv no projeto
const env = {};
for (const linha of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
}
const RAIZ = env.ARQUIVO_PATH || env.MONITOR_PATH;

function varrer(dir, saida, prof = 0) {
    if (prof > 4) return;
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entradas) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

(async () => {
    const quantos = Number(process.argv[2] || 12);
    const todos = [];
    varrer(RAIZ, todos);
    console.log(`${todos.length} PDFs no arquivo`);

    const destino = path.join(__dirname, '_amostra');
    fs.mkdirSync(destino, { recursive: true });

    let achados = 0, lidos = 0;
    // embaralha para não pegar só uma pasta
    for (let i = todos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [todos[i], todos[j]] = [todos[j], todos[i]];
    }

    for (const p of todos) {
        if (achados >= quantos) break;
        lidos++;
        let text = '';
        try {
            const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(p)) });
            const r = await parser.getText();
            text = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
            await parser.destroy();
        } catch (_) { continue; }

        const T = text.toUpperCase();
        // só DANFE de produto: é onde vivem CFOP e itens
        if (!/DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL/.test(T)) continue;
        achados++;
        const nome = String(achados).padStart(2, '0') + '_' + path.basename(p).replace(/[^\w.-]/g, '_') + '.txt';
        fs.writeFileSync(path.join(destino, nome), text, 'utf8');
        console.log(`[${achados}] ${path.basename(p)}  (${text.length} chars)`);
    }
    console.log(`\nlidos ${lidos} para achar ${achados} DANFEs → _medir/_amostra/`);
})();
