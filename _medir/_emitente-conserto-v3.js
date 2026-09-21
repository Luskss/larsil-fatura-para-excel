/**
 * _medir/_emitente-conserto-v3.js — atacar a causa DOMINANTE: os centavos.
 *
 * v2 (`_emitente-conserto-v2.js`) corrigiu 75 com 0 regressões, mas **128 nomes
 * continuam com lixo**. Olhando os que sobram, a causa é sempre a mesma e é a
 * DOMINANTE:
 *
 *     032.DOC- 2000,00-2026.01.05.JANICE . RC 901432+ AUT.pdf → "00-2026.01.05.JANICE"
 *
 * O `\b20\d{2}` casa com o **"2000" do VALOR**, não com o ano. O corte acontece
 * ali, sobra ",00-2026.01.05." e o emitente nasce sujo. O lookbehind da v2 não
 * pega este caso porque o "2000" vem depois de um espaço/hífen, não de dígito.
 *
 * ── A ideia da v3 ───────────────────────────────────────────────────────────
 * Preferir SEMPRE a data completa (AAAA.MM.DD ou DD.MM.AAAA) e só cair no ano
 * solto quando nenhuma casar. Hoje a alternância `|` escolhe a PRIMEIRA que casa
 * na posição mais à esquerda — e "2000" (do valor) está mais à esquerda que a
 * data real. Buscar a completa primeiro, em varredura separada, resolve.
 *
 * Bônus: quando o ano solto for usado, exigir que NÃO seja seguido de vírgula
 * (`2000,00` é valor, `2026.` é data).
 *
 * ── O contrapeso ────────────────────────────────────────────────────────────
 * O `\b20\d{2}` solto existe por um motivo: nomes como "2026.ALGAR" só têm o ano.
 * Tirá-lo quebraria esses. Por isso v3 o MANTÉM como último recurso.
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

// separador flexível: o arquivista usa . - e / indistintamente
const SEP = '[.\\-\\/]';
const DATA_COMPLETA = new RegExp(`(?:20\\d{2}${SEP}\\d{2}${SEP}\\d{2}|\\d{2}${SEP}\\d{2}${SEP}20\\d{2})[.\\-]?`);
// ano solto: só quando não é a parte inteira de um valor (2000,00 / 2300.00)
const ANO_SOLTO = /(?<![\d,.])20\d{2}(?![,\d])[.\-]?/;

function extrairEmitenteV3(filename = '') {
    const t = norm(String(filename).replace(/\.pdf$/i, ''));
    let resto = t;
    // 1) a data COMPLETA tem precedência — mesmo que apareça depois do valor
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
}

(async () => {
    const c = h.carregar();
    const todos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) todos.push(a.nome);

    let corrigidos = 0, regress = 0, restaLixo = 0, igual = 0;
    const exReg = [], exCorr = [], exResta = [];
    for (const n of todos) {
        const a = p.extrairEmitente(n), d = extrairEmitenteV3(n);
        const aLixo = a && LIXO.test(a), dLixo = d && LIXO.test(d);
        if (dLixo) { restaLixo++; if (exResta.length < 10) exResta.push([d, n]); }
        if (a === d) { igual++; continue; }
        if (aLixo && !dLixo) { corrigidos++; if (exCorr.length < 14) exCorr.push([a, d]); }
        else if (!aLixo) { regress++; if (exReg.length < 14) exReg.push([a, d, n]); }
    }

    const hoje = todos.filter(n => { const e = p.extrairEmitente(n); return e && LIXO.test(e); }).length;
    console.log(`arquivos: ${todos.length}`);
    console.log(`emitentes com lixo HOJE:  ${hoje}  (${pct(hoje, todos.length)})`);
    console.log(`emitentes com lixo na v3: ${restaLixo}  (${pct(restaLixo, todos.length)})`);
    console.log(`\n  inalterados: ${igual}`);
    console.log(`  CORRIGIDOS:  ${corrigidos}`);
    console.log(`  regressões:  ${regress}`);

    console.log('\n── as REGRESSÕES (cada uma precisa ser aceitável) ──────────');
    if (!exReg.length) console.log('   (nenhuma)');
    for (const [a, d, n] of exReg) {
        console.log(`   "${a}" → "${d}"`);
        console.log(`      ${n.slice(0, 66)}`);
    }

    console.log('\n── amostra dos CORRIGIDOS ──────────────────────────────────');
    for (const [a, d] of exCorr)
        console.log(`   "${String(a).slice(0, 36).padEnd(36)}" → "${String(d).slice(0, 34)}"`);

    console.log('\n── o que AINDA fica com lixo (outra causa) ─────────────────');
    for (const [d, n] of exResta) {
        console.log(`   "${String(d).slice(0, 34)}"`);
        console.log(`      ${n.slice(0, 66)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
