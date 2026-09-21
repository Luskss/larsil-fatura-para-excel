/**
 * _medir/_emitente-conserto-v4.js — tolerar o nome malformado, e julgar as 2 regressões.
 *
 * v3 levou o lixo de 203 → 37 (167 corrigidos, 2 regressões). O que sobra é nome
 * digitado torto, e a data continua reconhecível a olho:
 *
 *     2026..02.27   ponto duplo
 *     2026.2.10     mês sem zero à esquerda
 *     2026.12.      dia ausente
 *     202.01.23     ano com 3 dígitos (erro de digitação)
 *     202,6.02.02   vírgula no meio do ano
 *
 * v4 = v3 com a data completa mais tolerante: separador repetível (`[.\-\/]+`) e
 * mês/dia de 1 OU 2 dígitos. NÃO tenta salvar ano de 3 dígitos nem vírgula no ano
 * — isso exigiria adivinhar, e o risco de casar um valor como data cresce.
 *
 * ── As 2 regressões da v3, julgadas ─────────────────────────────────────────
 * 1. `131.DOC- 2300.00-2026.03.10.NASCIMENTO . rc imovel 111.pdf`
 *    "NASCIMENTO" → "03.10.NASCIMENTO"
 *    O valor usa PONTO decimal (2300.00), então "2300.00-2026" casa como
 *    DD.MM.AAAA e o corte para antes da data real. É regressão de verdade.
 *
 * 2. `004.DOC- LARSIL SISPRIME 2024330356.pdf`
 *    "" → "LARSIL SISPRIME"
 *    Hoje devolve VAZIO. A v3 devolve o nome. Isto é MELHORIA classificada como
 *    regressão pelo meu contador, porque o critério era "não tinha lixo antes".
 *    Vale conferir se "LARSIL" é aceitável — é o nome do PAGADOR
 *    ([[emitente-larsil]]), mas o campo hoje está vazio, então não piora nada.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_nf-parsers');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const LIXO = /^[\d\-.,\/\s]{2,}/;

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const TIPO_DOC_RE = /\b(RCB|RC|RECIBO|FAT|FT|FATURA|NFS|NFE|NF|BOL|BOLETO|GUIA|DARF|GPS|INSS|FGTS|CTE|DACTE|IMOVEL|OCP|OC)\b/;
const limpaBordas = s => s.replace(/^[\s.,\-]+|[\s.,\-]+$/g, '').trim();

function fabricar(DATA_COMPLETA, ANO_SOLTO) {
    return function (filename = '') {
        const t = norm(String(filename).replace(/\.pdf$/i, ''));
        let resto = t;
        const completa = t.match(DATA_COMPLETA);
        const ano = t.match(ANO_SOLTO);
        const escolhida = completa || ano;
        if (escolhida) resto = t.slice(escolhida.index + escolhida[0].length);
        else {
            const pref = t.match(/^\d{1,4}\.?DOC[-\s]*[\d.,]*\s*-?\s*/);
            if (pref) resto = t.slice(pref[0].length);
        }
        const tipo = resto.match(TIPO_DOC_RE);
        let nome = limpaBordas(tipo ? resto.slice(0, tipo.index) : resto);
        if (nome.length < 2) nome = limpaBordas(resto);
        nome = limpaBordas(nome.replace(/\s+[A-Z]?\d[\w]*(\s+[A-Z]?\d[\w]*)*$/, ''));
        if (nome.length < 2 || /^[\d.,\s]+$/.test(nome)) return '';
        return nome;
    };
}

const ANO_SOLTO = /(?<![\d,.])20\d{2}(?![,\d])[.\-]?/;

const V3_COMPLETA = /(?:20\d{2}[.\-\/]\d{2}[.\-\/]\d{2}|\d{2}[.\-\/]\d{2}[.\-\/]20\d{2})[.\-]?/;
// v4: separador repetível e mês/dia de 1-2 dígitos; o ano AAAA continua exigido,
// e a forma DD.MM.AAAA ganha um lookbehind para não casar "2300.00-2026".
const V4_COMPLETA = /(?:20\d{2}[.\-\/]+\d{1,2}[.\-\/]+\d{1,2}|(?<![\d,.])\d{1,2}[.\-\/]+\d{1,2}[.\-\/]+20\d{2})[.\-]?/;

const VARIANTES = {
    v3: fabricar(V3_COMPLETA, ANO_SOLTO),
    v4: fabricar(V4_COMPLETA, ANO_SOLTO),
};

(async () => {
    const c = h.carregar();
    const todos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) todos.push(a.nome);

    const hoje = todos.filter(n => { const e = p.extrairEmitente(n); return e && LIXO.test(e); }).length;
    console.log(`arquivos: ${todos.length}`);
    console.log(`com lixo HOJE: ${hoje}  (${pct(hoje, todos.length)})\n`);
    console.log('variante  corrigidos  resta lixo  regressões  vazio→nome');

    const det = {};
    for (const [k, fn] of Object.entries(VARIANTES)) {
        let corr = 0, reg = 0, resta = 0, vazioVirouNome = 0;
        const exReg = [], exCorr = [];
        for (const n of todos) {
            const a = p.extrairEmitente(n), d = fn(n);
            const aLixo = a && LIXO.test(a), dLixo = d && LIXO.test(d);
            if (dLixo) resta++;
            if (a === d) continue;
            if (aLixo && !dLixo) { corr++; if (exCorr.length < 10) exCorr.push([a, d, n]); }
            else if (!a && d) { vazioVirouNome++; }         // estava vazio: é ganho, não perda
            else if (!aLixo) { reg++; if (exReg.length < 10) exReg.push([a, d, n]); }
        }
        det[k] = { exReg, exCorr };
        console.log(`  ${k.padEnd(8)} ${String(corr).padStart(9)} ${String(resta).padStart(11)} ${String(reg).padStart(11)} ${String(vazioVirouNome).padStart(11)}`);
    }

    for (const [k, v] of Object.entries(det)) {
        console.log(`\n── ${k}: REGRESSÕES REAIS (tinha nome bom, virou pior) ──`);
        if (!v.exReg.length) console.log('   (nenhuma)');
        for (const [a, d, n] of v.exReg) {
            console.log(`   "${a}" → "${d}"`);
            console.log(`      ${n.slice(0, 66)}`);
        }
    }

    console.log('\n── v4: o que ela corrige a mais que a v3 ───────────────────');
    const v3fn = VARIANTES.v3, v4fn = VARIANTES.v4;
    let aMais = 0;
    for (const n of todos) {
        const d3 = v3fn(n), d4 = v4fn(n);
        if (d3 === d4) continue;
        const l3 = d3 && LIXO.test(d3), l4 = d4 && LIXO.test(d4);
        if (l3 && !l4) {
            aMais++;
            if (aMais <= 12) console.log(`   "${String(d3).slice(0, 30).padEnd(30)}" → "${String(d4).slice(0, 28)}"`);
        }
    }
    console.log(`   total a mais: ${aMais}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
