/* Busca todas as linhas da planilha Delsoft onde NF = alvo. */
'use strict';
// Carrega .env manualmente (evita dependência de dotenv).
const fs = require('fs');
try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
} catch (_) {}
const XLSX = require('xlsx');
const path = process.env.PLANILHA_PATH;
const alvo = (process.argv[2] || '113462').trim();

if (!path) { console.error('PLANILHA_PATH não definida'); process.exit(1); }

const wb = XLSX.readFile(path, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
const h = rows[1] || [];

const cols = ['ORIG','CD_FILIAL','FILIAL','NF','DT_EMISSAO','DT_LANCAMENTO','DT_VENCIMENTO','CD_ENTID','ENTIDADE','TIPO','VL_TOTAL_CAB','VL_ITEM','LANC_ORIG'];
const idx = Object.fromEntries(cols.map(c => [c, h.indexOf(c)]));

function excelDate(s) {
    if (typeof s !== 'number') return s || '';
    const d = new Date(Math.round((s - 25569) * 86400 * 1000));
    return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
}

console.log(`Procurando NF="${alvo}" na planilha (${path})`);
console.log(`Total de linhas: ${rows.length}\n`);

let achados = 0;
for (let i = 2; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const nf = String(r[idx.NF] || '').trim();
    if (nf !== alvo) continue;
    achados++;
    const obj = {};
    for (const c of cols) {
        let v = r[idx[c]];
        if (/^DT_/.test(c)) v = excelDate(v);
        obj[c] = v;
    }
    console.log(`#${achados} linha ${i+1}:`, obj);
}
console.log(`\nTotal achados: ${achados}`);
