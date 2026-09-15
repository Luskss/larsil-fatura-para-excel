/**
 * _medir/_teto-do-valor.js — qual é o TETO de acerto sem ler nada de novo?
 *
 * Pergunta do usuário (11/09/2026): dá para puxar o número ainda mais, antes de aplicar?
 *
 * A regra "boleto<nota, depois total" leva 54% → 67%. Antes de refinar a regra, é
 * preciso saber quanto AINDA está no banco e quanto exigiria leitura nova — senão
 * gasta-se esforço numa regra que já está perto do limite, ou desiste-se cedo demais.
 *
 * O ORÁCULO: para cada documento, varre TODAS as chaves numéricas de `dados_parser`
 * (inclusive dentro de `Itens` e somas de subconjuntos) e pergunta: existe ALGUM
 * número aqui que bate com o gabarito? Se existir, uma regra de escolha perfeita
 * acertaria — é o teto do que dá para ganhar sem chamar IA nenhuma.
 *
 * A diferença entre o teto e a regra proposta é o espaço que sobra para refinar.
 * O que fica fora do teto é erro de LEITURA: só melhora relendo o documento.
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
const proposta = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};

// Todos os números que a linha contém, com a chave de onde vieram.
function candidatos(pd) {
    const out = [];
    for (const [k, v] of Object.entries(pd)) {
        if (k === 'Itens') {
            for (const it of (v || [])) {
                const n = j.num(it['Valor total']);
                if (n != null) out.push({ k: 'Itens[].Valor total', v: n });
                const u = j.num(it['Valor unitário']);
                if (u != null) out.push({ k: 'Itens[].Valor unitário', v: u });
            }
            continue;
        }
        const n = j.num(v);
        if (n != null) out.push({ k, v: n });
    }
    return out;
}

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    // Deduplica por arquivo COM parcela — `#pN` é lançamento próprio.
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
    const L = [...doc.values()];
    console.log(`documentos fiscais distintos: ${L.length}\n`);

    let okHoje = 0, okProp = 0, noTeto = 0, foraDoTeto = 0, okSoma = 0;
    const chaveSalvadora = new Map();
    const foraExemplos = [];

    for (const l of L) {
        const h0 = j.jValor(hoje(l.pd), l.gab) === 'ok';
        const p0 = j.jValor(proposta(l.pd), l.gab) === 'ok';
        if (h0) okHoje++;
        if (p0) okProp++;

        const cands = candidatos(l.pd);
        const acerta = cands.filter(c => Math.abs(c.v - l.gab) <= 0.02);
        let dentro = acerta.length > 0;

        // Soma de subconjunto de itens (nota com vários itens, paga-se parte).
        if (!dentro) {
            const its = (l.pd['Itens'] || []).map(i => j.num(i['Valor total'])).filter(v => v != null);
            if (its.length && its.length <= 14) {
                for (let m = 1; m < (1 << its.length) && !dentro; m++) {
                    let s = 0;
                    for (let b = 0; b < its.length; b++) if (m & (1 << b)) s += its[b];
                    if (Math.abs(s - l.gab) <= 0.02) { dentro = true; okSoma++; }
                }
            }
        }

        if (dentro) {
            noTeto++;
            if (!p0 && acerta.length)
                chaveSalvadora.set(acerta[0].k, (chaveSalvadora.get(acerta[0].k) || 0) + 1);
        } else {
            foraDoTeto++;
            if (!p0 && foraExemplos.length < 12)
                foraExemplos.push({ base: l.base, gab: l.gab, leu: proposta(l.pd), tipo: l.tipo,
                    n: cands.length });
        }
    }

    const pct = n => (100 * n / L.length).toFixed(0) + '%';
    console.log('ONDE ESTAMOS E ATÉ ONDE DÁ PARA IR (sem reler documento)');
    console.log(`   hoje:                      ${String(okHoje).padStart(5)}  ${pct(okHoje)}`);
    console.log(`   regra proposta:            ${String(okProp).padStart(5)}  ${pct(okProp)}`);
    console.log(`   TETO (escolha perfeita):   ${String(noTeto).padStart(5)}  ${pct(noTeto)}`);
    console.log(`      (dos quais só por soma de subconjunto de itens: ${okSoma})`);
    console.log(`   fora do teto (erro de leitura real): ${foraDoTeto}  ${pct(foraDoTeto)}`);
    console.log(`\n   espaço que a regra proposta AINDA deixa: ${noTeto - okProp} documentos`);

    console.log('\nQUE CHAVE SALVARIA OS QUE A PROPOSTA NÃO PEGA');
    for (const [k, n] of [...chaveSalvadora].sort((a, b) => b[1] - a[1]).slice(0, 14))
        console.log(`   ${String(n).padStart(5)}  ${k}`);

    console.log('\nEXEMPLOS FORA DO TETO (nenhum número da linha bate — leitura errada mesmo)');
    for (const e of foraExemplos)
        console.log(`   nome=${String(e.gab).padStart(11)}  leu=${String(e.leu).padStart(11)}` +
            `  ${String(e.tipo).padEnd(9)} ${String(e.n).padStart(3)} números  ${e.base.slice(0, 30)}`);
    process.exit(0);
})();
