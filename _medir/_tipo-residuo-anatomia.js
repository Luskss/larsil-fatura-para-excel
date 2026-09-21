/**
 * _medir/_tipo-residuo-anatomia.js — os 20 falsos que sobraram, um a um.
 *
 * ESTADO (21/09/2026, pós-variante C): o painel caiu de 240 para 57 alertas, com
 * 20 falsos. Duas famílias concentram 13 deles e são candidatas a conserto:
 *
 *   NF→CTE          10 falsos | 0 procedem   ← teto limpo
 *   FATURA→IMPOSTO   3 falsos | 0 procedem   ← marcador fraco \bGUIA\b
 *
 * As outras (NF→RECIBO 2, NF→FATURA 5) são esparsas e misturam procedentes.
 *
 * ── O que se mede, ANTES de propor regra ────────────────────────────────────
 * Dimensionar o pool ([[dimensionar-o-pool-antes-de-medir]]): para cada família,
 * quem são os documentos, que evidência o classificador usou, e — decisivo — qual
 * é o CONTRAPESO: quantos documentos do acervo seriam atingidos por uma regra que
 * consertasse esses, e quantos deles estão HOJE CERTOS.
 *
 * Ganho possível = falsos da família − certos que a regra estragaria.
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
function carregarTipoBate() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const tipoBate = carregarTipoBate();

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

    const porFamilia = new Map();
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
            if (!gab) continue;
            const arq = x.documento.arquivo;
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;
            const tn = tipoDoNome(arq);
            const classe = tn === gab ? 'falso' : (tn === lido ? 'procede' : 'mudo');
            const fam = `${gab}→${lido}`;
            if (!porFamilia.has(fam)) porFamilia.set(fam, []);
            porFamilia.get(fam).push({ arq, classe, evid: info.evidencia || '—', org: info.origem || '—', tipoPl, periodo });
        }
    }

    for (const fam of ['NF→CTE', 'FATURA→IMPOSTO', 'NF→RECIBO', 'NF→FATURA', 'NFS→RECIBO', 'NFS→FATURA']) {
        const itens = porFamilia.get(fam) || [];
        if (!itens.length) continue;
        const f = itens.filter(i => i.classe === 'falso');
        console.log(`\n${'═'.repeat(74)}`);
        console.log(`${fam}   ${itens.length} alertas — ${f.length} falsos`);
        console.log('═'.repeat(74));
        for (const i of itens) {
            const marca = i.classe === 'falso' ? 'FALSO  ' : (i.classe === 'procede' ? 'procede' : 'mudo   ');
            console.log(`  ${marca} ${i.periodo}  ${i.arq.slice(0, 56)}`);
            console.log(`          planilha="${i.tipoPl}"  evid="${String(i.evid).slice(0, 32)}"  via=${i.org}`);
        }
    }

    // ── CONTRAPESO: quantos docs do acervo cada regra tocaria? ──────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('CONTRAPESO — quantos documentos do ACERVO a regra tocaria');
    console.log('═'.repeat(74));

    // regra candidata A: transportadora classificada CTE × planilha NF/NFS → absolver
    // regra candidata B: FATURA × IMPOSTO quando a evidência do IMPOSTO é o fraco "GUIA"
    let cteTotal = 0, cteCertos = 0, impTotal = 0, impFraco = 0;
    for (const [arq, info] of Object.entries(idx)) {
        if (info.tipo === 'CTE') {
            cteTotal++;
            const tn = tipoDoNome(arq);
            if (tn === 'CTE') cteCertos++;       // o nome concorda: classificação certa
        }
        if (info.tipo === 'IMPOSTO') {
            impTotal++;
            if (/^GUIA$/i.test(String(info.evidencia || '').trim())) impFraco++;
        }
    }
    console.log(`\n  docs classificados CTE no acervo: ${cteTotal}`);
    console.log(`    com "CT-e/DACTE" no nome (classificação confirmada): ${cteCertos}  ${pct(cteCertos, cteTotal)}`);
    console.log(`    sem confirmação no nome:                             ${cteTotal - cteCertos}`);
    console.log(`\n  docs classificados IMPOSTO no acervo: ${impTotal}`);
    console.log(`    cuja evidência é exatamente o marcador FRACO "GUIA": ${impFraco}  ${pct(impFraco, impTotal)}`);
    console.log('\n  → ganho possível = falsos da família − certos que a regra estragaria.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
