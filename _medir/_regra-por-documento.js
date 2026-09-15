/**
 * _medir/_regra-por-documento.js — o mesmo teste, contando DOCUMENTO, não linha.
 *
 * As medições anteriores contaram LINHAS de relatório, e o acervo repete o mesmo
 * arquivo em muitos relatórios (mensal + diário + meses vizinhos). Isso distorce os
 * dois lados: as 101 perdas da regra vencedora são 11 documentos, e 84 delas são UM
 * par de arquivos quase idênticos repetido 42 vezes cada.
 *
 * O mesmo vale para os ganhos — 1.530 "ganhos" podem ser bem menos documentos.
 * Sem deduplicar, a regra é escolhida por quantas vezes um arquivo foi arquivado.
 *
 * Aqui cada documento conta UMA vez (pelo nome-base, sem `#pN`), usando a leitura
 * mais recente disponível. É a métrica que responde "quantos documentos passam a ter
 * o valor certo".
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const N = (pd, k) => j.num(pd[k]);

const REGRAS = {
    'hoje': (pd) => j.num(primeiro(pd, ROT_VALOR)),
    'boleto primeiro': (pd) => N(pd, 'Valor do boleto') ?? j.num(primeiro(pd, ROT_VALOR)),
    'Valor total primeiro': (pd) => N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR)),
    'o menor dos candidatos': (pd) => {
        const c = [N(pd, 'Valor do boleto'), N(pd, 'Valor total'),
                   N(pd, 'Valor total da nota'), N(pd, 'Valor do serviço')].filter(v => v != null);
        return c.length ? Math.min(...c) : j.num(primeiro(pd, ROT_VALOR));
    },
    'boleto<nota, depois total': (pd) => {
        const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
        if (bol != null && (nota == null || bol < nota)) return bol;
        return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
    },
};

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    // chave = nome do arquivo COM a parcela (#pN é outro lançamento), última leitura vence.
    const doc = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            doc.set(path.basename(arq), { pd, gab: g.valor, base, tipo: x.tipo });
        }

    const linhas = [...doc.values()];
    console.log(`documentos fiscais DISTINTOS com gabarito: ${linhas.length}\n`);

    const base0 = linhas.map(l => j.jValor(REGRAS['hoje'](l.pd), l.gab));
    console.log('   regra                          ok    ERRO   GANHA  PERDE  líquido   taxa');
    for (const [nome, fn] of Object.entries(REGRAS)) {
        let ok = 0, erro = 0, ganha = 0, perde = 0;
        linhas.forEach((l, i) => {
            const c = j.jValor(fn(l.pd), l.gab);
            if (c === 'ok') ok++; else if (c === 'erro') erro++;
            if (c === 'ok' && base0[i] !== 'ok') ganha++;
            if (c !== 'ok' && base0[i] === 'ok') perde++;
        });
        const liq = ganha - perde;
        console.log('   ' + nome.padEnd(28) + String(ok).padStart(6) + String(erro).padStart(8) +
            String(ganha).padStart(8) + String(perde).padStart(7) +
            ((liq > 0 ? '+' : '') + liq).padStart(8) +
            (100 * ok / linhas.length).toFixed(0).padStart(6) + '%');
    }

    // As perdas da vencedora, por documento distinto
    const fn = REGRAS['boleto<nota, depois total'];
    const perdas = linhas.filter((l, i) => base0[i] === 'ok' && j.jValor(fn(l.pd), l.gab) !== 'ok');
    console.log(`\nPERDAS de "boleto<nota, depois total": ${perdas.length} documento(s)`);
    for (const p of perdas)
        console.log(`   nome=${String(p.gab).padStart(10)}  hoje=${String(REGRAS['hoje'](p.pd)).padStart(10)}` +
            ` → novo=${String(fn(p.pd)).padStart(10)}  ${String(p.tipo).padEnd(9)} ${p.base.slice(0, 34)}`);
    process.exit(0);
})();
