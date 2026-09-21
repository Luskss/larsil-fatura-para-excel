/**
 * _medir/_gemeos-quantos-sao.js — quantos documentos "competem" pelo mesmo lançamento?
 *
 * O CASO (21/09/2026): o único par que a correção do índice trocou é este —
 *
 *     lançado R$ 3.340,00  (PRATAO SERVICO)
 *       120.DOC- 1670,00 - 2026.02.28. PRATAO SERVICO. NFS 16928 + BOL.pdf
 *       041.DOC- 1670,00 - 2026.02.08. PRATAO SERVICO. NFS 16928 + BOL.pdf
 *
 * Dois arquivos, mesmo fornecedor, MESMO número de nota, mesmo valor de parcela,
 * datas diferentes. O lançamento é R$ 3.340 = 2 × R$ 1.670. São as duas parcelas
 * do mesmo título, e o motor tem de escolher UM documento para o par.
 *
 * Isso é o 1↔N já conhecido ([[parcela-1-para-n-pendente]]), mas visto pelo outro
 * lado: não "um lançamento somando N documentos", e sim **N documentos disputando
 * um lançamento**, onde a escolha é arbitrária.
 *
 * ── Antes de propor desempate, DIMENSIONAR ──────────────────────────────────
 * [[dimensionar-o-pool-antes-de-medir]]: quantos casos existem? Se forem 3, não
 * vale regra nova. E quantos o motor já resolve bem?
 *
 *   1. quantos GRUPOS de documentos gêmeos existem? (mesmo fornecedor+número)
 *   2. em quantos o lançamento é múltiplo exato do valor do documento?
 *   3. quantos deles o painel já pareia, e com que força?
 *   4. que SINAIS distinguem os gêmeos? (data, parcela declarada, nosso número,
 *      vencimento, linha digitável)
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // ── todos os documentos da pasta, com o que o índice sabe ──────────────
    const docs = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {})) {
        for (const a of arqs) {
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]);
            docs.push({ mes, arq: a.nome, rel: a.rel, doc: d,
                        numero: d.numero || (idx[a.nome] || {}).numero || '',
                        ent: norm(d.emitente || (idx[a.nome] || {}).emitente || ''),
                        valor: Math.abs(Number(d.valor) || 0),
                        data: d.data || null });
        }
    }
    console.log(`documentos na pasta: ${docs.length}\n`);

    // ── (1) agrupar por FORNECEDOR + NÚMERO ────────────────────────────────
    // é a assinatura de "mesmo título": mesma nota, mesmo emitente
    const porChave = new Map();
    for (const d of docs) {
        if (!d.numero || !d.ent) continue;
        const k = `${d.ent}|${d.numero}`;
        if (!porChave.has(k)) porChave.set(k, []);
        porChave.get(k).push(d);
    }
    const gemeos = [...porChave].filter(([, g]) => g.length > 1);

    console.log('═'.repeat(78));
    console.log('(1) GRUPOS DE DOCUMENTOS COM MESMO FORNECEDOR + NÚMERO');
    console.log('═'.repeat(78));
    console.log(`\n   chaves distintas: ${porChave.size}`);
    console.log(`   com MAIS DE UM documento: ${gemeos.length}  ${pct(gemeos.length, porChave.size)}`);
    const tam = new Map();
    for (const [, g] of gemeos) tam.set(g.length, (tam.get(g.length) || 0) + 1);
    console.log('\n   tamanho dos grupos:');
    for (const [n, q] of [...tam].sort((a, b) => a[0] - b[0]).slice(0, 10))
        console.log(`      ${n} documentos: ${q} grupos`);

    // ── (2) os gêmeos têm o MESMO valor? ───────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) OS GÊMEOS SÃO IDÊNTICOS NO VALOR?');
    console.log('═'.repeat(78));
    let mesmoValor = 0, valorDiferente = 0, semValor = 0;
    for (const [, g] of gemeos) {
        const vs = [...new Set(g.map(x => x.valor).filter(Boolean).map(v => v.toFixed(2)))];
        if (!vs.length) semValor++;
        else if (vs.length === 1) mesmoValor++;
        else valorDiferente++;
    }
    console.log(`\n   todos com o MESMO valor:  ${mesmoValor}  ${pct(mesmoValor, gemeos.length)}  ← competem de verdade`);
    console.log(`   valores diferentes:       ${valorDiferente}  ${pct(valorDiferente, gemeos.length)}  ← o valor já distingue`);
    console.log(`   sem valor:                ${semValor}`);

    // ── (3) que SINAIS distinguem os gêmeos de mesmo valor? ────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) QUE SINAIS DISTINGUEM OS GÊMEOS DE MESMO VALOR?');
    console.log('═'.repeat(78));

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const sep = (l) => {
        const o = []; let a = '', q = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (q) { if (ch === '"') { if (l[i + 1] === '"') { a += '"'; i++; } else q = false; } else a += ch; }
            else if (ch === '"') q = true;
            else if (ch === ';') { o.push(a); a = ''; }
            else a += ch;
        }
        o.push(a); return o;
    };
    const pdPorArquivo = new Map();       // nome base → dados_parser da linha de DOCUMENTO
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iD < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arqExato = String(f[iA] || '').trim();
            if (!arqExato || ehParcela(arqExato)) continue;
            if (pdPorArquivo.has(arqExato)) continue;
            const b = (f[iD] || '').trim();
            if (!b.startsWith('{')) continue;
            try { pdPorArquivo.set(arqExato, JSON.parse(b)); } catch (e) {}
        }
    }

    const SINAIS = ['Data de vencimento', 'Nosso Número', 'Linha digitável', 'Parcela',
                    'Data de emissão', 'Chave de acesso'];
    const distingue = {};
    for (const s of SINAIS) distingue[s] = { presente: 0, distingue: 0 };
    let comPastaDiferente = 0, comDataNomeDiferente = 0;
    const idem = gemeos.filter(([, g]) => {
        const vs = [...new Set(g.map(x => x.valor).filter(Boolean).map(v => v.toFixed(2)))];
        return vs.length === 1;
    });
    for (const [, g] of idem) {
        for (const s of SINAIS) {
            const vals = g.map(x => {
                const pd = pdPorArquivo.get(x.arq) || {};
                const v = pd[s];
                return v == null ? '' : String(v).trim();
            });
            const cheios = vals.filter(Boolean);
            if (cheios.length < g.length) continue;      // nem todos têm o sinal
            distingue[s].presente++;
            if (new Set(cheios).size === g.length) distingue[s].distingue++;
        }
        // a pasta (mês) distingue?
        if (new Set(g.map(x => x.mes)).size === g.length) comPastaDiferente++;
        // a data no NOME distingue?
        const datas = g.map(x => { const m = x.arq.match(/(20\d{2})[.\-](\d{1,2})[.\-](\d{1,2})/); return m ? m[0] : ''; });
        if (datas.every(Boolean) && new Set(datas).size === g.length) comDataNomeDiferente++;
    }
    console.log(`\n   grupos de gêmeos com MESMO valor: ${idem.length}\n`);
    console.log('   sinal                    presente em todos    distingue todos');
    for (const [s, v] of Object.entries(distingue))
        console.log(`      ${s.padEnd(22)} ${String(v.presente).padStart(8)}          ${String(v.distingue).padStart(8)}  ${pct(v.distingue, idem.length)}`);
    console.log(`      ${'pasta (mês)'.padEnd(22)} ${String(idem.length).padStart(8)}          ${String(comPastaDiferente).padStart(8)}  ${pct(comPastaDiferente, idem.length)}`);
    console.log(`      ${'data no NOME'.padEnd(22)} ${String(idem.length).padStart(8)}          ${String(comDataNomeDiferente).padStart(8)}  ${pct(comDataNomeDiferente, idem.length)}`);

    // ── (4) exemplos ───────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(4) EXEMPLOS DE GÊMEOS COM MESMO VALOR');
    console.log('═'.repeat(78));
    for (const [k, g] of idem.slice(0, 6)) {
        console.log(`\n   ${k}   ${g.length} documentos, ${brl(g[0].valor)} cada`);
        for (const x of g) {
            const pd = pdPorArquivo.get(x.arq) || {};
            console.log(`      [${x.mes}] ${x.arq.slice(0, 50)}`);
            console.log(`          venc=${pd['Data de vencimento'] || '—'}  nossoNum=${String(pd['Nosso Número'] || '—').slice(0, 18)}  parcela=${pd['Parcela'] || '—'}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
