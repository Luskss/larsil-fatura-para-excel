/**
 * _medir/_perdas-da-regra-vencedora.js — as 101 perdas são aceitáveis?
 *
 * "boleto<nota, depois total" mede GANHA 1.530 / PERDE 101 no escopo fiscal — líquido
 * +1.429, a melhor das 6 regras testadas. Mas 101 acertos de hoje viram erro, e um
 * líquido bom não autoriza ignorar isso: sobrescrever leitura boa é o dano que
 * [[ocr-cai-com-medicoes-em-paralelo]] documenta.
 *
 * Este script olha as 101: quantos documentos DISTINTOS são, qual chave as estraga, e
 * se há um padrão que uma trava extra evitaria (como a de "boleto < nota" evitou as
 * perdas de multa/juros).
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

const hoje = (pd) => j.num(primeiro(pd, ROT_VALOR));
const nova = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');

    const vistos = new Set();
    const perdas = [];
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const ch = `${reg.TIPO}|${reg.PERIODO}|${arq}`;
            if (vistos.has(ch)) continue;
            vistos.add(ch);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            if (j.jValor(hoje(pd), g.valor) === 'ok' && j.jValor(nova(pd), g.valor) !== 'ok')
                perdas.push({ base, pd, gab: g.valor, antes: hoje(pd), depois: nova(pd), tipo: x.tipo });
        }

    const porDoc = new Map();
    for (const p of perdas) {
        if (!porDoc.has(p.base)) porDoc.set(p.base, []);
        porDoc.get(p.base).push(p);
    }
    console.log(`perdas: ${perdas.length} linhas, ${porDoc.size} documentos distintos\n`);

    // Qual chave passou a mandar, e em que proporção erra
    const causa = new Map();
    for (const p of perdas) {
        const bol = N(p.pd, 'Valor do boleto'), nota = N(p.pd, 'Valor total da nota');
        const k = (bol != null && (nota == null || bol < nota)) ? 'Valor do boleto' : 'Valor total';
        causa.set(k, (causa.get(k) || 0) + 1);
    }
    console.log('QUAL CHAVE CAUSA A PERDA');
    for (const [k, n] of [...causa].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(n).padStart(4)}  ${k}`);

    // A razão entre o valor certo e o que a regra nova escolhe: se for múltiplo
    // inteiro, a regra nova está pegando UMA parcela onde o nome traz o total.
    const razoes = new Map();
    for (const p of perdas) {
        const r = p.gab / p.depois;
        const n = Math.round(r);
        const k = (n >= 2 && Math.abs(r - n) < 0.02) ? `gabarito = ${n} × escolhido (parcela)`
                : Math.abs(r - 1) < 0.05 ? 'quase igual (centavos)'
                : 'outra relação';
        razoes.set(k, (razoes.get(k) || 0) + 1);
    }
    console.log('\nRELAÇÃO ENTRE O CERTO E O ESCOLHIDO');
    for (const [k, n] of [...razoes].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(n).padStart(4)}  ${k}`);

    console.log('\nOS 15 DOCUMENTOS MAIS AFETADOS');
    for (const [base, ps] of [...porDoc].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
        const p = ps[0];
        console.log(`   ×${String(ps.length).padStart(2)}  nome=${String(p.gab).padStart(10)}` +
            `  hoje=${String(p.antes).padStart(10)} → novo=${String(p.depois).padStart(10)}` +
            `  ${String(p.tipo).padEnd(8)} ${base.slice(0, 32)}`);
    }
    process.exit(0);
})();
