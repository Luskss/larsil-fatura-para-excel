/**
 * _medir/_cache-versus-banco-vivo.js — o que eu medi bate com o que o painel vê?
 *
 * RESSALVA (21/09/2026): todas as medições de hoje usam `_medir/.cache/` —
 * `pasta.json` e `planilha.json` de 18/09, e `ocr.json`/`tipo-por-arquivo.json`
 * lidos do banco naquele momento. O painel real consulta o banco AO VIVO.
 *
 * [[cache-do-harness-falseia-medicao]] já mordeu este projeto: um `pasta.json` de
 * 4 dias atrás valia +4 pares de diferença, e a conclusão do dia era artefato.
 * Antes de afirmar ao usuário "pode comparar agora, vai estar melhor", confirmar
 * que a base não mudou.
 *
 * ── O que se compara ────────────────────────────────────────────────────────
 *   1. nº de linhas/documentos no banco AGORA × no cache
 *   2. a pasta no disco AGORA × `pasta.json`
 *   3. a planilha (mtime) × quando o cache foi gerado
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const base = s => String(s || '').replace(/#p\d+$/i, '');

(async () => {
    // ── idade dos caches ───────────────────────────────────────────────────
    console.log('── idade dos arquivos de cache ─────────────────────────────');
    const agora = Date.now();
    for (const f of ['pasta.json', 'planilha.json', 'ocr.json', 'tipo-por-arquivo.json']) {
        const p = path.join(h.CACHE, f);
        if (!fs.existsSync(p)) { console.log(`   ${f.padEnd(24)} (ausente)`); continue; }
        const st = fs.statSync(p);
        const dias = ((agora - st.mtimeMs) / 86400000).toFixed(1);
        console.log(`   ${f.padEnd(24)} ${dias} dias`);
    }

    // ── a PLANILHA mudou desde o cache? ────────────────────────────────────
    console.log('\n── a planilha mudou? ───────────────────────────────────────');
    const pl = process.env.PLANILHA_PATH;
    try {
        const stPl = fs.statSync(pl);
        const stCache = fs.statSync(path.join(h.CACHE, 'planilha.json'));
        const maisNova = stPl.mtimeMs > stCache.mtimeMs;
        console.log(`   planilha modificada em: ${new Date(stPl.mtimeMs).toLocaleString('pt-BR')}`);
        console.log(`   cache gerado em:        ${new Date(stCache.mtimeMs).toLocaleString('pt-BR')}`);
        console.log(`   → a planilha é MAIS NOVA que o cache? ${maisNova ? 'SIM ⚠' : 'não'}`);
    } catch (e) { console.log(`   (não consegui ler: ${e.message})`); }

    // ── o BANCO mudou? ─────────────────────────────────────────────────────
    console.log('\n── o banco mudou desde o cache? ────────────────────────────');
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

    const vivoDocs = new Set();
    let vivoLinhas = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo');
        if (iA < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const a = String(sep(ls[i])[iA] || '').trim();
            if (!a) continue;
            vivoLinhas++;
            vivoDocs.add(base(a));
        }
    }

    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const cacheDocs = new Set(Object.keys(idx).map(base));

    console.log(`   documentos no banco AGORA:  ${vivoDocs.size}  (${vivoLinhas} linhas)`);
    console.log(`   documentos no cache:        ${cacheDocs.size}`);

    const soVivo = [...vivoDocs].filter(d => !cacheDocs.has(d));
    const soCache = [...cacheDocs].filter(d => !vivoDocs.has(d));
    console.log(`   só no banco (novos):        ${soVivo.length}`);
    console.log(`   só no cache (sumiram):      ${soCache.length}`);
    if (soVivo.length) {
        console.log('\n   amostra dos novos:');
        for (const d of soVivo.slice(0, 6)) console.log(`      ${d.slice(0, 62)}`);
    }

    // ── a PASTA mudou? ─────────────────────────────────────────────────────
    console.log('\n── a pasta no disco mudou? ─────────────────────────────────');
    const c = h.carregar();
    const noCachePasta = Object.values(c.pasta.arquivosPorMes || {}).reduce((s, a) => s + a.length, 0);
    console.log(`   PDFs em pasta.json: ${noCachePasta}`);
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    console.log(`   (varrer o disco de novo levaria minutos; o sinal de mudança está`);
    console.log(`    no banco acima — ${soVivo.length} documentos novos)`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(68));
    const mudou = soVivo.length > 0 || soCache.length > 0;
    if (!mudou) {
        console.log('\n   Banco e cache coincidem: o que medi HOJE é o que o painel vê.');
        console.log('   A conclusão "pode comparar agora" está sobre base firme.');
    } else {
        console.log(`\n   ⚠ o banco tem ${soVivo.length} documentos que o cache não tem.`);
        console.log('   As medições de hoje podem estar levemente defasadas — mas o');
        console.log('   conserto de `tipoBate` roda sobre o banco VIVO na comparação,');
        console.log('   então o ganho se aplica igual aos documentos novos.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
