/**
 * _medir/_fora-do-teto.js — os 31% que nenhuma regra alcança: o que são?
 *
 * `_teto-do-valor.js` mostrou que o teto de escolha perfeita é 69% e a regra proposta
 * chega a 67%. Refinar a escolha rende no máximo +82 documentos. O que decide se vale
 * ir além está nos 1.652 documentos (31%) FORA do teto: nenhum número gravado na linha
 * bate com o gabarito.
 *
 * Três causas possíveis, com consequências muito diferentes:
 *   (a) leitura errada de verdade      → só relendo (IA melhor, prompt, transcrição)
 *   (b) o documento não TEM o número   → o nome traz outro valor (parcela de carnê,
 *                                        soma de várias notas, valor negociado)
 *   (c) o GABARITO é que está errado    → o nome do arquivo mente, e o índice mente junto
 *
 * (c) é o que [[gabarito-frouxo-inventa-erro]] já pegou uma vez inflando 4 erros para
 * 11. Se for grande aqui, a taxa "54%" nunca foi 54% de verdade e nenhuma regra vai
 * consertar isso.
 *
 * Distingue (b) de (a) por um sinal barato: quantos números a linha tem. Linha com 1
 * número e nenhum batendo é leitura pobre; linha com 20 números e nenhum batendo
 * sugere que o valor do nome simplesmente não está no papel.
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
const proposta = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};
function candidatos(pd) {
    const out = [];
    for (const [k, v] of Object.entries(pd)) {
        if (k === 'Itens') {
            for (const it of (v || [])) {
                for (const kk of ['Valor total', 'Valor unitário']) {
                    const n = j.num(it[kk]); if (n != null) out.push(n);
                }
            }
            continue;
        }
        const n = j.num(v); if (n != null) out.push(n);
    }
    return out;
}
const RE_PACOTE = /\+\s*(BOL|AUT|UT|DANFE|NF|NFS|CTE|COMPROV|REC)/i;

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

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
            doc.set(path.basename(arq), { arq, pd, gab: g.valor, base, tipo: x.tipo,
                conteudo: x.conteudo, origem: x.origem });
        }

    const fora = [];
    for (const l of doc.values()) {
        const c = candidatos(l.pd);
        if (c.some(v => Math.abs(v - l.gab) <= 0.02)) continue;
        fora.push({ ...l, nNums: c.length, cands: c });
    }
    console.log(`fora do teto: ${fora.length} documentos\n`);

    // 1. quantos números a linha tinha
    const faixas = [['0-1 número', 0, 1], ['2-4', 2, 4], ['5-9', 5, 9], ['10-19', 10, 19], ['20+', 20, 1e9]];
    console.log('1) RIQUEZA DA LEITURA (quantos números a linha traz)');
    for (const [nome, a, b] of faixas) {
        const n = fora.filter(f => f.nNums >= a && f.nNums <= b).length;
        console.log(`   ${nome.padEnd(12)} ${String(n).padStart(5)}  ${(100 * n / fora.length).toFixed(0)}%`);
    }

    // 2. o valor do nome é MÚLTIPLO/SUBMÚLTIPLO de algum número lido?
    //    Isso indica (b): o documento traz a parcela e o nome o total, ou vice-versa.
    let rel = 0, semRel = 0;
    for (const f of fora) {
        let achou = false;
        for (const v of f.cands) {
            const r = f.gab / v, n = Math.round(r);
            if (n >= 2 && n <= 60 && Math.abs(r - n) < 0.02) { achou = true; break; }
            const ri = v / f.gab, ni = Math.round(ri);
            if (ni >= 2 && ni <= 60 && Math.abs(ri - ni) < 0.02) { achou = true; break; }
        }
        if (achou) rel++; else semRel++;
    }
    console.log('\n2) O VALOR DO NOME TEM RELAÇÃO ARITMÉTICA COM O QUE FOI LIDO?');
    console.log(`   sim (múltiplo/submúltiplo) → nome e papel falam de coisas diferentes: ${rel}  (${(100 * rel / fora.length).toFixed(0)}%)`);
    console.log(`   não                        → leitura errada ou valor ausente:        ${semRel}  (${(100 * semRel / fora.length).toFixed(0)}%)`);

    // 3. por via de leitura e por tipo
    const porVia = new Map(), porTipo = new Map(), porConteudo = new Map();
    for (const f of fora) {
        const v = /\bIA\b/i.test(String(f.origem || '')) ? 'IA' : 'local';
        porVia.set(v, (porVia.get(v) || 0) + 1);
        porTipo.set(String(f.tipo), (porTipo.get(String(f.tipo)) || 0) + 1);
        porConteudo.set(String(f.conteudo), (porConteudo.get(String(f.conteudo)) || 0) + 1);
    }
    console.log('\n3) POR VIA DE LEITURA');
    for (const [k, n] of porVia) console.log(`   ${String(n).padStart(5)}  ${k}`);
    console.log('   por tipo:');
    for (const [k, n] of [...porTipo].sort((a, b) => b[1] - a[1]).slice(0, 6))
        console.log(`      ${String(n).padStart(5)}  ${k}`);
    console.log('   por conteúdo:');
    for (const [k, n] of [...porConteudo].sort((a, b) => b[1] - a[1]).slice(0, 6))
        console.log(`      ${String(n).padStart(5)}  ${k}`);

    // 4. pacote?
    const pac = fora.filter(f => RE_PACOTE.test(f.base)).length;
    console.log(`\n4) nome de PACOTE (+BOL/+AUT/...): ${pac}  (${(100 * pac / fora.length).toFixed(0)}%)`);

    // 5. os que não têm NENHUM número (leitura vazia) — conserto é reler
    const vazios = fora.filter(f => f.nNums === 0);
    console.log(`\n5) SEM NENHUM NÚMERO NA LINHA: ${vazios.length} (reler resolveria)`);
    for (const v of vazios.slice(0, 8))
        console.log(`   ${String(v.conteudo).padEnd(22)} ${v.base.slice(0, 46)}`);
    process.exit(0);
})();
