/**
 * _medir/_onde-estao.js — os 6.532 documentos do banco que o scan não alcança
 * estão FISICAMENTE fora do SANTANDER, ou estão lá dentro e o scan é que não os vê?
 *
 * A conclusão anterior saiu da coluna `pasta` do CSV, que é o caminho relativo
 * gravado NA ÉPOCA do processamento — ela diz onde o arquivo estava quando foi
 * lido, não onde está agora. Aqui a pergunta é respondida indo ao DISCO: para cada
 * documento do banco, procura-se o arquivo pelo NOME sob o MONITOR_PATH.
 *
 * Uso: node _medir/_onde-estao.js
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

const COLS = ['arquivo', 'pasta', 'paginas', 'conteudo', 'tipo', 'evidencia', 'origem', 'ocr_usado', 'dados_parser', 'cnpj'];
function parseCsvLine(line) {
    const f = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
        else { if (ch === '"') inQ = true; else if (ch === ';') { f.push(cur); cur = ''; } else cur += ch; }
    }
    f.push(cur); return f;
}
function csvToRows(csv) {
    const lines = String(csv || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
        const f = parseCsvLine(line); const r = {};
        COLS.forEach((c, i) => { r[c] = f[i] ?? ''; });
        return r;
    });
}

function varrer(dir, saida, prof = 0) {
    if (prof > 8) return;
    let ent; try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

(async () => {
    const monitor = process.env.MONITOR_PATH || '';
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const res = await pool.request().query(
        "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    const docs = new Map();
    for (const rec of res.recordset)
        for (const row of csvToRows(rec.CONTEUDO)) docs.set(`${row.arquivo}|${row.pasta}`, row);

    // Índice do disco por NOME de arquivo (o nome de carnê no banco vem com
    // sufixo "#p1", que não existe no disco — tira-se antes de procurar).
    const noDisco = [];
    varrer(monitor, noDisco);
    const porNome = new Map();
    for (const p of noDisco) {
        const n = path.basename(p);
        if (!porNome.has(n)) porNome.set(n, []);
        porNome.get(n).push(p);
    }

    let achados = 0, naoAchados = 0, deCarne = 0;
    const faltantesPorRaiz = new Map();
    const exemplos = [];

    for (const [chave, row] of docs) {
        const nomeReal = String(row.arquivo).replace(/#p\d+$/, '');
        if (/#p\d+$/.test(row.arquivo)) deCarne++;
        if (porNome.has(nomeReal)) { achados++; continue; }
        naoAchados++;
        const raiz = String(row.pasta || '').split('/')[0] || '(raiz)';
        faltantesPorRaiz.set(raiz, (faltantesPorRaiz.get(raiz) || 0) + 1);
        if (exemplos.length < 10) exemplos.push({ arq: row.arquivo, pasta: row.pasta, per: row.tipo });
    }

    console.log(`MONITOR_PATH = ${monitor}\n`);
    console.log(`PDFs no disco sob o MONITOR_PATH : ${noDisco.length}  (${porNome.size} nomes distintos)`);
    console.log(`Documentos (linhas) no banco     : ${docs.size}   — dos quais ${deCarne} são parcelas de carnê (#pN)\n`);
    console.log(`documentos do banco cujo arquivo EXISTE hoje no SANTANDER : ${achados}`);
    console.log(`documentos do banco cujo arquivo NÃO existe lá            : ${naoAchados}\n`);

    console.log('── os que não existem, por raiz da coluna `pasta` gravada ──');
    for (const [raiz, n] of [...faltantesPorRaiz.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15))
        console.log(`  ${String(n).padStart(5)}  ${raiz}`);

    console.log('\n── exemplos de documentos sem arquivo no SANTANDER ──');
    for (const e of exemplos) console.log(`  ${e.arq.slice(0, 62).padEnd(62)} pasta="${e.pasta}"`);

    process.exit(0);
})().catch(e => { console.error('erro:', e.message); process.exit(1); });
