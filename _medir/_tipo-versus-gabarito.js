/**
 * _medir/_tipo-versus-gabarito.js — a classificação de TIPO erra quanto, e onde?
 *
 * PERGUNTA (21/09/2026): o usuário relata "diversos problemas de casamento de tipo
 * de nota" (NF, CT-e, RECIBO e afins). `classify()` (_nf-parsers.js:99) decide o
 * tipo 100% por conteúdo, em 7 categorias, via marcadores FORTES → emitente
 * público → marcadores FRACOS.
 *
 * O gabarito existe e não estava sendo usado para isso: a coluna TIPO da planilha
 * Delsoft é a classificação que a CONTABILIDADE deu ao lançamento.
 * `_baseline.tipoPlanilhaParaBanco` já mapeia TIPO textual → categoria do banco,
 * mas só para VALIDAR par, nunca para medir o acerto do classificador.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Sobre os pares que o motor JÁ faz (jan–jun/2026), com gabarito disponível:
 *   1. acurácia global do classify()
 *   2. matriz de confusão: gabarito → tipo lido (ONDE erra, não só quanto)
 *   3. a via que produziu o tipo (origem: conteúdo / emitente / fraco)
 *
 * 'RECIBO E OUTROS' é guarda-chuva ('*' no baseline) e NÃO entra na acurácia —
 * aceita qualquer tipo, então contá-lo como acerto infla a nota de graça.
 * Idem TIPOs sem equivalente fiscal (retornam '').
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Mesmo mapa do _baseline.js (não exportado de lá): TIPO da planilha → categoria do banco.
function tipoPlanilhaParaBanco(tipoPlanilha) {
    const t = norm(tipoPlanilha);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}

// O índice de `_medir/ocr.js` NÃO carrega as colunas `tipo`/`evidencia`/`origem`
// (só numero/emitente/valor/cnpj/data). Medir o classificador por ele daria zero —
// a armadilha de "medir o vazio". Então lemos o CSV do banco por conta própria,
// com cache separado para não contaminar o `ocr.json` que as outras medições usam.
async function indexarTipo() {
    const fs = require('fs');
    const cache = path.join(h.CACHE, 'tipo-por-arquivo.json');
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    const separarCsv = (linha) => {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (aspas) {
                if (ch === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
                else atual += ch;
            } else if (ch === '"') aspas = true;
            else if (ch === ';') { out.push(atual); atual = ''; }
            else atual += ch;
        }
        out.push(atual); return out;
    };
    const base = s => String(s || '').replace(/#p\d+$/i, '').trim();

    const idx = {};
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo');
        const iTipo = cols.indexOf('tipo');
        const iEvid = cols.indexOf('evidencia');
        const iOrig = cols.indexOf('origem');
        if (iArq < 0 || iTipo < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const campos = separarCsv(ls[i]);
            const arq = base(campos[iArq]);
            if (!arq) continue;
            const at = idx[arq] || (idx[arq] = {});
            const tp = String(campos[iTipo] || '').trim();
            if (tp && !at.tipo) at.tipo = tp;
            if (iEvid >= 0 && !at.evidencia) at.evidencia = String(campos[iEvid] || '').trim();
            if (iOrig >= 0 && !at.origem) at.origem = String(campos[iOrig] || '').trim();
        }
    }
    fs.writeFileSync(cache, JSON.stringify(idx));
    return idx;
}

(async () => {
    const c = h.carregar();
    console.error('[tipo-gabarito] indexando OCR (campos de pareamento)...');
    const idxOcr = await indexar();
    console.error('[tipo-gabarito] indexando TIPO gravado no banco...');
    const idx = await indexarTipo();
    console.error(`[tipo-gabarito] ${Object.keys(idx).length} arquivos com tipo gravado`);

    // ── relê a planilha para recuperar a coluna TIPO por lançamento ─────────
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE');
        const iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const nf = String(r[iNF] || '').trim();
            const ent = norm(r[iEnt]);
            const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${nf}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }
    console.log(`TIPO recuperado para ${tipoPorChave.size} chaves da planilha\n`);
    if (!tipoPorChave.size) { console.log('não li a coluna TIPO — abortando'); process.exit(1); }

    // ── pares do motor, cruzados com gabarito × tipo lido ───────────────────
    const confusao = new Map();       // `gab→lido` → n
    const exemplos = new Map();       // `gab→lido` → [ {arquivo, evid, origem} ]
    const porOrigem = new Map();      // origem → { ok, n }
    let total = 0, comGab = 0, avaliaveis = 0, acertos = 0, semTipo = 0;

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            total++;
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[x.documento.arquivo] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido) { semTipo++; continue; }
            if (!tipoPl) continue;
            comGab++;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab || gab === '*') continue;   // guarda-chuva não avalia
            avaliaveis++;
            const k = `${gab}→${lido}`;
            confusao.set(k, (confusao.get(k) || 0) + 1);
            const ok = gab === lido;
            if (ok) acertos++;
            const org = info.origem || '(não gravada)';
            if (!porOrigem.has(org)) porOrigem.set(org, { ok: 0, n: 0 });
            const po = porOrigem.get(org); po.n++; if (ok) po.ok++;
            if (!ok) {
                if (!exemplos.has(k)) exemplos.set(k, []);
                const ex = exemplos.get(k);
                if (ex.length < 6) ex.push({
                    arq: x.documento.arquivo,
                    evid: info.evidencia || '—',
                    org,
                    tipoPl,
                });
            }
        }
    }

    console.log(`pares: ${total}   sem tipo lido: ${semTipo}   com gabarito: ${comGab}   AVALIÁVEIS: ${avaliaveis}`);
    console.log(`\nACURÁCIA do classify(): ${acertos}/${avaliaveis} = ${pct(acertos, avaliaveis)}\n`);

    console.log('── matriz de confusão (gabarito → lido) ──────────────────────');
    const ord = [...confusao].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of ord) {
        const [gab, lido] = k.split('→');
        const marca = gab === lido ? ' ok ' : ' ERRO';
        console.log(`  ${marca}  ${gab.padEnd(8)} → ${lido.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, avaliaveis)}`);
    }

    console.log('\n── os erros, com evidência que o classificador usou ──────────');
    const errosOrd = ord.filter(([k]) => { const [g, l] = k.split('→'); return g !== l; });
    for (const [k, n] of errosOrd.slice(0, 10)) {
        console.log(`\n  ${k}  (${n} pares)`);
        for (const e of (exemplos.get(k) || []))
            console.log(`     ${e.arq.slice(0, 66)}\n        planilha:"${e.tipoPl}"  evidência:"${String(e.evid).slice(0, 34)}"  via:${e.org}`);
    }

    console.log('\n── acerto por VIA de classificação ───────────────────────────');
    for (const [org, v] of [...porOrigem].sort((a, b) => b[1].n - a[1].n))
        console.log(`  ${String(org).padEnd(22)} ${String(v.n).padStart(5)} pares   acerto ${pct(v.ok, v.n).padStart(6)}`);

    console.log('\nLEITURA: a matriz diz ONDE o tipo escorrega. Um par gab→lido grande e');
    console.log('sistemático é regra faltando/sobrando; erros espalhados são ruído de OCR.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
