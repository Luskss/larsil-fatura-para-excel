/**
 * _medir/_ver-linha.js — despeja TUDO que o banco tem sobre um documento.
 *
 * Pergunta do usuário (11/09/2026): a NFS 886 da DALIANI é um PDF clicável (tem
 * texto nativo), então por que a linha não tem itens?
 *
 * Antes de teorizar: ver o que está gravado. Quais chaves existem, qual foi a via de
 * leitura (`conteudo`), qual o `tipo` detectado — porque a extração de itens depende
 * do tipo ([[chave-do-parser-e-em-portugues]]: supor o rótulo dá zero, e zero parece
 * resultado).
 *
 * Uso: node _medir/_ver-linha.js "trecho do nome" [periodo]
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const TRECHO = process.argv[2];
if (!TRECHO) { console.log('passe um trecho do nome'); process.exit(1); }
const PERIODO = process.argv[3] || null;

(async () => {
    const pool = await getConnection();
    const q = PERIODO
        ? await pool.request().input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
            .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe')
        : await pool.request().input('t', sql.Char(1), 'M')
            .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');

    let achou = 0;
    for (const reg of q.recordset) {
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            if (!String(x.arquivo).includes(TRECHO)) continue;
            achou++;
            console.log('═'.repeat(74));
            console.log(`PERÍODO ${reg.PERIODO}   arquivo: ${x.arquivo}`);
            console.log(`pasta=${x.pasta}`);
            console.log(`conteudo=${JSON.stringify(x.conteudo)}  tipo=${JSON.stringify(x.tipo)}` +
                `  origem=${JSON.stringify(x.origem)}  ocr_usado=${JSON.stringify(x.ocr_usado)}`);
            for (const k of Object.keys(x)) {
                if (k === 'dados_parser' || k === 'conteudo' || k === 'tipo' ||
                    k === 'origem' || k === 'arquivo' || k === 'pasta') continue;
                if (x[k] == null || String(x[k]).trim() === '') continue;
                console.log(`   ${k} = ${JSON.stringify(x[k]).slice(0, 120)}`);
            }
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (e) {
                console.log('   dados_parser NÃO É JSON:', String(x.dados_parser).slice(0, 200));
            }
            if (pd) {
                console.log('   ── dados_parser ──');
                for (const k of Object.keys(pd))
                    console.log(`   ${k} = ${JSON.stringify(pd[k]).slice(0, 200)}`);
            }
        }
    }
    if (!achou) console.log('nenhuma linha casou com o trecho.');
    process.exit(0);
})();
