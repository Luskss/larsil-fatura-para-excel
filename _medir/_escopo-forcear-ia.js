/**
 * _medir/_escopo-forcear-ia.js — quantos documentos ainda não passaram pela IA?
 *
 * Pedido do usuário (11/09/2026): mandar as notas sem item para a IA, e daqui em
 * diante usar só IA.
 *
 * Antes de disparar: `forceAI` relê TUDO que a origem não marca como "IA"
 * (`process-folder.js:1106`), não só as NFS-e sem item. Precisa saber o tamanho e o
 * custo — o scan completo de 03.2026 levou 34 min e ~US$2,40 para 933 arquivos, e
 * aqui são 6 períodos.
 *
 * Mede, por período: quantos já são IA, quantos seriam relidos, e quanto disso é
 * NFS-e sem item (o alvo que motivou o pedido).
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

(async () => {
    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t ORDER BY PERIODO');

    let tIA = 0, tNao = 0, tNfsSemItem = 0;
    console.log('   período    linhas   já IA   NÃO-IA   NFS s/ item');
    for (const reg of rr.recordset) {
        const rows = pf.csvToRows(reg.CONTEUDO);
        let ia = 0, nao = 0, nfs = 0;
        for (const x of rows) {
            const ehIA = /\bIA\b/i.test(String(x.origem || ''));
            if (ehIA) ia++; else nao++;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const temItens = pd && Array.isArray(pd['Itens']) && pd['Itens'].length;
            if (String(x.tipo) === 'NFS' && !temItens && !ehIA) nfs++;
        }
        tIA += ia; tNao += nao; tNfsSemItem += nfs;
        console.log('   ' + String(reg.PERIODO).padEnd(10) + String(rows.length).padStart(7) +
            String(ia).padStart(8) + String(nao).padStart(9) + String(nfs).padStart(14));
    }
    console.log('   ' + '─'.repeat(52));
    console.log('   TOTAL     ' + String(tIA + tNao).padStart(6) + String(tIA).padStart(8) +
        String(tNao).padStart(9) + String(tNfsSemItem).padStart(14));

    // Custo: a medição de 11/09 deu US$2,41 para 1.037 documentos pela via de
    // transcrição; a leitura por texto é mais barata (sem imagem), mas serve de teto.
    const porDoc = 2.41 / 1037;
    console.log(`\n   se reler TODOS os não-IA: ${tNao} documentos`);
    console.log(`   teto de custo estimado:   US$ ${(tNao * porDoc).toFixed(2)}`);
    console.log(`   só as NFS-e sem item:     ${tNfsSemItem} documentos` +
        `  (US$ ${(tNfsSemItem * porDoc).toFixed(2)})`);
    process.exit(0);
})();
