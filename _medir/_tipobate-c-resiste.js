/**
 * _medir/_tipobate-c-resiste.js — a variante C resiste ao exame, ou teve sorte?
 *
 * ACHADO (21/09/2026): `_tipobate-simetrico.js` deu à variante C (simétrico
 * RESTRITO ao marcador de acessório) razão 147:1 — mata 147 falsos cegando 1
 * procedente. É bom demais para aceitar sem exame ([[inspecao-anima-medicao-decide]],
 * [[media-agregada-esconde-par-falso]]).
 *
 * Três provas:
 *
 *  1. CIRCULARIDADE. O veredito "falso/procede" usa `tipoDoNome`, e o filtro de C
 *     usa `temAcessorio` — ambos leem o NOME. Se o marcador de acessório só
 *     aparecer em nome que também traz "NF", C estaria se auto-confirmando.
 *     Prova: cruzar os dois sinais e ver se há nome com acessório dizendo FAT.
 *
 *  2. O ÚNICO CEGADO. `LUIZ FELIPE. FAT 3 + AUT` — o nome diz FAT e tem acessório.
 *     É o caso que C perde. Vale 1?
 *
 *  3. ESTABILIDADE POR MÊS. A razão 147:1 é média de 6 meses. Se um mês concentrar
 *     o ganho, a regra é de um layout, não do acervo ([[repetir-o-ganho-antes-de-somar]]).
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
const ACESSORIO_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = nome => ACESSORIO_RE.test(norm(nome));

function carregarTipoBateBase() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    // leva o helper junto (tipoBate passou a depender dele em 21/09/2026)
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const base = carregarTipoBateBase();

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

    // ── prova 1: os dois sinais do nome são independentes? ──────────────────
    // varre o ACERVO INTEIRO (não só pares) e cruza marcador de tipo × acessório
    const cruz = new Map();
    let totalArq = 0;
    for (const mes of Object.keys(c.pasta.arquivosPorMes)) {
        for (const a of c.pasta.arquivosPorMes[mes] || []) {
            totalArq++;
            const tn = tipoDoNome(a.nome) || '(sem tipo)';
            const ac = temAcessorio(a.nome) ? 'com acessório' : 'sem acessório';
            const k = `${tn}|${ac}`;
            cruz.set(k, (cruz.get(k) || 0) + 1);
        }
    }
    console.log('── PROVA 1: o marcador de acessório é independente do tipo? ──');
    console.log(`  acervo: ${totalArq} arquivos\n`);
    console.log('  tipo no nome    com acessório   sem acessório    % com');
    const tipos = [...new Set([...cruz.keys()].map(k => k.split('|')[0]))];
    for (const t of tipos.sort()) {
        const com = cruz.get(`${t}|com acessório`) || 0;
        const sem = cruz.get(`${t}|sem acessório`) || 0;
        console.log(`  ${t.padEnd(14)} ${String(com).padStart(9)} ${String(sem).padStart(15)} ${pct(com, com + sem).padStart(8)}`);
    }
    const fatCom = cruz.get('FATURA|com acessório') || 0;
    const fatSem = cruz.get('FATURA|sem acessório') || 0;
    console.log(`\n  → se FATURA tivesse 0% com acessório, C seria circular.`);
    console.log(`    FATURA com acessório: ${fatCom} de ${fatCom + fatSem} (${pct(fatCom, fatCom + fatSem)}) — sinais ${fatCom > 20 ? 'INDEPENDENTES' : 'suspeitos'}`);

    // ── provas 2 e 3: ganho/custo por MÊS ───────────────────────────────────
    const C = (tb, tp, arq) => base(tb, { tipoBanco: tp }, {})
        || (tb === 'FATURA' && (tp === 'NF' || tp === 'NFS') && temAcessorio(arq));
    const A = (tb, tp) => base(tb, { tipoBanco: tp }, {});

    console.log('\n── PROVA 3: estabilidade mês a mês ───────────────────────────');
    console.log('  mês       alertas base → C    falsos mortos   procedentes cegados');
    let somaG = 0, somaC = 0;
    const cegadosDet = [];
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
        let aA = 0, aC = 0, mortos = 0, cegos = 0;
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[x.documento.arquivo] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab) continue;
            const arq = x.documento.arquivo;
            const tn = tipoDoNome(arq);
            const classe = tn === gab ? 'falso' : (tn === lido ? 'real' : 'mudo');
            const okA = A(lido, gab), okC = C(lido, gab, arq);
            if (!okA) aA++;
            if (!okC) aC++;
            if (!okA && okC) {
                if (classe === 'falso') mortos++;
                if (classe === 'real') { cegos++; cegadosDet.push(`${periodo}  ${gab}→${lido}  ${arq}`); }
            }
        }
        somaG += mortos; somaC += cegos;
        console.log(`  ${periodo}   ${String(aA).padStart(4)} → ${String(aC).padStart(3)}      ${String(mortos).padStart(9)}      ${String(cegos).padStart(14)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(9)}                  ${String(somaG).padStart(9)}      ${String(somaC).padStart(14)}`);
    console.log(`\n  → ganho presente em TODOS os meses? ${somaG > 0 ? 'ver coluna acima' : 'não'}`);

    console.log('\n── PROVA 2: o(s) alerta(s) procedente(s) que C cega ──────────');
    for (const d of cegadosDet) console.log(`  ${d}`);
    console.log('\n  esse é o custo integral da variante C em 6 meses.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
