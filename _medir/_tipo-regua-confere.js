/**
 * _medir/_tipo-regua-confere.js — o GABARITO de tipo é confiável?
 *
 * PERGUNTA (21/09/2026): `_tipo-versus-gabarito.js` acusou 75,5% de acurácia, com
 * o erro concentrado em NF→FATURA (144) e NFS→FATURA (58), quase todo pela via IA.
 * Antes de tratar isso como defeito do classificador, é preciso saber se a RÉGUA
 * presta — memória do projeto: "gabarito frouxo inventa erro" (7 dos 11 erros de
 * uma medição anterior eram defeito da régua, não do motor).
 *
 * ── A terceira testemunha ───────────────────────────────────────────────────
 * O nome do arquivo traz o marcador de tipo que o ARQUIVISTA escreveu à mão
 * ("NF 96309", "NFS 603", "FAT 225317"). Ele NÃO é usado para classificar (regra
 * do projeto: tipo é 100% conteúdo), o que o torna uma testemunha independente
 * tanto do classificador quanto da planilha.
 *
 * Para cada erro apontado, de que lado o nome do arquivo fica?
 *   nome concorda com o GABARITO   → erro real do classificador
 *   nome concorda com o LIDO       → a planilha é que está frouxa; erro inventado
 *   nome não diz nada              → indecidível, fica fora da conta
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
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}

// O marcador de tipo escrito à mão no nome do arquivo. Exige fronteira de palavra
// (memória: `includes` em dígitos concatenados confirmou 13 casos falsos).
// NFS antes de NF, senão "NFS 603" casa como NF.
function tipoDoNome(nome) {
    const t = norm(nome);
    if (/\bNFS-?E?\b/.test(t))                 return 'NFS';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t))  return 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t))   return 'FATURA';
    if (/\bCT-?E\b|\bDACTE\b/.test(t))         return 'CTE';
    if (/\bRCB\b|\bRECIBO\b|\bREC\b/.test(t))  return 'RECIBO';
    if (/\bDARF\b|\bGPS\b|\bGUIA\b|\bFGTS\b|\bINSS\b/.test(t)) return 'IMPOSTO';
    return '';
}

async function indexarTipo() {
    const cache = path.join(h.CACHE, 'tipo-por-arquivo.json');
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
    throw new Error('rode _tipo-versus-gabarito.js antes (gera o cache)');
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = await indexarTipo();

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
            const ent = norm(r[iEnt]);
            const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    // veredito por par de confusão
    const veredito = new Map();  // `gab→lido` → { proGab, proLido, mudo }
    let avaliaveis = 0, acertos = 0;
    let erroReal = 0, erroInventado = 0, erroMudo = 0;

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
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[x.documento.arquivo] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab || gab === '*') continue;
            avaliaveis++;
            if (gab === lido) { acertos++; continue; }

            const k = `${gab}→${lido}`;
            if (!veredito.has(k)) veredito.set(k, { proGab: 0, proLido: 0, mudo: 0, exGab: [], exLido: [] });
            const v = veredito.get(k);
            const tn = tipoDoNome(x.documento.arquivo);
            if (tn === gab)       { v.proGab++;  erroReal++;      if (v.exGab.length < 4)  v.exGab.push(x.documento.arquivo); }
            else if (tn === lido) { v.proLido++; erroInventado++; if (v.exLido.length < 4) v.exLido.push(x.documento.arquivo); }
            else                  { v.mudo++;    erroMudo++; }
        }
    }

    const erros = avaliaveis - acertos;
    console.log(`avaliáveis ${avaliaveis}   acertos ${acertos} (${pct(acertos, avaliaveis)})   erros ${erros}\n`);
    console.log('── de que lado fica o NOME DO ARQUIVO (testemunha independente) ──');
    console.log(`  erro REAL       (nome confirma o gabarito) ${String(erroReal).padStart(4)}  ${pct(erroReal, erros)}`);
    console.log(`  erro INVENTADO  (nome confirma o lido)     ${String(erroInventado).padStart(4)}  ${pct(erroInventado, erros)}`);
    console.log(`  indecidível     (nome não diz o tipo)      ${String(erroMudo).padStart(4)}  ${pct(erroMudo, erros)}`);

    const decid = erroReal + erroInventado;
    console.log(`\nACURÁCIA CORRIGIDA (só onde a régua foi confirmada pelo nome):`);
    console.log(`  ${acertos + erroInventado}/${acertos + decid} = ${pct(acertos + erroInventado, acertos + decid)}`);

    console.log('\n── por par de confusão ───────────────────────────────────────');
    const ord = [...veredito].sort((a, b) => (b[1].proGab + b[1].proLido + b[1].mudo) - (a[1].proGab + a[1].proLido + a[1].mudo));
    for (const [k, v] of ord) {
        const n = v.proGab + v.proLido + v.mudo;
        console.log(`\n  ${k.padEnd(18)} ${String(n).padStart(4)}  → real ${String(v.proGab).padStart(3)} | inventado ${String(v.proLido).padStart(3)} | mudo ${String(v.mudo).padStart(3)}`);
        for (const e of v.exGab)  console.log(`      REAL      ${e.slice(0, 64)}`);
        for (const e of v.exLido) console.log(`      INVENTADO ${e.slice(0, 64)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
