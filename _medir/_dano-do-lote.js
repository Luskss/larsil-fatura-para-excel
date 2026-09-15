/**
 * _medir/_dano-do-lote.js — o lote de teste PIOROU as 3 linhas que tocou?
 *
 * As 3 linhas relidas ficaram com o valor ERRADO contra o gabarito do nome:
 *     THR:     leu 4052,76   nome diz 21508,13
 *     MEI:     leu 1680,90   nome diz 13998,04   (×4 parcelas)
 *     SAVANA:  leu 1869,00   nome diz   467,25   (= 4 × 467,25, é o total do boleto)
 *
 * Falta a metade que decide: o que havia ANTES? Se antes estava certo, meu lote
 * causou dano e a decisão de "só IA" precisa de trava antes de rodar em 294.
 *
 * O "antes" está no relatório DIÁRIO ('D'), que `_reprocessar-nfs-ia.js` NÃO tocou —
 * ele só regrava o mensal ('M'), como o cabeçalho de `_reprocessar-arquivos.js`
 * documenta. Isso dá um retrato independente da mesma leitura.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

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
    // Relatórios DIÁRIOS — não foram regravados pelo lote.
    const rr = await pool.request().input('t', sql.Char(1), 'D')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    console.log(`relatórios diários: ${rr.recordset.length}\n`);

    for (const t of TOCADOS) {
        console.log('═'.repeat(72));
        console.log(t.slice(0, 66));
        let achou = 0;
        for (const reg of rr.recordset)
            for (const x of pf.csvToRows(reg.CONTEUDO)) {
                if (!String(x.arquivo).includes(t)) continue;
                achou++;
                const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
                const g = j.gabaritos(base);
                let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
                const v = j.num(primeiro(pd, ROT_VALOR));
                const itens = (pd && pd['Itens']) || [];
                console.log(`   [D ${reg.PERIODO}] ${String(x.arquivo).slice(-12)}  origem=${x.origem}  tipo=${x.tipo}`);
                console.log(`      valor=${v}  gabarito=${g.valor}  → ${j.jValor(v, g.valor)}   itens=${itens.length}`);
            }
        if (!achou) console.log('   (não está em nenhum relatório diário)');
    }
    process.exit(0);
})();
