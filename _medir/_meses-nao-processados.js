/**
 * _medir/_meses-nao-processados.js — 07, 08 e 09/2026: qual o tamanho do buraco?
 *
 * ACHADO (21/09/2026), de passagem na varredura MACPONTA: documentos de 07, 08 e
 * 09/2026 aparecem com `tipo=(não processado)` — estão na PASTA mas não no BANCO.
 * Diferente dos consertos do dia ([[reescanear-nao-se-paga]]), aqui não é
 * releitura: é documento que nunca foi lido, então não há risco de sobrescrever
 * extração boa.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. quantos PDFs por mês existem na pasta e quantos estão no banco
 *   2. a PLANILHA tem lançamentos desses meses? (sem lançamento, processar não
 *      muda o painel — o comparador não teria o que casar)
 *   3. quanto VALOR está nesses lançamentos
 *   4. a partir de que data o banco parou
 *
 * A pergunta que decide: processar esses meses faz o painel responder por eles, ou
 * a planilha também para em junho e o esforço não tem contraparte?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

(async () => {
    const c = h.carregar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const noBanco = new Set(Object.keys(idx).map(base));

    // ── 1) pasta × banco, por mês ──────────────────────────────────────────
    const meses = Object.keys(c.pasta.arquivosPorMes || {}).sort((a, b) => {
        const [ma, aa] = a.split('.'), [mb, ab] = b.split('.');
        return (aa - ab) || (ma - mb);
    });

    console.log('── PDFs na pasta × no banco, por mês ───────────────────────');
    console.log('  mês        na pasta   no banco   faltando');
    const faltando = {};
    for (const m of meses) {
        const arqs = c.pasta.arquivosPorMes[m] || [];
        const dentro = arqs.filter(a => noBanco.has(base(a.nome))).length;
        const fora = arqs.length - dentro;
        faltando[m] = fora;
        const marca = fora > 0 && fora === arqs.length ? '  ← nenhum processado'
                    : fora > 0 ? '  ← parcial' : '';
        console.log(`  ${m}   ${String(arqs.length).padStart(7)}   ${String(dentro).padStart(8)}   ${String(fora).padStart(8)}${marca}`);
    }

    const mesesVazios = meses.filter(m => faltando[m] > 0);
    const totalFaltando = mesesVazios.reduce((s, m) => s + faltando[m], 0);
    console.log(`\n  total de PDFs fora do banco: ${totalFaltando}`);

    // ── 2 e 3) a planilha tem lançamentos desses meses? ────────────────────
    console.log('\n── a PLANILHA cobre esses meses? ───────────────────────────');
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const porMesPlan = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iData = header.indexOf('DATA');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        const iEnt = header.indexOf('ENTIDADE');
        if (iData < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const serial = Number(r[iData]);
            if (!isFinite(serial) || serial <= 0) continue;
            const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
            const k = `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
            const v = Math.abs(Number(r[iVal]) || 0);
            if (!norm(r[iEnt]) || !v) continue;
            if (!porMesPlan.has(k)) porMesPlan.set(k, { n: 0, v: 0 });
            const o = porMesPlan.get(k); o.n++; o.v += v;
        }
        break;
    }

    console.log('  mês        lançamentos        valor        PDFs fora do banco');
    const todosMeses = [...new Set([...meses, ...porMesPlan.keys()])].sort((a, b) => {
        const [ma, aa] = a.split('.'), [mb, ab] = b.split('.');
        return (aa - ab) || (ma - mb);
    });
    for (const m of todosMeses) {
        const pl = porMesPlan.get(m);
        if (!pl && !faltando[m]) continue;
        console.log(`  ${m}   ${String(pl ? pl.n : 0).padStart(11)}   ${brl(pl ? pl.v : 0).padStart(18)}   ${String(faltando[m] || 0).padStart(8)}`);
    }

    // ── 4) até quando o banco foi ──────────────────────────────────────────
    console.log('\n── até onde cada fonte vai ─────────────────────────────────');
    const mesesComBanco = meses.filter(m => (c.pasta.arquivosPorMes[m] || []).some(a => noBanco.has(base(a.nome))));
    console.log(`  banco    até ${mesesComBanco[mesesComBanco.length - 1] || '(nenhum)'}`);
    console.log(`  pasta    até ${meses[meses.length - 1]}`);
    const mesesPlan = [...porMesPlan.keys()].sort((a, b) => {
        const [ma, aa] = a.split('.'), [mb, ab] = b.split('.');
        return (aa - ab) || (ma - mb);
    });
    console.log(`  planilha até ${mesesPlan[mesesPlan.length - 1] || '(nenhum)'}`);

    // ── o impacto ──────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(68)}`);
    console.log('O IMPACTO DE PROCESSAR');
    console.log('═'.repeat(68));
    let lancSemCobertura = 0, valSemCobertura = 0;
    for (const m of mesesVazios) {
        const pl = porMesPlan.get(m);
        if (!pl) continue;
        lancSemCobertura += pl.n;
        valSemCobertura += pl.v;
    }
    console.log(`\n  PDFs a processar:                       ${totalFaltando}`);
    console.log(`  lançamentos da planilha nesses meses:   ${lancSemCobertura}`);
    console.log(`  valor desses lançamentos:               ${brl(valSemCobertura)}`);
    if (lancSemCobertura === 0) {
        console.log('\n  → a PLANILHA não cobre esses meses: processar os PDFs não dá');
        console.log('    resposta nova ao painel, porque não há lançamento para casar.');
        console.log('    O trabalho só se paga quando a contabilidade fechar o período.');
    } else {
        console.log('\n  → há lançamento esperando documento nesses meses. Processar faz o');
        console.log('    painel responder por eles — é scan de documento NOVO, sem o risco');
        console.log('    de sobrescrever extração boa ([[reescanear-nao-se-paga]]).');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
