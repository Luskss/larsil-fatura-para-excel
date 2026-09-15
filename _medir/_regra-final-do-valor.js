/**
 * _medir/_regra-final-do-valor.js — qual regra de escolha do valor acerta mais?
 *
 * O quadro montado até aqui, nos 3.230 erros de valor em documento FISCAL:
 *   - só `Valor do boleto` acerta:  554
 *   - só `Valor total` acerta:      625
 *   - as duas acertam:              369
 * Ou seja: nenhuma das duas chaves sozinha resolve. E `Valor total da nota` (a que o
 * pipeline prefere hoje) é justamente a que traz o total inflado nos pacotes.
 *
 * As 9 perdas de "boleto primeiro" são só 4 documentos, e 3 deles têm o boleto MAIOR
 * que o pago (multa/juros: 130,16 para 78,09) — não é parcela, é acréscimo. Isso sugere
 * a trava certa: o boleto só vence quando é MENOR que o total da nota.
 *
 * Testa as combinações medindo GANHA e PERDE contra a regra de hoje. A regra vencedora
 * não pode ser escolhida pelo ganho sozinho — [[inspecao-anima-medicao-decide]].
 *
 * SOMENTE LEITURA — nenhuma alteração de código depende deste arquivo rodar.
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

    // O MENOR entre os candidatos plausíveis: a intuição é que o total da nota é o
    // teto e o que se paga é uma parte dele.
    'o menor dos candidatos': (pd) => {
        const c = [N(pd, 'Valor do boleto'), N(pd, 'Valor total'),
                   N(pd, 'Valor total da nota'), N(pd, 'Valor do serviço')].filter(v => v != null);
        return c.length ? Math.min(...c) : j.num(primeiro(pd, ROT_VALOR));
    },

    // Precedência explícita: boleto (só se menor que a nota) > Valor total > resto.
    'boleto<nota, depois total': (pd) => {
        const bol = N(pd, 'Valor do boleto');
        const nota = N(pd, 'Valor total da nota');
        if (bol != null && (nota == null || bol < nota)) return bol;
        return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
    },

    // Mesma ideia, mas 'Valor total' antes do boleto.
    'total, depois boleto<nota': (pd) => {
        const t = N(pd, 'Valor total');
        if (t != null) return t;
        const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
        if (bol != null && (nota == null || bol < nota)) return bol;
        return j.num(primeiro(pd, ROT_VALOR));
    },
};

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');

    const vistos = new Set();
    const linhas = [];
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const ch = `${reg.TIPO}|${reg.PERIODO}|${arq}`;
            if (vistos.has(ch)) continue;
            vistos.add(ch);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            const foraDoEscopo = !!(rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base));
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            linhas.push({ base, pd, gab: g.valor, foraDoEscopo });
        }

    for (const escopo of ['FISCAL (o que a conferência usa)', 'TODAS as linhas']) {
        const alvo = escopo.startsWith('FISCAL') ? linhas.filter(l => !l.foraDoEscopo) : linhas;
        const base0 = alvo.map(l => j.jValor(REGRAS['hoje'](l.pd), l.gab));
        console.log(`\n══ ${escopo} — ${alvo.length} linhas ══`);
        console.log('   regra                          ok    ERRO   GANHA  PERDE  líquido');
        for (const [nome, fn] of Object.entries(REGRAS)) {
            let ok = 0, erro = 0, ganha = 0, perde = 0;
            alvo.forEach((l, i) => {
                const c = j.jValor(fn(l.pd), l.gab);
                if (c === 'ok') ok++; else if (c === 'erro') erro++;
                if (c === 'ok' && base0[i] !== 'ok') ganha++;
                if (c !== 'ok' && base0[i] === 'ok') perde++;
            });
            const liq = ganha - perde;
            console.log('   ' + nome.padEnd(28) + String(ok).padStart(6) + String(erro).padStart(8) +
                String(ganha).padStart(8) + String(perde).padStart(7) +
                ((liq > 0 ? '+' : '') + liq).padStart(8));
        }
    }
    process.exit(0);
})();
