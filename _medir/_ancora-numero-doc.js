/**
 * _medir/_ancora-numero-doc.js — achar o valor pelo NÚMERO DA FATURA no texto.
 *
 * O usuário insistiu ("não dá pra diferenciar pela fatura mesmo?") e estava certo: eu
 * havia concluído que o número da fatura não estava no PDF, olhando só os primeiros
 * 1.800 caracteres da página 1 (a Ordem de Compra). Nos PDFs que trazem o BOLETO, o
 * número está lá — e ao lado do valor DAQUELA fatura:
 *
 *     Data Doc   Número Doc   Valor do documento
 *     11/10/25   242502       125,00
 *     11/11/25   245612        75,00
 *
 * Isso é uma âncora determinística: o número vem do NOME do arquivo (que a
 * contabilidade digitou), acha-se ele no texto, e o valor é o número monetário mais
 * próximo. Não depende de IA e não depende de o valor ser "o mais destacado".
 *
 * ── O que se mede aqui ───────────────────────────────────────────────────────
 * Em TODO o acervo, não só BIOS NET:
 *   1. em quantos documentos o número do nome aparece no texto do PDF
 *   2. quando aparece, o valor vizinho bate com o gabarito?
 *   3. GANHA/PERDE contra a regra vigente e contra a regra proposta
 *
 * A âncora só se aplica quando o número É encontrado — nos outros, a regra anterior
 * continua valendo. Por isso ela não pode PERDER muito: só age onde tem evidência.
 *
 * SOMENTE LEITURA — não grava nada.
 *
 * Uso: node _medir/_ancora-numero-doc.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const pare = require('../routes/_pareamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const QUANTOS = parseInt(process.argv[2], 10) || 120;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const N = (pd, k) => j.num(pd[k]);
const hoje = (pd) => j.num(primeiro(pd, ROT_VALOR));
const proposta = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};

const RE_MOEDA = /\d{1,3}(?:\.\d{3})*,\d{2}/g;

/**
 * A âncora: acha o número da fatura no texto e devolve o valor monetário mais próximo
 * DEPOIS dele (o layout do boleto põe "Número Doc <n> ... Valor do documento <v>").
 * Ignora ocorrências dentro da linha digitável (sequências longas de dígitos), onde o
 * número aparece por acaso.
 */
