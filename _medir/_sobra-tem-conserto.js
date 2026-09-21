/**
 * _medir/_sobra-tem-conserto.js — as 46 sem testemunha comportam regra?
 *
 * `_57-quem-erra-mesmo.js` fechou: 0 defeitos onde o papel tem marcador. Sobram 46
 * alertas cuja evidência é só "IA: <emitente>" — sem testemunha do papel. As
 * famílias são NF→FATURA (12), NF→RECIBO (11), NFS→RECIBO (11), NFS→FATURA (6),
 * NF/NFS→CTE (6).
 *
 * ── A pergunta ──────────────────────────────────────────────────────────────
 * `tipoBate` já absolve `planilha=NF/NFS × banco=FATURA` COM acessório no nome.
 * Duas extensões candidatas, pela mesma lógica de pacote:
 *
 *   V1. estender o acessório a RECIBO  (`tb=RECIBO && tp=NF/NFS && acessório`)
 *   V2. estender o acessório a CTE     (`tb=CTE && tp=NF/NFS && acessório`)
 *
 * ── DIMENSIONAR ANTES ([[dimensionar-o-pool-antes-de-medir]]) ───────────────
 * ganho possível = alertas que a variante calaria
 * custo possível = alertas PROCEDENTES que ela cegaria
 *
 * O custo é o que decide. Um alerta procedente cegado é pior que dez falsos: o
 * falso o usuário descarta em 2 segundos, o cegado ele nunca vê.
 *
 * Como saber se um alerta é procedente sem abrir o PDF? A EVIDÊNCIA de marcador
 * forte. Se um documento tem ev="RECIBO" e a planilha diz NF, absolvê-lo é correto
 * (o papel é recibo). Se tem ev="DANFE" e o banco gravou RECIBO, cegá-lo seria
 * perder um defeito. Este script conta os dois lados sobre o acervo INTEIRO, não
 * só sobre os pares — a variante age em todo par futuro.
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
const ACESSORIO_NO_NOME_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = a => ACESSORIO_NO_NOME_RE.test(norm(a));

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
function marcadorDoPapel(ev) {
    const e = norm(ev);
    if (/^IA:/.test(e)) return '';
    return MARCADOR_FORTE[e] || '';
}
function carregarTipoBate() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

// as variantes candidatas, sobre o resultado do tipoBate atual
const V1 = (tb, tp, arq) => tb === 'RECIBO' && (tp === 'NF' || tp === 'NFS') && temAcessorio(arq);
const V2 = (tb, tp, arq) => tb === 'CTE'    && (tp === 'NF' || tp === 'NFS') && temAcessorio(arq);

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
            alertas.push({ arq, tp: gab, tb: norm(lido), evid: String(info.evidencia || '').trim(),
                           papel: marcadorDoPapel(info.evidencia), valor: Math.abs(Number(x.lancamento.valor) || 0) });
        }
    }

    console.log('═'.repeat(74));
    console.log(`DIMENSIONAR: ${alertas.length} alertas, duas variantes candidatas`);
    console.log('═'.repeat(74));

    for (const [nome, fn, desc] of [['V1', V1, 'RECIBO + acessório'], ['V2', V2, 'CTE + acessório']]) {
        const pega = alertas.filter(a => fn(a.tb, a.tp, a.arq));
        // dos que pega, quantos o papel CONFIRMA (absolver está certo)
        // e quantos o papel CONTRADIZ (cegaria um defeito)?
        const confirma = pega.filter(a => a.papel && a.papel === a.tb);
        const contradiz = pega.filter(a => a.papel && a.papel !== a.tb);
        const mudo = pega.filter(a => !a.papel);
        console.log(`\n── ${nome}: ${desc} ────────────────────────`);
        console.log(`   alertas que calaria:        ${String(pega.length).padStart(3)}   ${brl(pega.reduce((s, a) => s + a.valor, 0))}`);
        console.log(`     papel CONFIRMA o banco:   ${String(confirma.length).padStart(3)}   (absolver está certo)`);
        console.log(`     papel CONTRADIZ:          ${String(contradiz.length).padStart(3)}   (CEGARIA defeito)`);
        console.log(`     papel mudo:               ${String(mudo.length).padStart(3)}   (não dá para julgar)`);
        for (const a of pega.sort((x, y) => y.valor - x.valor).slice(0, 6))
            console.log(`        ${brl(a.valor).padStart(14)} ${a.tp}→${a.tb} ev="${a.evid.slice(0, 18)}" ${a.arq.slice(0, 40)}`);
    }

    // ── e o que NÃO tem acessório no nome? ─────────────────────────────────
    console.log('\n── os alertas SEM acessório no nome ────────────────────────');
    const semAcess = alertas.filter(a => !temAcessorio(a.arq));
    console.log(`   ${semAcess.length} de ${alertas.length} alertas não têm "+BOL"/"+AUT"/"+PV" no nome.`);
    console.log('   Nenhuma variante de pacote os alcança — o pacote é a premissa.');
    const f = new Map();
    for (const a of semAcess) { const k = `${a.tp}→${a.tb}`; f.set(k, (f.get(k) || 0) + 1); }
    for (const [k, n] of [...f].sort((a, b) => b[1] - a[1]))
        console.log(`      ${k.padEnd(18)} ${String(n).padStart(3)}`);

    console.log(`\n${'═'.repeat(74)}`);
    console.log('TETO DE GANHO');
    console.log('═'.repeat(74));
    const tetoV1 = alertas.filter(a => V1(a.tb, a.tp, a.arq)).length;
    const tetoV2 = alertas.filter(a => V2(a.tb, a.tp, a.arq)).length;
    console.log(`\n   V1 + V2 juntas calariam no máximo ${tetoV1 + tetoV2} de ${alertas.length} alertas.`);
    console.log(`   Restariam ${alertas.length - tetoV1 - tetoV2}.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
