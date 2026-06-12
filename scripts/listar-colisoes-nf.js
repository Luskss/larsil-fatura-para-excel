/**
 * scripts/listar-colisoes-nf.js
 * Lista NFs que aparecem na planilha Delsoft com MAIS DE UM emitente diferente
 * (cenário típico de NFS-e municipal, cuja numeração reseta por CNPJ).
 * Esses são exatamente os casos em que o guard de entidade em comparar-notas atua.
 *
 * Uso:
 *   node scripts/listar-colisoes-nf.js            # todas as colisões
 *   node scripts/listar-colisoes-nf.js 05 2026    # só lançamentos do período
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// .env loader manual (projeto não usa dotenv)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
}

const planilhaPath = process.env.PLANILHA_PATH;
if (!planilhaPath || !fs.existsSync(planilhaPath)) {
    console.error('PLANILHA_PATH inválida:', planilhaPath);
    process.exit(1);
}

const mesArg = process.argv[2] ? String(process.argv[2]).padStart(2, '0') : null;
const anoArg = process.argv[3] ? String(process.argv[3]) : null;

const wb = XLSX.readFile(planilhaPath, { cellDates: false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
const header = rows[1] || [];

const idxNF        = header.indexOf('NF');
const idxEnt       = header.indexOf('ENTIDADE');
const idxValor     = header.indexOf('VL_TOTAL_CAB');
const idxOrig      = header.indexOf('ORIG');
const idxLancamento = header.indexOf('DT_LANCAMENTO');
const idxEmissao   = header.indexOf('DT_EMISSAO');

function excelMesAno(serial) {
    if (!serial || typeof serial !== 'number') return null;
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

const porNF = new Map(); // nfClean -> Map<entidadeNorm, {entidadeOriginal, totalValor, ocorrencias}>

for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    if (String(row[idxOrig] || '').trim().toUpperCase() !== 'CP') continue;

    if (mesArg && anoArg) {
        const periodo = excelMesAno(row[idxLancamento]) || excelMesAno(row[idxEmissao]);
        if (periodo !== `${mesArg}.${anoArg}`) continue;
    }

    const nfRaw = String(row[idxNF] || '').trim();
    if (!nfRaw) continue;
    const nfClean = nfRaw.replace(/^[A-Za-z]+/, '').replace(/^0+/, '') || nfRaw;

    const entidade = String(row[idxEnt] || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!entidade) continue;

    if (!porNF.has(nfClean)) porNF.set(nfClean, new Map());
    const bucket = porNF.get(nfClean);
    if (!bucket.has(entidade)) {
        bucket.set(entidade, { entidade, valor: 0, n: 0 });
    }
    const e = bucket.get(entidade);
    e.valor += parseFloat(row[idxValor] || 0) || 0;
    e.n += 1;
}

const colisoes = [...porNF.entries()]
    .filter(([, bucket]) => bucket.size > 1)
    .sort((a, b) => b[1].size - a[1].size);

console.log(`Planilha: ${planilhaPath}`);
console.log(`Filtro: ${mesArg && anoArg ? `${mesArg}.${anoArg}` : '(todos os meses)'}`);
console.log(`Total de colisões: ${colisoes.length}\n`);

for (const [nf, bucket] of colisoes) {
    console.log(`NF ${nf}  (${bucket.size} emitentes):`);
    for (const e of bucket.values()) {
        console.log(`  • ${e.entidade.padEnd(60)}  R$ ${Math.abs(e.valor).toFixed(2).padStart(12)}  (${e.n} lanç.)`);
    }
    console.log('');
}
