/**
 * _medir/_conferir-lote-ia.js — o reprocessamento por IA melhorou ou estragou?
 *
 * Roda DEPOIS de `_reprocessar-nfs-ia.js`. Mede as duas metades, como sempre: o que
 * ganhou e o que quebrou. Preencher campo com dado errado é pior que deixar vazio.
 *
 * Confere, nas linhas de origem "IA" do período:
 *   1. o VALOR bate com o gabarito do nome do arquivo?
 *   2. quantas ganharam itens, e a soma dos itens fecha com o total?
 *   3. há linha com `Valor total da nota` ≠ `Valor total` — sinal de que a IA leu o
 *      total de um documento anexo e não o valor pago (padrão [[total-da-nota-nao-e-valor-lancado]])
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_conferir-lote-ia.js [periodo]
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const PERIODO = process.argv[2] || '01.2026';
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO);
    const ia = rows.filter(x => /\bIA\b/i.test(String(x.origem || '')));

    console.log(`${PERIODO}: ${rows.length} linhas, ${ia.length} de origem IA\n`);

    const acc = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    let comItens = 0, fecha = 0, naoFecha = 0;
    const divergentes = [];
    const errados = [];

    for (const x of ia) {
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        const g = j.gabaritos(base);
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        const v = j.num(primeiro(pd, ROT_VALOR));
        const cls = j.jValor(v, g.valor);
        acc[cls === 's/gab' ? 'semGab' : cls]++;
        if (cls === 'erro') errados.push({ base, lido: v, gab: g.valor });

        const itens = (pd && pd['Itens']) || [];
        if (itens.length) {
            comItens++;
            const soma = itens.reduce((s, it) => s + (j.num(it['Valor total']) || 0), 0);
            const tot = j.num(pd['Valor total da nota']) ?? j.num(pd['Valor total']);
            if (tot != null && Math.abs(soma - tot) <= Math.max(0.05, tot * 0.05)) fecha++;
            else naoFecha++;
        }
        // As DUAS chaves de valor presentes e diferentes.
        const a = j.num(pd && pd['Valor total da nota']), b = j.num(pd && pd['Valor total']);
        if (a != null && b != null && Math.abs(a - b) > 0.02)
            divergentes.push({ base, nota: a, total: b, gab: g.valor });
    }

    console.log('VALOR × gabarito do nome');
    console.log(`   ok=${acc.ok}  ERRO=${acc.erro}  ~parcela=${acc.parcela}  vazio=${acc.vazio}  s/gab=${acc.semGab}`);
    const jul = acc.ok + acc.erro + acc.parcela + acc.vazio;
    if (jul) console.log(`   taxa: ${(100 * acc.ok / jul).toFixed(0)}%`);

    console.log(`\nITENS: ${comItens} linhas com itens · soma fecha com o total em ${fecha}, não fecha em ${naoFecha}`);

    if (divergentes.length) {
        console.log(`\n'Valor total da nota' ≠ 'Valor total' em ${divergentes.length} linha(s):`);
        for (const d of divergentes.slice(0, 15))
            console.log(`   nota=${String(d.nota).padStart(11)}  total=${String(d.total).padStart(11)}` +
                `  gabarito=${String(d.gab ?? '—').padStart(11)}  ${d.base.slice(0, 40)}`);
    }
    if (errados.length) {
        console.log(`\nVALOR ERRADO em ${errados.length} linha(s):`);
        for (const e of errados.slice(0, 15))
            console.log(`   leu=${String(e.lido).padStart(11)}  nome diz=${String(e.gab).padStart(11)}  ${e.base.slice(0, 44)}`);
    }
    process.exit(0);
})();