function valorPelaAncora(text, numero) {
    const num = String(numero || '').replace(/\D/g, '');
    if (num.length < 4) return null;
    const t = String(text);
    const achados = [];
    let from = 0;
    for (;;) {
        const i = t.indexOf(num, from);
        if (i < 0) break;
        from = i + num.length;
        // descarta se estiver colado em mais dígitos (linha digitável / nosso número)
        const antes = t[i - 1] || ' ', depois = t[i + num.length] || ' ';
        if (/\d/.test(antes) || /\d/.test(depois)) continue;
        achados.push(i);
    }
    if (!achados.length) return null;

    // Para cada ocorrência, o 1º valor monetário numa janela à frente.
    const cands = [];
    for (const i of achados) {
        const janela = t.slice(i, i + 260);
        const m = janela.match(RE_MOEDA);
        if (m && m.length) {
            for (const v of m.slice(0, 3)) {
                const n = j.num(v);
                if (n != null && n > 0) cands.push(n);
            }
        }
    }
    if (!cands.length) return null;
    // o mais frequente entre os vizinhos; empate → o primeiro
    const cont = new Map();
    for (const c of cands) cont.set(c, (cont.get(c) || 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Versão com SANIDADE. As 3 perdas da 1ª medição têm assinatura comum: a âncora
 * devolveu 1,70 / 0,08 / 0,50 onde o documento vale centenas. São juros ao dia e
 * multa — que no boleto ficam logo depois do número ("cobrar juros de R$ 0,04 ao
 * dia"), dentro da janela.
 *
 * Duas travas, ambas sem consultar o gabarito (senão a medição vira circular):
 *   - descarta candidato < 1% do maior valor monetário do documento
 *   - descarta janela que contenha JUROS/MULTA/MORA antes do número
 */
const RE_ENCARGO = /\b(JUROS?|MULTA|MORA|DESCONTO|ABATIMENTO|AO\s*DIA)\b/i;
function valorPelaAncoraSensata(text, numero) {
    const num = String(numero || '').replace(/\D/g, '');
    if (num.length < 4) return null;
    const t = String(text);

    // teto do documento: o maior valor monetário presente
    const todosV = (t.match(RE_MOEDA) || []).map(j.num).filter(v => v != null);
    if (!todosV.length) return null;
    const teto = Math.max(...todosV);
    const piso = teto * 0.01;

    const cands = [];
    let from = 0;
    for (;;) {
        const i = t.indexOf(num, from);
        if (i < 0) break;
        from = i + num.length;
        const antes = t[i - 1] || ' ', depois = t[i + num.length] || ' ';
        if (/\d/.test(antes) || /\d/.test(depois)) continue;

        const janela = t.slice(i, i + 260);
        const m = janela.match(RE_MOEDA) || [];
        for (let k = 0; k < Math.min(m.length, 3); k++) {
            const n = j.num(m[k]);
            if (n == null || n <= 0 || n < piso) continue;
            // o trecho entre o número e este valor fala de encargo?
            const pos = janela.indexOf(m[k]);
            if (RE_ENCARGO.test(janela.slice(0, pos))) continue;
            cands.push(n);
        }
    }
    if (!cands.length) return null;
    const cont = new Map();
    for (const c of cands) cont.set(c, (cont.get(c) || 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    const doc = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;
            const base = path.basename(arq);
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null || g.numero == null) continue;   // precisa dos dois
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            doc.set(base, { pd, gab: g.valor, num: g.numero, base, tipo: x.tipo });
        }
    console.log(`documentos fiscais com valor E número no nome: ${doc.size}`);

    // Prioriza os que a regra proposta ainda erra — é onde a âncora precisa provar
    // que ajuda. Mas inclui também acertos, para medir a PERDA.
    const todos = [...doc.values()];
    const erram = todos.filter(l => j.jValor(proposta(l.pd), l.gab) !== 'ok');
    const acertam = todos.filter(l => j.jValor(proposta(l.pd), l.gab) === 'ok');
    const amostra = [...erram.slice(0, Math.ceil(QUANTOS * 0.6)),
                     ...acertam.slice(0, Math.floor(QUANTOS * 0.4))];
    console.log(`   a proposta erra em ${erram.length}, acerta em ${acertam.length}`);
    console.log(`   amostra: ${amostra.length} (60% dos que erram, 40% dos que acertam)\n`);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    let comAncora = 0, semAncora = 0, semArq = 0;
    let ancOk = 0, ancErro = 0;
    let ganha = 0, perde = 0, igual = 0;
    const exG = [], exP = [];

    for (const l of amostra) {
        const abs = idx.get(l.base);
        if (!abs) { semArq++; continue; }
        let text = '';
        try {
            const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
            const res = await p.getText();
            try { await p.destroy(); } catch (_) {}
            text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        } catch (_) { continue; }

        const v = valorPelaAncoraSensata(text, l.num);
        if (v == null) { semAncora++; continue; }
        comAncora++;
        const cAnc = j.jValor(v, l.gab);
        if (cAnc === 'ok') ancOk++; else ancErro++;

        const cProp = j.jValor(proposta(l.pd), l.gab);
        if (cAnc === 'ok' && cProp !== 'ok') {
            ganha++;
            if (exG.length < 10) exG.push({ ...l, v, prop: proposta(l.pd) });
        } else if (cAnc !== 'ok' && cProp === 'ok') {
            perde++;
            if (exP.length < 10) exP.push({ ...l, v, prop: proposta(l.pd) });
        } else igual++;
    }

    console.log('ALCANCE DA ÂNCORA');
    console.log(`   número do nome ACHADO no texto: ${comAncora}`);
    console.log(`   não achado (âncora não age):    ${semAncora}`);
    console.log(`   arquivo ausente:                ${semArq}`);
    if (comAncora) {
        console.log(`\nQUANDO A ÂNCORA AGE (${comAncora} casos)`);
        console.log(`   acerta o gabarito: ${ancOk}  (${(100 * ancOk / comAncora).toFixed(0)}%)`);
        console.log(`   erra:              ${ancErro}`);
        console.log(`\nCONTRA A REGRA PROPOSTA`);
        console.log(`   GANHA: ${ganha}   PERDE: ${perde}   igual: ${igual}` +
            `   líquido: ${ganha - perde > 0 ? '+' : ''}${ganha - perde}`);
    }
    if (exG.length) {
        console.log('\n   exemplos de GANHO:');
        for (const e of exG)
            console.log(`      nome=${String(e.gab).padStart(10)}  proposta=${String(e.prop).padStart(11)}` +
                ` → âncora=${String(e.v).padStart(10)}  ${e.base.slice(0, 34)}`);
    }
    if (exP.length) {
        console.log('\n   exemplos de PERDA:');
        for (const e of exP)
            console.log(`      nome=${String(e.gab).padStart(10)}  proposta=${String(e.prop).padStart(11)}` +
                ` → âncora=${String(e.v).padStart(10)}  ${e.base.slice(0, 34)}`);
    }
    process.exit(0);
})();
