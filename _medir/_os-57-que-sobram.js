/**
 * _medir/_os-57-que-sobram.js — os 57 alertas que ainda chegam ao usuário são erro?
 *
 * ESTADO (21/09/2026): `_o-que-ja-vale-agora.js` mede 240 → 57 alertas de tipo com a
 * variante C de `tipoBate`. Os 183 mortos já foram auditados como falsos
 * ([[tipobate-simetrico-restrito-aprovado]]). Falta a outra metade da pergunta:
 * **os 57 que sobram são divergência REAL ou mais falso positivo?**
 *
 * A armadilha já me pegou duas vezes: em [[nf-para-cte-nao-e-defeito]] e em
 * [[rcb-no-nome-e-numero-nao-tipo]] eu li erro da RÉGUA como erro do motor. Aqui a
 * régua é a planilha (coluna TIPO), não o nome — mas o nome serve de TERCEIRA
 * TESTEMUNHA: ele não participa da classificação, então quando nome e banco
 * concordam contra a planilha, quem errou foi a planilha.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. as 57 famílias (planilha→banco), com contagem
 *   2. para cada alerta, o que a TERCEIRA TESTEMUNHA (nome do arquivo) diz
 *   3. o valor em R$ que cada família representa
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}

// ── a terceira testemunha: o nome do arquivo (régua CORRIGIDA de _residuo-tem-custo) ──
const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|\bRODONAVES\b|PRINCESA DOS CAMPOS|\bACITEL\b|\bCADORE\b/;
function tipoDoNomeV2(nome, evidencia = '') {
    const t = norm(nome), ctx = t + ' ' + norm(evidencia);
    if (/\bNFS-?E?\b/.test(t)) return 'NFS';
    if (/\bCT-?E\b|\bDACTE\b/.test(t)) return 'CTE';
    if (/\bDARF\b|\bGPS\b|\bFGTS\b|\bINSS\b|\bIPVA\b|\bGUIA\b/.test(t)) return 'IMPOSTO';
    if (/\bCONSORCIO\b|\bCOTA\b/.test(t)) return 'CONSORCIO';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t)) return TRANSPORTADOR.test(ctx) ? '' : 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t)) return 'FATURA';
    if (/\bRECIBO\b/.test(t)) return 'RECIBO';
    if (/\b(RCB|RC|REC)\s*\.?\s*\d{3,}/.test(t)) return '';
    if (/\bRCB\b|\bRC\b|\bREC\b/.test(t)) return 'RECIBO';
    return '';
}

function carregarTipoBate() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const tipoBate = carregarTipoBate();
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

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
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE'), iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]); const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    const alertas = [];
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
            const info = idx[base(x.documento.arquivo)] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab) continue;
            const arq = x.documento.arquivo;
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;
            alertas.push({
                periodo, arq, planilha: gab, banco: lido,
                nome: tipoDoNomeV2(arq, info.evidencia),
                evid: String(info.evidencia || '').trim(),
                origem: String(info.origem || '').trim(),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                forn: x.lancamento.entidade || x.lancamento.fornecedor || ''
            });
        }
    }

    console.log('═'.repeat(74));
    console.log(`OS ${alertas.length} ALERTAS QUE AINDA CHEGAM AO USUÁRIO`);
    console.log('═'.repeat(74));

    // ── por família ────────────────────────────────────────────────────────
    const fam = new Map();
    for (const a of alertas) {
        const k = `${a.planilha}→${a.banco}`;
        if (!fam.has(k)) fam.set(k, { n: 0, v: 0, itens: [] });
        const f = fam.get(k); f.n++; f.v += a.valor; f.itens.push(a);
    }
    console.log('\n── por família (planilha → banco) ──────────────────────────');
    for (const [k, f] of [...fam].sort((a, b) => b[1].n - a[1].n))
        console.log(`   ${k.padEnd(20)} ${String(f.n).padStart(3)}   ${brl(f.v).padStart(18)}`);

    // ── a terceira testemunha ──────────────────────────────────────────────
    console.log('\n── o NOME do arquivo (testemunha que não classifica) ───────');
    let confirmaBanco = 0, confirmaPlanilha = 0, mudo = 0, terceiro = 0;
    for (const a of alertas) {
        if (!a.nome) { mudo++; continue; }
        if (a.nome === a.banco) confirmaBanco++;
        else if (a.nome === a.planilha) confirmaPlanilha++;
        else terceiro++;
    }
    console.log(`   nome concorda com o BANCO (planilha errou):    ${String(confirmaBanco).padStart(3)}`);
    console.log(`   nome concorda com a PLANILHA (banco errou):    ${String(confirmaPlanilha).padStart(3)}`);
    console.log(`   nome diz uma TERCEIRA coisa:                   ${String(terceiro).padStart(3)}`);
    console.log(`   nome MUDO (sem marcador):                      ${String(mudo).padStart(3)}`);

    // ── os que o banco realmente errou ─────────────────────────────────────
    console.log('\n── ERRO REAL do classificador (nome + planilha contra ele) ─');
    const erroReal = alertas.filter(a => a.nome && a.nome === a.planilha);
    if (!erroReal.length) console.log('   (nenhum)');
    for (const a of erroReal.sort((x, y) => y.valor - x.valor)) {
        console.log(`\n   ${a.periodo}  ${brl(a.valor).padStart(16)}  ${a.planilha}→${a.banco}`);
        console.log(`      ${a.arq.slice(0, 66)}`);
        console.log(`      evidência="${a.evid}"  origem=${a.origem}`);
    }

    // ── amostra de cada família, para o usuário ver ────────────────────────
    console.log('\n── amostra por família ─────────────────────────────────────');
    for (const [k, f] of [...fam].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`\n   ${k}  (${f.n})`);
        for (const a of f.itens.sort((x, y) => y.valor - x.valor).slice(0, 3))
            console.log(`      ${brl(a.valor).padStart(15)}  nome=${(a.nome || '—').padEnd(8)} ev="${a.evid.slice(0, 14)}"  ${a.arq.slice(0, 44)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
