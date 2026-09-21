/**
 * _medir/_fila-que-sobrou.js — o que o painel está LEGITIMAMENTE acusando?
 *
 * MUDANÇA DE ÂNGULO (21/09/2026): o trabalho de motor chegou ao teto (o próprio
 * PROGRESSO §17.18 diz isso). Depois da variante C o painel caiu de 240 para 57
 * alertas de tipo, e dentro deles há **16 que PROCEDEM** — divergências reais que
 * ninguém conferiu. Em vez de caçar mais defeito, dimensionar o trabalho humano.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * A fila de conferência COMPLETA, não só a de tipo:
 *   1. alertas de TIPO que procedem (o resíduo desta rodada)
 *   2. alertas de VALOR (divergência entre documento e planilha)
 *   3. quanto DINHEIRO cada grupo representa
 *   4. concentração: são muitos fornecedores ou poucos repetidos?
 *
 * O objetivo é responder "quanto trabalho humano sobrou e por onde começar",
 * não "que regra falta". Contagem e VALOR separados, porque
 * [[cortar-escopo-do-painel-reprovado]] mostrou que ler um pelo outro engana.
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
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
// CT-e legítimo: o classificador leu o marcador do papel. Não é fila de conferência
// de defeito — é divergência contábil real ([[nf-para-cte-nao-e-defeito]]).
const EV_CTE_CANONICA = /^(DACTE|CT-?E|MDF-?E|CONHECIMENTO DE TRANSPORTE)$/;

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

    const fila = [];       // o que um humano precisa olhar
    const cteReal = [];    // divergência contábil legítima, separada
    let pares = 0;

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            o._valor = Math.abs(Number(l.valor) || 0);
            o._ent = String(l.entidade || '');
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
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;

            const item = {
                periodo, arq, gab, lido, tipoPl,
                valor: x.lancamento._valor || 0,
                ent: x.lancamento._ent,
                evid: String(info.evidencia || ''),
                org: String(info.origem || ''),
            };
            // CT-e com marcador do papel: divergência real, não defeito
            if (lido === 'CTE' && item.org === 'conteúdo' && EV_CTE_CANONICA.test(norm(item.evid))) {
                cteReal.push(item);
                continue;
            }
            const tn = tipoDoNome(arq);
            item.classe = tn === gab ? 'defeito do classificador'
                        : tn === lido ? 'planilha diverge do papel'
                        : 'indecidível';
            fila.push(item);
        }
    }

    const soma = arr => arr.reduce((s, i) => s + i.valor, 0);

    console.log(`pares conferidos: ${pares}`);
    console.log(`\n${'═'.repeat(70)}`);
    console.log('A FILA DE TIPO, depois dos consertos de hoje');
    console.log('═'.repeat(70));
    console.log(`\n  alertas que sobraram:        ${fila.length + cteReal.length}`);
    console.log(`    frete (CT-e legítimo):     ${String(cteReal.length).padStart(3)}   ${brl(soma(cteReal))}`);
    console.log(`    fila de conferência real:  ${String(fila.length).padStart(3)}   ${brl(soma(fila))}`);

    const porClasse = new Map();
    for (const i of fila) {
        if (!porClasse.has(i.classe)) porClasse.set(i.classe, []);
        porClasse.get(i.classe).push(i);
    }
    console.log('\n── a fila, por natureza ─────────────────────────────────────');
    for (const [k, arr] of [...porClasse].sort((a, b) => b[1].length - a[1].length))
        console.log(`  ${k.padEnd(26)} ${String(arr.length).padStart(3)}   ${brl(soma(arr)).padStart(16)}`);

    console.log('\n── por mês (quanto trabalho por rodada de conferência) ──────');
    const porMes = new Map();
    for (const i of fila) porMes.set(i.periodo, (porMes.get(i.periodo) || 0) + 1);
    for (const m of h.PERIODOS)
        console.log(`  ${m}   ${String(porMes.get(m) || 0).padStart(3)} itens`);
    console.log(`  média: ${(fila.length / h.PERIODOS.length).toFixed(1)} por mês`);

    console.log('\n── concentração: poucos fornecedores ou muitos? ─────────────');
    const porEnt = new Map();
    for (const i of fila) {
        const k = norm(i.ent).slice(0, 28) || '(sem entidade)';
        if (!porEnt.has(k)) porEnt.set(k, { n: 0, v: 0 });
        const e = porEnt.get(k); e.n++; e.v += i.valor;
    }
    const ord = [...porEnt].sort((a, b) => b[1].n - a[1].n);
    console.log(`  fornecedores distintos na fila: ${ord.length}`);
    for (const [k, v] of ord.slice(0, 12))
        console.log(`    ${k.padEnd(30)} ${String(v.n).padStart(2)} itens  ${brl(v.v).padStart(14)}`);

    console.log('\n── os itens de MAIOR VALOR (por onde começar) ───────────────');
    for (const i of [...fila].sort((a, b) => b.valor - a.valor).slice(0, 10)) {
        console.log(`\n  ${brl(i.valor).padStart(15)}  ${i.periodo}  [${i.classe}]`);
        console.log(`     planilha "${i.tipoPl}" (${i.gab})  ×  banco ${i.lido}`);
        console.log(`     ${i.arq.slice(0, 64)}`);
    }

    console.log('\n── o frete, à parte (divergência contábil legítima) ─────────');
    for (const i of cteReal)
        console.log(`  ${brl(i.valor).padStart(12)}  ${i.periodo}  evid="${i.evid}"  ${i.arq.slice(0, 44)}`);
    console.log('\n  Estes NÃO são erro do sistema: o papel é conhecimento de transporte');
    console.log('  e a planilha lança como nota fiscal. É decisão contábil a tomar.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
