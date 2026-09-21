/**
 * _medir/_tipobate-simetrico.js — VIA 1: tornar `tipoBate` simétrico compensa?
 *
 * CONTEXTO (21/09/2026): medido em `_tipo-alertas-no-painel.js`, o painel emite 240
 * alertas de divergência de tipo e 167 (69,6%) são FALSOS. `tipoBate`
 * (_baseline.js:184) absolve `planilha=FATURA × banco=NF/NFS` (linha 197) mas NÃO o
 * inverso, que é justamente a família de erro dominante (a REGRA DE PACOTE do
 * FULL_PROMPT vira "NF + BOL" em FATURA).
 *
 * ── As variantes ────────────────────────────────────────────────────────────
 *   A  BASE      — tipoBate de produção, como está
 *   B  SIMÉTRICO — absolve também planilha=NF/NFS × banco=FATURA (a via 1 pura)
 *   C  SIMÉTRICO RESTRITO — idem, mas só quando o NOME tem marcador de acessório
 *                  (+BOL/+AUT/+pv), que é a assinatura do pacote nota+boleto
 *   D  SIMÉTRICO + CTE — B mais a absolvição de NF/NFS × CTE (transportadoras:
 *                  10 alertas, 10 falsos, o papel é CT-e e a planilha lança nota)
 *
 * ── O critério de decisão ───────────────────────────────────────────────────
 * Não é "quantos alertas somem" — apagar todos os alertas zeraria o ruído e o valor
 * junto. O que decide é a TROCA: falsos mortos × verdadeiros cegados. Um alerta que
 * procede e some é uma divergência real que o usuário deixa de ver.
 *
 * SOMENTE LEITURA — não altera _baseline.js.
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
const ACESSORIO_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = nome => ACESSORIO_RE.test(norm(nome));

// tipoBate DE PRODUÇÃO, extraído do fonte (não reescrito à mão: se o fonte mudar,
// a medição acompanha em vez de medir uma cópia envelhecida).
function carregarTipoBateBase() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    if (!m) throw new Error('não achei tipoBate — fonte mudou?');
    // leva o helper junto (tipoBate passou a depender dele em 21/09/2026)
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const base = carregarTipoBateBase();

    // As variantes. Assinatura: (tbBanco, tpPlanilha, arquivo) → true = calado.
    const VARIANTES = {
        A_base: (tb, tp) => base(tb, { tipoBanco: tp }, {}),
        B_simetrico: (tb, tp) => base(tb, { tipoBanco: tp }, {})
            || (tb === 'FATURA' && (tp === 'NF' || tp === 'NFS')),
        C_simetrico_restrito: (tb, tp, arq) => base(tb, { tipoBanco: tp }, {})
            || (tb === 'FATURA' && (tp === 'NF' || tp === 'NFS') && temAcessorio(arq)),
        D_simetrico_mais_cte: (tb, tp) => base(tb, { tipoBanco: tp }, {})
            || (tb === 'FATURA' && (tp === 'NF' || tp === 'NFS'))
            || (tb === 'CTE' && (tp === 'NF' || tp === 'NFS')),
    };

    const res = {};
    for (const k of Object.keys(VARIANTES)) res[k] = { alertas: 0, falso: 0, real: 0, mudo: 0 };
    // o que cada variante CEGOU em relação à base, com exemplo
    const cegados = {}; for (const k of Object.keys(VARIANTES)) cegados[k] = [];

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
            const tn = tipoDoNome(arq);
            // veredito do alerta pela terceira testemunha (o nome não classifica nada)
            const classe = tn === gab ? 'falso' : (tn === lido ? 'real' : 'mudo');

            for (const [k, fn] of Object.entries(VARIANTES)) {
                if (fn(lido, gab, arq)) {
                    // calado nesta variante; se a BASE acusava, foi cegado
                    if (!VARIANTES.A_base(lido, gab, arq) && classe === 'real' && cegados[k].length < 8)
                        cegados[k].push(`${gab}→${lido}  ${arq.slice(0, 58)}`);
                    continue;
                }
                res[k].alertas++;
                res[k][classe]++;
            }
        }
    }

    console.log(`pares com tipo dos dois lados: ${pares}\n`);
    console.log('variante                 alertas   falsos  procedem   mudos   precisão do alerta');
    for (const [k, v] of Object.entries(res)) {
        const prec = v.alertas ? pct(v.real, v.alertas) : '—';
        console.log(`  ${k.padEnd(22)} ${String(v.alertas).padStart(5)}   ${String(v.falso).padStart(5)}   ${String(v.real).padStart(7)}   ${String(v.mudo).padStart(5)}   ${prec.padStart(8)}`);
    }

    const A = res.A_base;
    console.log('\n── a TROCA, contra a base ────────────────────────────────────');
    for (const [k, v] of Object.entries(res)) {
        if (k === 'A_base') continue;
        const falsosMortos = A.falso - v.falso;
        const reaisCegados = A.real - v.real;
        const mudosMortos  = A.mudo - v.mudo;
        console.log(`\n  ${k}`);
        console.log(`    falsos MORTOS (ganho)      ${String(falsosMortos).padStart(4)}`);
        console.log(`    procedentes CEGADOS (custo)${String(reaisCegados).padStart(4)}`);
        console.log(`    mudos mortos               ${String(mudosMortos).padStart(4)}`);
        console.log(`    razão ganho/custo          ${reaisCegados ? (falsosMortos / reaisCegados).toFixed(1) + '×' : '∞ (custo zero)'}`);
        if (cegados[k].length) {
            console.log('    os alertas PROCEDENTES que somem:');
            for (const e of cegados[k]) console.log(`       ${e}`);
        }
    }

    console.log('\nLEITURA: a variante boa mata muito falso cegando pouco verdadeiro. Se a');
    console.log('razão for baixa, o alerta perde valor junto com o ruído.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
