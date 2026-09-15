/**
 * _medir/_origem-vazia.js — as 252 linhas SEM carimbo de origem: quem são?
 *
 * `_fallback-parser-no-banco.js` achou uma faixa que não deveria existir: 252
 * linhas (4% do banco) com `origem` VAZIA e 93-97% dos campos do pareamento
 * ausentes. Todas as outras faixas têm carimbo ('IA', 'conteúdo', 'conteúdo
 * (fraco)', 'visão (IA)'), então estas entraram por um caminho que não se
 * identifica — e não sabemos se é bug de gravação, documento ilegível, ou tipo que
 * o pipeline nunca soube ler.
 *
 * Antes de reprocessar qualquer coisa é preciso saber O QUE são. Reprocessar sem
 * diagnóstico é caro (chamada de IA por documento) e pode não mudar nada — se o
 * PDF for imagem sem OCR, reler pelo mesmo caminho dá o mesmo vazio.
 *
 * ── O que este script responde ───────────────────────────────────────────────
 *   1. Que TIPO o classify deu a elas, e qual `evidencia`?
 *   2. O arquivo tem gabarito no nome (padrão `NNN.DOC- valor`)? Sem isso a linha
 *      é invisível para o comparador E para a conferência.
 *   3. O PDF ainda EXISTE na pasta? (linha órfã de arquivo movido/renomeado)
 *   4. É PDF-imagem ou tem texto nativo? — decide se reprocessar resolveria:
 *      com texto, a IA leria; sem texto, precisa de visão/OCR.
 *   5. `ocr_usado` estava marcado? `conteudo` tem tamanho?
 *
 * SOMENTE LEITURA. Não grava nada, não reprocessa.
 *
 * Uso: node _medir/_origem-vazia.js [periodo...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const { getConnection, sql } = require('../config');

const PERIODOS = process.argv.slice(2).length ? process.argv.slice(2) : h.PERIODOS;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const SEP = ';';
function parseCsv(txt) {
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === SEP) { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

// Índice de arquivos da pasta, por nome-base, para achar o PDF de cada linha.
// A linha guarda `arquivo` e `pasta`, mas a pasta pode ter sido renomeada
// ([[pasta-renomeada-duplica-linha]]), então busco pelo nome em todo o acervo.
function indexarPasta(raiz) {
    const porNome = new Map();
    (function anda(dir) {
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
            const q = path.join(dir, e.name);
            if (e.isDirectory()) anda(q);
            else if (/\.pdf$/i.test(e.name)) {
                if (!porNome.has(e.name)) porNome.set(e.name, []);
                porNome.get(e.name).push(q);
            }
        }
    })(raiz);
    return porNome;
}

async function ehImagem(abs) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const t = ((await pr.getText()).text || '').replace(/\s/g, '');
        return { imagem: t.length < 15, nChars: t.length };
    } catch (e) { return { imagem: null, nChars: 0, erro: e.message }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

(async () => {
    const pool = await getConnection();
    console.error('[origem-vazia] indexando a pasta...');
    const idx = indexarPasta(RAIZ_ARQ);
    console.error(`[origem-vazia] ${idx.size} nomes de arquivo no acervo`);

    const alvos = [];
    for (const periodo of PERIODOS) {
        const r = await pool.request()
            .input('tipo', sql.Char(1), 'M')
            .input('periodo', sql.VarChar(20), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@tipo AND PERIODO=@periodo');
        if (!r.recordset.length) continue;
        const linhas = parseCsv(String(r.recordset[0].CONTEUDO || '').replace(/^﻿/, ''));
        if (!linhas.length) continue;
        const head = linhas[0].map(s => String(s).replace(/^﻿/, '').trim());
        const I = k => head.indexOf(k);
        for (const l of linhas.slice(1)) {
            if (!l[I('arquivo')]) continue;
            const origem = String(l[I('origem')] || '').trim();
            if (origem !== '' && origem !== '—') continue;
            alvos.push({
                periodo,
                arquivo: l[I('arquivo')],
                pasta:   l[I('pasta')],
                tipo:    l[I('tipo')],
                evid:    l[I('evidencia')],
                ocr:     l[I('ocr_usado')],
                paginas: l[I('paginas')],
                nConteudo: String(l[I('conteudo')] || '').length,
                dados:   (() => { try { return JSON.parse(l[I('dados_parser')] || 'null'); } catch (_) { return null; } })(),
                cnpj:    l[I('cnpj')],
            });
        }
    }
    console.log(`linhas com origem VAZIA: ${alvos.length}\n`);
    if (!alvos.length) { process.exit(0); }

    // ── 1. por tipo e evidência ─────────────────────────────────────────────
    const conta = (arr, f) => arr.reduce((m, x) => { const k = f(x) || '(vazio)'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const mostra = (rot, m) => {
        console.log(rot);
        for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12))
            console.log(`   ${String(v).padStart(4)}  ${k.slice(0, 60)}`);
    };
    mostra('POR TIPO', conta(alvos, a => a.tipo));
    mostra('\nPOR EVIDÊNCIA', conta(alvos, a => a.evid));
    mostra('\nPOR PERÍODO', conta(alvos, a => a.periodo));
    mostra('\nOCR USADO', conta(alvos, a => String(a.ocr)));

    // ── 2. tem gabarito no nome? ────────────────────────────────────────────
    let comGabValor = 0, comPadraoDoc = 0;
    for (const a of alvos) {
        const base = path.basename(String(a.arquivo).replace(/#p\d+$/, ''));
        if (j.gabaritos(base).valor != null) comGabValor++;
        if (/^\s*\d{1,4}\s*\.?\s*DOC/i.test(base)) comPadraoDoc++;
    }
    console.log(`\nGABARITO NO NOME`);
    console.log(`   com valor no nome:        ${comGabValor}/${alvos.length}`);
    console.log(`   com padrão "NNN.DOC-":    ${comPadraoDoc}/${alvos.length}`);

    // ── 3 e 4. o PDF existe? é imagem? ──────────────────────────────────────
    console.error('[origem-vazia] conferindo os PDFs no disco...');
    let achados = 0, ausentes = 0, imagens = 0, comTexto = 0, erros = 0;
    const detalhe = [];
    for (const a of alvos) {
        const base = path.basename(String(a.arquivo).replace(/#p\d+$/, ''));
        const cands = idx.get(base);
        if (!cands || !cands.length) { ausentes++; a._estado = 'AUSENTE do disco'; continue; }
        achados++;
        const r = await ehImagem(cands[0]);
        if (!r) { erros++; a._estado = 'erro ao ler'; continue; }
        if (r.erro) { erros++; a._estado = `erro pdf-parse: ${r.erro.slice(0, 30)}`; continue; }
        if (r.imagem) { imagens++; a._estado = 'PDF-IMAGEM (sem texto)'; }
        else { comTexto++; a._estado = `tem texto (${r.nChars} chars)`; }
        if (detalhe.length < 30) detalhe.push({ ...a, abs: cands[0], nChars: r.nChars });
    }

    console.log(`\nESTADO NO DISCO`);
    console.log(`   achados:      ${achados}`);
    console.log(`   AUSENTES:     ${ausentes}   ← linha órfã (arquivo movido/renomeado)`);
    console.log(`   PDF-imagem:   ${imagens}   ← reprocessar só resolve com VISÃO/OCR`);
    console.log(`   com texto:    ${comTexto}   ← reprocessar DEVE resolver (a IA leria)`);
    console.log(`   erro ao ler:  ${erros}`);

    console.log('\n── amostra detalhada ───────────────────────────────────────');
    for (const d of detalhe.slice(0, 22)) {
        console.log(`  [${d.periodo}] ${String(d.tipo || '?').slice(0, 18).padEnd(19)} ${d._estado.padEnd(24)} conteudo=${String(d.nConteudo).padStart(6)}`);
        console.log(`      ${String(d.arquivo).slice(0, 70)}`);
        if (d.evid) console.log(`      evidência: ${String(d.evid).slice(0, 60)}`);
    }

    // ── o veredito: reprocessar ajudaria? ───────────────────────────────────
    console.log('\n── REPROCESSAR AJUDARIA? ───────────────────────────────────');
    console.log(`   ${comTexto} linhas têm PDF com TEXTO NATIVO e origem vazia.`);
    console.log(`   Nessas, a IA de texto acerta 96% do valor (medido em`);
    console.log(`   _parser-multicampo.js), então reprocessar deve preencher.`);
    console.log(`   ${imagens} são PDF-imagem: dependem de VISAO_PDF=1 / OCR ligado.`);
    console.log(`   ${ausentes} estão ausentes do disco: reprocessar NÃO as alcança —`);
    console.log(`   são linhas velhas de arquivo renomeado, e o certo é limpá-las.`);
    process.exit(0);
})();
