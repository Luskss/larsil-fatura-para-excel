/**
 * _medir/_os-3-que-reli.js — o lote de teste estragou alguma coisa?
 *
 * `_conferir-lote-ia.js` acusou 132 valores errados entre as 882 linhas de IA de
 * 01.2026. Antes de concluir qualquer coisa: essas linhas JÁ ERAM de IA antes do meu
 * lote de teste, que releu 3 documentos. Atribuir os 132 ao reprocessamento seria o
 * mesmo erro de causa que já cometi antes (a PERDA falsa da auditoria de março).
 *
 * Este script olha SÓ os documentos que o lote tocou, um a um.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

// Os 3 primeiros alvos de 01.2026, na ordem em que `_reprocessar-nfs-ia.js` os pegou.
const TOCADOS = [
    '024.DOC- 21508,13-2026.01.16.THR . FT825432+ AUT',
    '004.DOC- 13998,04 pgto PRESTADORES SERVIÇO - MEI - LARSIL',
    '010.DOC- 467,25  - 2026.05.28. SAVANA. NFS 113 + BOL',
];
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), '01.2026')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO);

    for (const t of TOCADOS) {
        const achadas = rows.filter(x => String(x.arquivo).includes(t));
        console.log('═'.repeat(72));
        console.log(t.slice(0, 66));
        if (!achadas.length) { console.log('   (nenhuma linha!)'); continue; }
        for (const x of achadas) {
            const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            const g = j.gabaritos(base);
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const v = j.num(primeiro(pd, ROT_VALOR));
            const itens = (pd && pd['Itens']) || [];
            console.log(`   ${String(x.arquivo).slice(-14).padStart(14)}  origem=${x.origem}  tipo=${x.tipo}`);
            console.log(`      valor lido=${v}   gabarito=${g.valor}   → ${j.jValor(v, g.valor)}`);
            console.log(`      itens=${itens.length}` +
                (itens.length ? `  soma=${itens.reduce((s, i2) => s + (j.num(i2['Valor total']) || 0), 0).toFixed(2)}` : ''));
            for (const it of itens.slice(0, 5))
                console.log(`         ${String(it['Descrição']).slice(0, 46).padEnd(46)} ${it['Valor total']}`);
        }
    }
    process.exit(0);
})();
