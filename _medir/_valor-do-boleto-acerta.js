/**
 * _medir/_valor-do-boleto-acerta.js — preferir `Valor do boleto` conserta ou quebra?
 *
 * `_erros-que-importam.js` achou que em 1.476 dos 3.230 erros de valor em documento
 * fiscal (46%) o número CERTO já está gravado na mesma linha, em outra chave:
 *     776 em `Valor do boleto`   ·   700 em `Valor total`
 *
 * Faz sentido: 59% desses erros são pacote "+ BOL" — nota fiscal COM boleto anexo. A
 * nota traz o total (R$ 3.220) e o boleto a parcela que se paga (R$ 805), que é o que
 * o nome do arquivo registra. O pipeline hoje prefere o valor da NOTA.
 *
 * ── Por que NÃO basta trocar a precedência ───────────────────────────────────
 * Medir só onde está errado hoje é a armadilha clássica: conserta 776 e não conta
 * quantos ACERTOS vira erro. `Valor do boleto` existe em milhares de linhas que hoje
 * acertam — se nelas o boleto divergir do nome, a troca PIORA.
 *
 * Este script mede as DUAS metades em TODAS as linhas fiscais que têm as duas chaves:
 *     GANHA  — hoje erra, com a regra nova acerta
 *     PERDE  — hoje acerta, com a regra nova erra
 *
 * Testa 3 regras, porque a diferença entre elas é onde mora o risco.
 *
 * SOMENTE LEITURA — não grava nada.
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
const RE_PACOTE = /\+\s*(BOL|AUT|UT|DANFE|NF|NFS|CTE|COMPROV|REC)/i;

// As regras candidatas. Cada uma devolve o valor que o pipeline gravaria.
const REGRAS = {
    'hoje (nota primeiro)': (pd) => j.num(primeiro(pd, ROT_VALOR)),

    'boleto primeiro': (pd) =>
        j.num(pd['Valor do boleto']) ?? j.num(primeiro(pd, ROT_VALOR)),

    // Só quando o nome diz que há boleto anexo — mais conservadora.
    'boleto só em pacote +BOL': (pd, base) =>
        (/\+\s*BOL/i.test(base) ? j.num(pd['Valor do boleto']) : null)
        ?? j.num(primeiro(pd, ROT_VALOR)),

    // O boleto vence apenas quando é MENOR que o total da nota (é a parcela dela);
    // se for maior ou igual, é outro documento e não se troca.
    'boleto se < total': (pd) => {
        const b = j.num(pd['Valor do boleto']);
        const t = j.num(primeiro(pd, ROT_VALOR));
        if (b != null && t != null && b < t) return b;
        return t ?? b;
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
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            linhas.push({ base, pd, gab: g.valor });
        }

    const comBoleto = linhas.filter(l => !VAZIO(l.pd['Valor do boleto'])).length;
    console.log(`linhas fiscais com gabarito: ${linhas.length}`);
    console.log(`   das quais com 'Valor do boleto': ${comBoleto}\n`);

    const base0 = linhas.map(l => j.jValor(REGRAS['hoje (nota primeiro)'](l.pd, l.base), l.gab));

    console.log('   regra                          ok    ERRO  ~parc   GANHA  PERDE  líquido');
    for (const [nome, fn] of Object.entries(REGRAS)) {
        const acc = { ok: 0, erro: 0, parcela: 0, vazio: 0 };
        let ganha = 0, perde = 0;
        linhas.forEach((l, i) => {
            const v = fn(l.pd, l.base);
            const c = j.jValor(v, l.gab);
            acc[c === 's/gab' ? 'vazio' : c]++;
            const antes = base0[i] === 'ok', depois = c === 'ok';
            if (depois && !antes) ganha++;
            if (antes && !depois) perde++;
        });
        const liq = ganha - perde;
        console.log('   ' + nome.padEnd(28) + String(acc.ok).padStart(6) + String(acc.erro).padStart(8) +
            String(acc.parcela).padStart(7) + String(ganha).padStart(8) + String(perde).padStart(7) +
            (liq > 0 ? '+' : '') + String(liq).padStart(7));
    }

    // Onde a melhor regra ainda perde — para saber se a perda é tolerável.
    const melhor = REGRAS['boleto se < total'];
    const perdas = [];
    linhas.forEach((l, i) => {
        const c = j.jValor(melhor(l.pd, l.base), l.gab);
        if (base0[i] === 'ok' && c !== 'ok')
            perdas.push({ base: l.base, gab: l.gab,
                bol: j.num(l.pd['Valor do boleto']), tot: j.num(primeiro(l.pd, ROT_VALOR)) });
    });
    if (perdas.length) {
        console.log(`\nONDE "boleto se < total" PERDE (${perdas.length}):`);
        for (const p of perdas.slice(0, 12))
            console.log(`   nome=${String(p.gab).padStart(10)}  boleto=${String(p.bol).padStart(10)}` +
                `  nota=${String(p.tot).padStart(10)}  ${p.base.slice(0, 38)}`);
    }
    process.exit(0);
})();
