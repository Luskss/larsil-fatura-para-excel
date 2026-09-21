/**
 * _medir/_emitente-conserto-v2.js — o conserto do emitente, afinado.
 *
 * ESTADO (21/09/2026): `extrairEmitente` devolve emitente com resto de data/valor
 * na frente em **182 de 4.541** arquivos (4%). São DUAS causas distintas:
 *
 *   A. data com HÍFEN (`2026.01-19`, `2026-01-12`): a regex só aceita ponto, cai
 *      no `\b20\d{2}` solto e deixa "01-19- " na frente.
 *   B. os CENTAVOS do valor (`2000,00-2026.01.05.JANICE`): o `\b20\d{2}` casa com
 *      "2000" do VALOR, não com o ano, e sobra ",00-2026.01.05." → "00-2026...".
 *      Esta é a causa DOMINANTE.
 *
 * A v1 (aceitar `.-/` como separador) corrigiu 72 com 1 regressão:
 *
 *     "NASCIMENTO" → "03.10.NASCIMENTO"
 *     131.DOC- 2300.00-2026.03.10.NASCIMENTO . rc imovel 111.pdf
 *
 * Aqui o valor usa PONTO decimal (`2300.00`), então `2300.00-2026` vira uma "data"
 * AAAA.MM-DD falsa e o corte para cedo demais. O conserto precisa ancorar o ANO de
 * verdade, não qualquer 4 dígitos.
 *
 * ── As variantes ────────────────────────────────────────────────────────────
 *   v1  separador flexível `[.\-\/]`
 *   v2  v1 + exigir que o ano comece em 20 E não venha colado a vírgula/dígito
 *       (isto é, ancorar no ANO real, desfazendo as duas causas de uma vez)
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

function fabricar(DATA_RE) {
    return function (filename = '') {
        const t = norm(String(filename).replace(/\.pdf$/i, ''));
        let resto = t;
        const data = t.match(DATA_RE);
        if (data) resto = t.slice(data.index + data[0].length);
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

const VARIANTES = {
    // v1: separador flexível — corrige o hífen, mas confunde 2300.00-2026 com data
    v1_separador: fabricar(/(?:20\d{2}[.\-\/]\d{2}[.\-\/]\d{2}|\d{2}[.\-\/]\d{2}[.\-\/]20\d{2}|\b20\d{2})[.\-]?/),

    // v2: o ANO só vale se NÃO vier precedido de vírgula/ponto decimal (ou seja,
    // não é a parte inteira de um valor). `(?<![\d,.])` rejeita "2300.00-2026"
    // no ponto em que "00" seria o mês, e rejeita o "2000" de "2000,00".
    v2_ancorar_ano: fabricar(/(?:(?<![\d,.])20\d{2}[.\-\/]\d{2}[.\-\/]\d{2}|(?<![\d,.])\d{2}[.\-\/]\d{2}[.\-\/]20\d{2}|(?<![\d,.])\b20\d{2})[.\-]?/),
};

(async () => {
    const c = h.carregar();
    const todos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) todos.push(a.nome);

    console.log(`arquivos: ${todos.length}\n`);
    const hojeComLixo = todos.filter(n => { const e = p.extrairEmitente(n); return e && LIXO.test(e); });
    console.log(`emitentes com lixo HOJE: ${hojeComLixo.length}  (${pct(hojeComLixo.length, todos.length)})\n`);

    console.log('variante          corrigidos   ainda com lixo   regressões');
    const detalhe = {};
    for (const [k, fn] of Object.entries(VARIANTES)) {
        let corrigidos = 0, regress = 0, restaLixo = 0;
        const exReg = [], exCorr = [];
        for (const n of todos) {
            const a = p.extrairEmitente(n), d = fn(n);
            const aLixo = a && LIXO.test(a), dLixo = d && LIXO.test(d);
            if (dLixo) restaLixo++;
            if (a === d) continue;
            if (aLixo && !dLixo) { corrigidos++; if (exCorr.length < 8) exCorr.push([a, d, n]); }
            else if (!aLixo) { regress++; if (exReg.length < 10) exReg.push([a, d, n]); }
        }
        detalhe[k] = { exReg, exCorr };
        console.log(`  ${k.padEnd(17)} ${String(corrigidos).padStart(6)}   ${String(restaLixo).padStart(12)}   ${String(regress).padStart(10)}`);
    }

    for (const [k, v] of Object.entries(detalhe)) {
        console.log(`\n── ${k}: as REGRESSÕES ──────────────────────────────`);
        if (!v.exReg.length) console.log('   (nenhuma)');
        for (const [a, d, n] of v.exReg) {
            console.log(`   "${a}" → "${d}"`);
            console.log(`      ${n.slice(0, 64)}`);
        }
    }

    console.log(`\n── v2: amostra dos corrigidos ───────────────────────────────`);
    for (const [a, d] of detalhe.v2_ancorar_ano.exCorr)
        console.log(`   "${String(a).slice(0, 36)}" → "${String(d).slice(0, 36)}"`);

    console.log('\nLEITURA: a variante boa zera as regressões e reduz o "ainda com lixo".');
    console.log('O que sobrar é nome sem data reconhecível — outro problema, não este.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
