/**
 * _medir/_ultima-gravacao.js — quando foi a última escrita em nfs.RELATORIOS_CONFERENCIA
 * para TIPO='M' e PERIODO dado. Proxy direto para saber se o reprocesso em segundo
 * plano já regravou o mês, sem depender do stdout do processo (que se perde quando o
 * server é reiniciado no meio da rodada).
 *
 * Uso: node _medir/_ultima-gravacao.js [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

(async () => {
    const periodoArg = process.argv[2] || '03.2026';
    const pool = await getConnection();
    const r = await pool.request()
        .input('p', sql.VarChar(20), periodoArg)
        .query("SELECT PERIODO, TOTAL_ARQUIVOS, ATUALIZADO_EM, DATALENGTH(CONTEUDO) AS bytes FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M' AND PERIODO=@p");
    if (!r.recordset.length) { console.log('sem linha para', periodoArg); return; }
    const row = r.recordset[0];
    const atualizado = row.ATUALIZADO_EM ? new Date(row.ATUALIZADO_EM) : null;
    console.log(`período          : ${row.PERIODO}`);
    console.log(`total_arquivos   : ${row.TOTAL_ARQUIVOS}`);
    console.log(`tamanho conteudo : ${(row.bytes / 1024).toFixed(0)} KB`);
    console.log(`atualizado em    : ${atualizado ? atualizado.toLocaleString('pt-BR') : '(nunca / coluna nula)'}`);
    if (atualizado) {
        const minAtras = (Date.now() - atualizado.getTime()) / 60000;
        console.log(`há               : ${minAtras.toFixed(1)} min`);
    }
})().catch(e => { console.error(e); process.exit(1); });
