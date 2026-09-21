/**
 * _medir/_os-25-sao-parcelas.js — os 25 "valores divergentes" são parcelamento?
 *
 * ACHADO (21/09/2026): `_alerta-de-tipo-esconde-valor.js` mostrou 25 pares
 * silenciados pela variante C onde doc ≠ lançamento. Mas as razões saltam aos olhos:
 *
 *     50.000 / 12.500 = 4,0      21.900 / 5.475  = 4,0
 *     20.000 /  5.000 = 4,0      16.000 / 4.000  = 4,0
 *     13.377 /  4.459 = 3,0       5.604,84/1.401,21 = 4,0
 *
 * Isso é PARCELA, não erro: o nome do arquivo traz o valor da parcela e a planilha
 * lança o total ([[total-da-nota-nao-e-valor-lancado]]). Se confirmar, os 25 não
 * são divergência e a variante C não esconde nada.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Para cada um: lançamento / documento é inteiro (±1%)? E quantos?
 * Um divisor inteiro pequeno (2..12) é assinatura de parcelamento. Um valor
 * quebrado (1,37×) seria erro de leitura de verdade.
 *
 * SOMENTE LEITURA.
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
function tipoBateDe(src) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const antes = tipoBateDe(execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const agora = tipoBateDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8'));

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

    const divergentes = [];
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
            if (!(!antes(lido, { tipoBanco: gab }, { arquivo: arq }) && agora(lido, { tipoBanco: gab }, { arquivo: arq }))) continue;
            const vL = Math.abs(Number(x.lancamento.valor) || 0);
            const vD = Math.abs(Number(x.documento.valor) || 0);
            if (!vD || Math.abs(vL - vD) < 0.02) continue;
            divergentes.push({ arq, vL, vD, forca: x.forca, periodo });
        }
    }

    console.log('═'.repeat(74));
    console.log(`OS ${divergentes.length} COM VALOR DIVERGENTE — parcelamento ou erro?`);
    console.log('═'.repeat(74));

    let inteiro = 0, quebrado = 0;
    const porRazao = new Map();
    const quebrados = [];
    for (const d of divergentes) {
        const razao = d.vL / d.vD;
        const n = Math.round(razao);
        const ehInteiro = n >= 2 && n <= 24 && Math.abs(razao - n) / n < 0.01;
        if (ehInteiro) { inteiro++; porRazao.set(n, (porRazao.get(n) || 0) + 1); }
        else { quebrado++; quebrados.push({ ...d, razao }); }
    }

    console.log(`\n   razão lançamento/documento é INTEIRA (2..24): ${inteiro}  ${pct(inteiro, divergentes.length)}`);
    console.log(`   razão QUEBRADA (candidato a erro real):       ${quebrado}  ${pct(quebrado, divergentes.length)}`);

    console.log('\n── distribuição das razões inteiras (nº de parcelas) ───────');
    for (const [n, q] of [...porRazao].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(n).padStart(2)}× parcelas   ${String(q).padStart(3)} casos`);

    if (quebrados.length) {
        console.log('\n── os de razão QUEBRADA (merecem olhar) ────────────────────');
        for (const q of quebrados.sort((a, b) => b.vL - a.vL)) {
            console.log(`\n   ${q.periodo}  lanç=${brl(q.vL)}  doc=${brl(q.vD)}  razão=${q.razao.toFixed(3)}  força ${q.forca}`);
            console.log(`      ${q.arq.slice(0, 66)}`);
        }
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(74));
    console.log(`\n   ${pct(inteiro, divergentes.length)} dos "divergentes" são PARCELA do total lançado —`);
    console.log('   o nome do arquivo traz a parcela, a planilha traz o total.');
    console.log('   [[total-da-nota-nao-e-valor-lancado]]: isso é esperado, não erro.');
    console.log(`\n   Sobram ${quebrado} caso(s) de razão quebrada para inspeção.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
