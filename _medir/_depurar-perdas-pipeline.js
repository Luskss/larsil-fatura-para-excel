/**
 * _medir/_depurar-perdas-pipeline.js — por que o pipeline perdeu 6 e zerou 5?
 *
 * `_validar-pipeline-valor.js --local` mostrou dois defeitos que as medições em cima
 * do banco NÃO mostravam (elas testavam a decisão, não o pipeline):
 *
 *   (a) 5 documentos que tinham valor ficaram com `null`
 *   (b) 1.653,04 virou 653,04 — leitura de SUFIXO, o erro clássico que
 *       `valorDoNomeArquivo` documenta ("3505,50" → 505,50)
 *
 * (b) é grave: valor errado por um fator de 1.000, com cara de certo.
 *
 * Este script roda `analyzePdf` nos casos citados e mostra o `dados_parser` inteiro,
 * antes e depois, para achar a origem de cada um.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const V = require('../routes/_valor-do-pagamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const ALVOS = [
    '012.DOC- 1653,04 - 2026.01.22',      // suffix: 1653,04 → 653,04
    '007.DOC- 355,49 - 2026.01.03',       // virou null
    '095.DOC- 393,30 - 2026.01.12',       // virou null
    '009.DOC- 762,00-2026.02.02',         // 762 → 3048
];
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

(async () => {
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');
    const antes = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const b = path.basename(String(x.arquivo));
            if (!antes.has(b)) antes.set(b, x);
        }

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const m = src.match(/const RE_NUM_NOME =[\s\S]*?\n\}/);
    const numeroDoNomeArquivo = new Function(`${m[0]}; return numeroDoNomeArquivo;`)();

    for (const alvo of ALVOS) {
        const nome = [...idx.keys()].find(k => k.includes(alvo));
        console.log('═'.repeat(74));
        if (!nome) { console.log(`(não achei) ${alvo}`); continue; }
        const abs = idx.get(nome);
        const g = j.gabaritos(nome);
        console.log(nome.slice(0, 68));
        console.log(`   gabarito=${g.valor}   número do nome=${numeroDoNomeArquivo(nome)}`);

        const linhaAntes = antes.get(nome);
        if (linhaAntes) {
            let pd = null; try { pd = JSON.parse(linhaAntes.dados_parser || 'null'); } catch (_) {}
            const nums = Object.entries(pd || {})
                .filter(([k]) => k !== 'Itens')
                .map(([k, v]) => [k, V.paraNumero(v)]).filter(([, v]) => v != null);
            console.log(`   ANTES (origem=${linhaAntes.origem}): ` +
                nums.map(([k, v]) => `${k}=${v}`).join('  '));
        }

        // O texto e o que a âncora faz com ele
        const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const res = await p.getText();
        try { await p.destroy(); } catch (_) {}
        const text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        const num = numeroDoNomeArquivo(nome);
        console.log(`   âncora devolve: ${V.valorPelaAncora(text, num)}`);

        if (num) {
            const d = String(num).replace(/\D/g, '');
            let from = 0, n = 0;
            while (n < 3) {
                const i = text.indexOf(d, from);
                if (i < 0) break;
                from = i + d.length;
                if (/\d/.test(text[i - 1] || ' ') || /\d/.test(text[i + d.length] || ' ')) continue;
                console.log(`   ── contexto ${++n}: ` +
                    JSON.stringify(text.slice(i, i + 150).replace(/\s+/g, ' ')));
            }
            if (!n) console.log('   (número não encontrado isolado no texto)');
        }

        const rows = await pf.analyzePdf({ path: abs, name: nome, folder: linhaAntes?.pasta || '' }, {});
        let novo = null; try { novo = JSON.parse(rows[0].dados_parser || 'null'); } catch (_) {}
        const nums2 = Object.entries(novo || {})
            .filter(([k]) => k !== 'Itens')
            .map(([k, v]) => [k, V.paraNumero(v)]).filter(([, v]) => v != null);
        console.log(`   DEPOIS: ` + nums2.map(([k, v]) => `${k}=${v}`).join('  '));
        console.log(`   Origem do valor pago = ${JSON.stringify(novo && novo['Origem do valor pago'])}`);
    }
    process.exit(0);
})();
