/**
 * _medir/_tipos-lidos.js — "quais tipos de arquivo estão sendo lidos?"
 *
 * Responde em três eixos, porque "tipo" é ambíguo e cada eixo responde outra
 * pergunta:
 *   1. o que é IGNORADO na coleta (CPV / extrato-dia) — nunca chega a ser lido;
 *   2. o TIPO fiscal que ficou gravado na coluna `tipo` (NF, NFS, CTE, RECIBO…);
 *   3. COMO o documento foi lido (texto do PDF, OCR, IA) — o custo de cada via.
 *
 * Lê o que está NO BANCO, não o log: o log de uma rodada em andamento mostra só
 * a parte já processada.
 *
 * Uso: node _medir/_tipos-lidos.js [periodo]     ex.: node _medir/_tipos-lidos.js 03.2026
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
// A conexão vem do config.js do projeto: ele trata encrypt/trust conforme o .env,
// que é onde minha versão à mão errava.
const { getConnection, sql, loadEnv } = require('../config');

// O projeto não usa dotenv: lê o .env à mão, como os outros scripts de _medir.
for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

// ── mesmo parser de CSV do process-folder (aspas duplicadas) ──
function parseCsv(txt) {
    txt = String(txt || '').replace(/^﻿/, ''); // BOM: sem isso o header vira "﻿arquivo"
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === ';') { linha.push(campo); campo = ''; }   // separador é ';', não ','
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXTRATO_DIA = /^0+\s*[.\-]/;

function tabela(titulo, pares, total) {
    console.log(`\n── ${titulo} ──`);
    const larg = Math.max(...pares.map(([k]) => k.length), 8);
    for (const [k, n] of pares) {
        const pct = total ? (n * 100 / total) : 0;
        const barra = '█'.repeat(Math.round(pct / 2.5));
        console.log(`  ${k.padEnd(larg)}  ${String(n).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${barra}`);
    }
}

(async () => {
    const periodoArg = process.argv[2] || null;

    const pool = await getConnection();

    // Só TIPO='M': é o relatório mensal que o painel consome. Os TIPO='D' são
    // recortes por dia dos MESMOS PDFs — somá-los contaria cada documento duas vezes.
    const q = periodoArg
        ? await pool.request().input('p', sql.VarChar(20), periodoArg)
            .query("SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M' AND PERIODO = @p")
        : await pool.request()
            .query("SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");

    const porTipo = new Map(), porOrigem = new Map(), porOcr = new Map(), porConteudo = new Map();
    const porPeriodo = new Map();
    let linhas = 0;
    const arquivos = new Set();

    for (const row of q.recordset) {
        const rows = parseCsv(row.CONTEUDO || '');
        if (!rows.length) continue;
        const head = rows[0];
        const iArq = head.indexOf('arquivo'), iTipo = head.indexOf('tipo');
        const iOrig = head.indexOf('origem'), iOcr = head.indexOf('ocr_usado');
        const iCont = head.indexOf('conteudo');
        for (const r of rows.slice(1)) {
            if (!r[iArq]) continue;
            linhas++;
            const base = String(r[iArq]).replace(/#p\d+$/i, '');
            arquivos.add(`${base}|${row.PERIODO}`);
            const t = (iTipo >= 0 && r[iTipo]) || '(vazio)';
            porTipo.set(t, (porTipo.get(t) || 0) + 1);
            const o = (iOrig >= 0 && r[iOrig]) || '(vazio)';
            porOrigem.set(o, (porOrigem.get(o) || 0) + 1);
            const oc = (iOcr >= 0 && String(r[iOcr]).toLowerCase() === 'true') ? 'com OCR' : 'sem OCR';
            porOcr.set(oc, (porOcr.get(oc) || 0) + 1);
            const cc = (iCont >= 0 && r[iCont]) || '(vazio)';
            porConteudo.set(cc, (porConteudo.get(cc) || 0) + 1);
            porPeriodo.set(row.PERIODO, (porPeriodo.get(row.PERIODO) || 0) + 1);
        }
    }

    console.log(`\n${'='.repeat(64)}`);
    console.log(`TIPOS DE ARQUIVO LIDOS${periodoArg ? ' — período ' + periodoArg : ' (todos os períodos)'}`);
    console.log('='.repeat(64));
    console.log(`\n${linhas} linhas · ${arquivos.size} PDFs distintos (as parcelas #pN de um carnê`);
    console.log(`viram várias linhas do MESMO arquivo)`);

    const ord = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
    tabela('2. TIPO FISCAL reconhecido', ord(porTipo), linhas);
    tabela('3. COMO foi lido (origem do dado)', ord(porOrigem), linhas);
    tabela('   OCR', ord(porOcr), linhas);
    if (porConteudo.size > 1) tabela('   conteúdo do PDF', ord(porConteudo), linhas);
    if (!periodoArg) tabela('   por período', ord(porPeriodo), linhas);

    // pool compartilhado do config.js: nao fechar

    // ── eixo 1: o que nem chega a ser lido. Precisa ir ao disco. ──
    const raiz = process.env.ARQUIVO_PATH;
    if (!raiz || !fs.existsSync(raiz)) {
        console.log('\n(ARQUIVO_PATH indisponível — pulei a contagem do que é ignorado)');
        return;
    }
    const alvo = periodoArg
        ? (() => {
            const [m, a] = periodoArg.split('.');
            const nome = fs.readdirSync(raiz).find(d => d.startsWith(`${a}.${m}`));
            return nome ? path.join(raiz, nome) : null;
        })()
        : raiz;
    if (!alvo || !fs.existsSync(alvo)) { console.log('\n(pasta do período não encontrada)'); return; }

    let lidos = 0, cpv = 0, extrato = 0;
    const exemplosCpv = [], exemplosExt = [];
    (function anda(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { anda(p); continue; }
            if (!e.name.toLowerCase().endsWith('.pdf')) continue;
            if (RE_CPV.test(e.name)) { cpv++; if (exemplosCpv.length < 3) exemplosCpv.push(e.name); }
            else if (RE_EXTRATO_DIA.test(e.name)) { extrato++; if (exemplosExt.length < 3) exemplosExt.push(e.name); }
            else lidos++;
        }
    })(alvo);

    const tot = lidos + cpv + extrato;
    console.log(`\n── 1. O QUE É IGNORADO NA COLETA (disco: ${path.basename(alvo)}) ──`);
    tabela('', [['lidos', lidos], ['CPV (ignorado)', cpv], ['extrato-dia (ignorado)', extrato]], tot);
    console.log(`\n  total de PDFs na pasta: ${tot} · lidos: ${lidos} (${(lidos * 100 / tot).toFixed(1)}%)`);
    if (exemplosCpv.length) { console.log('\n  exemplos de CPV pulado:'); exemplosCpv.forEach(n => console.log(`    ${n.slice(0, 70)}`)); }
    if (exemplosExt.length) { console.log('\n  exemplos de extrato-dia pulado:'); exemplosExt.forEach(n => console.log(`    ${n.slice(0, 70)}`)); }
})().catch(e => { console.error(e); process.exit(1); });
