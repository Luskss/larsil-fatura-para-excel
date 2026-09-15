/**
 * _medir/_erros-que-importam.js — os 3.230 erros DENTRO do escopo: o que são?
 *
 * Dos 7.618 valores fora do alvo, 4.388 (58%) estão em documento que
 * `categoriaNaoFiscal` filtra da conferência — consórcio, empréstimo, crédito. Não são
 * problema a resolver: o sistema não os usa.
 *
 * Sobram 3.230 em documento fiscal, e é neles que "acertar mais valores" significa
 * alguma coisa. Este script mede, SÓ nesses:
 *   1. a classe aritmética do erro (múltiplo, vizinho, soma de itens...)
 *   2. quantos são pacote "+ BOL / + AUT / + DANFE" — onde há mais de um valor
 *      legítimo na página e a escolha de campo é o problema
 *   3. quantos estão em ARQUIVO com parcelas (`#pN`), onde o nome traz o total
 *   4. o que o campo `Origem do valor total` diz — a própria leitura já registra
 *      de onde tirou o número
 *
 * O objetivo é achar a classe com MAIOR volume e conserto mais barato, não consertar
 * tudo. SOMENTE LEITURA.
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
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;  // fora do escopo
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const v = j.num(primeiro(pd, ROT_VALOR));
            if (v == null) continue;
            const cls = j.jValor(v, g.valor);
            if (cls !== 'erro' && cls !== 'parcela') continue;
            linhas.push({ arq, base, v, g: g.valor, pd, cls, tipo: x.tipo, origem: x.origem });
        }

    console.log(`erros de valor em documento FISCAL: ${linhas.length}\n`);

    // 1. pacote × simples
    const pac = linhas.filter(l => RE_PACOTE.test(l.base)).length;
    const parc = linhas.filter(l => /#p\d+$/.test(l.arq)).length;
    console.log('1) CONTEXTO DO ARQUIVO');
    console.log(`   nome de PACOTE (+BOL/+AUT/+DANFE): ${pac}  (${(100 * pac / linhas.length).toFixed(0)}%)`);
    console.log(`   linha de PARCELA (#pN):            ${parc}  (${(100 * parc / linhas.length).toFixed(0)}%)`);

    // 2. o que a própria leitura diz sobre de onde tirou o número
    const porOrigemValor = new Map();
    for (const l of linhas) {
        const o = String((l.pd && l.pd['Origem do valor total']) || '(não registrado)');
        porOrigemValor.set(o, (porOrigemValor.get(o) || 0) + 1);
    }
    console.log('\n2) `Origem do valor total` NAS LINHAS ERRADAS');
    for (const [o, n] of [...porOrigemValor].sort((a, b) => b[1] - a[1]).slice(0, 8))
        console.log(`   ${String(n).padStart(5)}  ${o}`);

    // 3. a mesma anatomia, só no escopo
    const classificar = (lido, gab, pd) => {
        const r = lido / gab, n = Math.round(r);
        if (n >= 2 && Math.abs(r - n) < 0.02) return 'multiplo-inteiro';
        const inv = gab / lido, ni = Math.round(inv);
        if (ni >= 2 && Math.abs(inv - ni) < 0.02) return 'submultiplo';
        for (const k of [10, 100, 1000, 0.1, 0.01]) if (Math.abs(r - k) < 0.02 * k) return 'digito-a-mais';
        const its = (pd && pd['Itens']) || [];
        if (its.length) {
            const s = its.reduce((a, it) => a + (j.num(it['Valor total']) || 0), 0);
            if (s > 0 && Math.abs(lido - s) <= Math.max(0.05, s * 0.01)) return 'soma-de-itens';
        }
        if (Math.abs(lido - gab) / gab < 0.05) return 'vizinho';
        return 'outro';
    };
    const cl = new Map();
    for (const l of linhas) {
        const k = l.cls === 'parcela' ? 'multiplo-inteiro' : classificar(l.v, l.g, l.pd);
        cl.set(k, (cl.get(k) || 0) + 1);
    }
    console.log('\n3) ANATOMIA, SÓ NO ESCOPO');
    for (const [k, n] of [...cl].sort((a, b) => b[1] - a[1]))
        console.log(`   ${k.padEnd(18)} ${String(n).padStart(5)}  ${(100 * n / linhas.length).toFixed(0)}%`);

    // 4. O CASO MAIS COMUM: o valor certo está em OUTRA chave da mesma linha?
    // Se estiver, o conserto é de ESCOLHA DE CAMPO no pipeline — barato e sem IA.
    let achouEmOutraChave = 0;
    const chavesQueAcertam = new Map();
    for (const l of linhas) {
        if (!l.pd) continue;
        for (const [k, raw] of Object.entries(l.pd)) {
            if (k === 'Itens') continue;
            const n = j.num(raw);
            if (n != null && Math.abs(n - l.g) <= 0.02) {
                achouEmOutraChave++;
                chavesQueAcertam.set(k, (chavesQueAcertam.get(k) || 0) + 1);
                break;
            }
        }
    }
    console.log(`\n4) O VALOR CERTO JÁ ESTÁ NA LINHA, em outra chave?`);
    console.log(`   sim: ${achouEmOutraChave} de ${linhas.length}  (${(100 * achouEmOutraChave / linhas.length).toFixed(0)}%)`);
    if (chavesQueAcertam.size) {
        console.log('   qual chave tinha o valor certo:');
        for (const [k, n] of [...chavesQueAcertam].sort((a, b) => b[1] - a[1]).slice(0, 10))
            console.log(`      ${String(n).padStart(5)}  ${k}`);
    }
    process.exit(0);
})();
