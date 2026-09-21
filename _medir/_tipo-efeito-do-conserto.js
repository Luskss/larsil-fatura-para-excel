/**
 * _medir/_tipo-efeito-do-conserto.js — o conserto aplicado faz o que prometeu?
 *
 * CONTEXTO (21/09/2026): a variante C (tipoBate simétrico RESTRITO ao marcador de
 * acessório) foi medida em `_tipobate-simetrico.js` e IMPLEMENTADA em
 * `_baseline.js:tipoBate`. Este script confirma o efeito no CÓDIGO REAL.
 *
 * ── Por que não reusar os scripts anteriores ────────────────────────────────
 * Eles extraem `tipoBate` do fonte ATUAL — que agora já contém o conserto. A
 * "base" deles deixou de ser a base no instante em que editei o arquivo
 * ([[releitura-congela-versao-do-parser]], no espírito: medir contra o fonte vivo
 * mede a si mesmo). Aqui a baseline vem de `git show HEAD:routes/_baseline.js`,
 * que é o código ANTES do conserto, e o "depois" vem do arquivo em disco.
 *
 * Isso também serve de prova de que a edição é a ÚNICA diferença.
 *
 * SOMENTE LEITURA (usa git show, não altera nada).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
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

// extrai tipoBate (+ helper, se houver) de um FONTE qualquer
function tipoBateDe(src, rotulo) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    if (!m) throw new Error(`não achei tipoBate em ${rotulo}`);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return {
        fn: new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm),
        temHelper: !!re,
    };
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');

    const A = tipoBateDe(antesSrc, 'HEAD');
    const D = tipoBateDe(depoisSrc, 'disco');
    console.log(`baseline (git HEAD): helper de acessório ${A.temHelper ? 'PRESENTE' : 'ausente'}`);
    console.log(`atual    (disco):    helper de acessório ${D.temHelper ? 'PRESENTE' : 'ausente'}`);
    if (A.temHelper) { console.log('\n⚠ HEAD já tem o conserto — commitado? a comparação seria vazia.'); }

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

    const st = { antes: { a: 0, f: 0, r: 0, m: 0 }, depois: { a: 0, f: 0, r: 0, m: 0 } };
    const mudou = [];
    let pares = 0;

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
            pares++;

            const arq = x.documento.arquivo;
            const rowB = { arquivo: arq, tipo: lido };
            const nota = { tipoBanco: gab };
            const tn = tipoDoNome(arq);
            const classe = tn === gab ? 'f' : (tn === lido ? 'r' : 'm');

            const okA = A.fn(lido, nota, rowB);
            const okD = D.fn(lido, nota, rowB);
            if (!okA) { st.antes.a++; st.antes[classe]++; }
            if (!okD) { st.depois.a++; st.depois[classe]++; }
            if (okA !== okD) mudou.push({ arq, gab, lido, classe, periodo });
        }
    }

    console.log(`\npares com tipo dos dois lados: ${pares}\n`);
    console.log('               alertas   falsos  procedem   mudos   precisão');
    for (const k of ['antes', 'depois']) {
        const v = st[k];
        console.log(`  ${k.padEnd(12)} ${String(v.a).padStart(5)}   ${String(v.f).padStart(5)}   ${String(v.r).padStart(7)}   ${String(v.m).padStart(5)}   ${pct(v.r, v.a).padStart(7)}`);
    }

    const f = st.antes.f - st.depois.f, rr = st.antes.r - st.depois.r, mm = st.antes.m - st.depois.m;
    console.log(`\n  falsos mortos (ganho)       ${String(f).padStart(4)}`);
    console.log(`  procedentes cegados (custo) ${String(rr).padStart(4)}`);
    console.log(`  mudos mortos                ${String(mm).padStart(4)}`);
    console.log(`  razão                       ${rr ? (f / rr).toFixed(1) + '×' : '∞ (custo zero)'}`);
    console.log(`\n  alertas que mudaram de veredito: ${mudou.length}`);
    console.log(`  (esperado pela medição prévia: 147 falsos mortos, 1 cegado, 35 mudos)`);

    const cegados = mudou.filter(x => x.classe === 'r');
    if (cegados.length) {
        console.log('\n  PROCEDENTES que o conserto cega:');
        for (const x of cegados) console.log(`    ${x.periodo}  ${x.gab}→${x.lido}  ${x.arq.slice(0, 60)}`);
    }

    // sanidade: o conserto só pode AFROUXAR, nunca criar alerta novo
    const novos = mudou.filter(x => {
        const rowB = { arquivo: x.arq, tipo: x.lido };
        return A.fn(x.lido, { tipoBanco: x.gab }, rowB) && !D.fn(x.lido, { tipoBanco: x.gab }, rowB);
    });
    console.log(`\n  SANIDADE — alertas NOVOS criados pelo conserto: ${novos.length} ${novos.length === 0 ? '(ok, só afrouxa)' : '(⚠ inesperado!)'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
