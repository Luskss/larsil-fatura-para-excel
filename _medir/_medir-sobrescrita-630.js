/**
 * _medir/_medir-sobrescrita-630.js — a IA de texto deve sobrescrever o valor que a
 * VISÃO já validou?
 *
 * Contexto (17/09/2026): `process-folder.js:630` faz
 *     const pd = { ...pdComum, 'Valor total': r.valorTotal > 0 ? ... : '' };
 * — sobrescrita INCONDICIONAL, única no arquivo (todos os outros merges escrevem só em
 * campo vazio). Ela apaga a linha digitável validada e a trava do gabarito que
 * `lerPorVisao` aplicou. Ver [pdf-sem-texto-a-visao-chuta].
 *
 * ── As duas variantes ───────────────────────────────────────────────────────
 * A (hoje) : r.valorTotal sempre vence; se a IA não leu, grava ''
 * B (nova) : r.valorTotal NÃO vence quando a visão já gravou um 'Valor total' com
 *            veredito 'bate' (isto é, conferido contra o gabarito do nome)
 *
 * B é deliberadamente estreita: só protege o que a visão JÁ conferiu contra o nome do
 * arquivo. Não é "a visão vence sempre" — seria trocar um atropelo por outro.
 *
 * Régua: o gabarito do NOME do arquivo. Pareado — só contam os casos em que A e B
 * discordam. PERDA = A acerta e B erra.
 *
 * Alvo: PDF-IMAGEM (onde a visão roda). Em PDF com texto nativo a visão não entra e as
 * duas variantes são idênticas, então medir ali só diluiria o resultado.
 *
 * NÃO GRAVA NADA. CUSTA API (visão + IA de texto por documento).
 *
 * Uso:
 *   node _medir/_medir-sobrescrita-630.js 06.2026 --n 30
 *   node _medir/_medir-sobrescrita-630.js --imagens --n 40
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const pf = require('../routes/process-folder');
const { lerPorVisao } = require('../routes/_nf-visao');
const { paraNumero } = require('../routes/_valor-do-pagamento');
const { PDFParse } = require('pdf-parse');

const valorDoNomeArquivo = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const L = src.split(/\r?\n/);
    const i = L.findIndex(x => x.startsWith('function valorDoNomeArquivo'));
    let f = -1;
    for (let j = i + 1; j < L.length; j++) if (L[j] === '}') { f = j; break; }
    const mod = { exports: {} };
    new Function('module', `${L.slice(i, f + 1).join('\n')}\nmodule.exports = valorDoNomeArquivo;`)(mod);
    return mod.exports;
})();
if (valorDoNomeArquivo('008.DOC- 5977,98 - x.pdf') !== 5977.98) throw new Error('régua quebrada');

// A linha 630 ainda existe? Se alguém já consertou, esta medição não faz sentido.
(() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    if (!/const pd = \{ \.\.\.pdComum, 'Valor total': r\.valorTotal > 0/.test(src)) {
        throw new Error('a sobrescrita da linha 630 não está mais lá — remedir não faz sentido');
    }
})();

const args = process.argv.slice(2);
const PERIODO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
const TODAS_IMAGENS = args.includes('--imagens');
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 30;
const iS = args.indexOf('--semente');
const SEMENTE = iS >= 0 ? parseInt(args[iS + 1], 10) : 1;
if (!PERIODO && !TODAS_IMAGENS) { console.error('informe MM.AAAA ou --imagens'); process.exit(1); }

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const BRL = (v) => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

function baralhar(arr, semente) {
    let s = semente;
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function semTextoNativo(p) {
    try {
        const parser = new PDFParse({ data: fs.readFileSync(p.path) });
        try { const t = (await parser.getText()).text || ''; return t.replace(/--\s*\d+\s+of\s+\d+\s*--/g, '').trim().length < 40; }
        finally { await parser.destroy(); }
    } catch (_) { return false; }
}

(async () => {
    const periodos = TODAS_IMAGENS ? ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026'] : [PERIODO];
    let pdfs = [];
    for (const p of periodos) {
        const [MM, AAAA] = p.split('.');
        try { pdfs.push(...await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`))); }
        catch (_) {}
    }
    const comGab = pdfs.filter(p => valorDoNomeArquivo(p.name) != null);

    // Filtra PDF-imagem ANTES de sortear, senão a amostra vira 90% texto nativo (onde
    // A e B são idênticas por construção) e o custo em API não compra informação.
    console.log(`varrendo ${comGab.length} documentos com gabarito, atrás de PDF-imagem...`);
    const imagens = [];
    for (const p of baralhar(comGab, SEMENTE)) {
        if (imagens.length >= N) break;
        if (await semTextoNativo(p)) imagens.push(p);
    }

    console.log(`período : ${TODAS_IMAGENS ? 'todos (--imagens)' : PERIODO}`);
    console.log(`amostra : ${imagens.length} PDF-imagem (semente ${SEMENTE})`);
    console.log(`NÃO grava no banco.\n`);
    if (!imagens.length) { console.log('nada a medir.'); process.exit(0); }

    const c = { n: 0, erro: 0, semVisao: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < imagens.length; i++) {
        const pdf = imagens[i];
        const vNome = valorDoNomeArquivo(pdf.name);

        // A = o pipeline como está
        let vA = null;
        try {
            const rows = await pf.analyzePdf(pdf, { forceAI: true });
            const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
            if (r) {
                let pd = {};
                try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}
                vA = paraNumero(pd['Valor total']);
            }
        } catch (e) {
            c.erro++;
            console.log(`[${String(i+1).padStart(2)}/${imagens.length}] ✗ ${pdf.name.slice(0,42)} — ${e.message.slice(0,40)}`);
            continue;
        }

        // B = a visão, quando conferida contra o gabarito, é preservada
        let vB = vA;
        try {
            const rv = await lerPorVisao(fs.readFileSync(pdf.path), pdf.name, vNome);
            if (rv.campos && rv.veredito === 'bate') {
                const vv = paraNumero(rv.campos['Valor total']);
                if (vv != null) vB = vv;
            } else if (!rv.campos) c.semVisao++;
        } catch (_) { c.semVisao++; }

        c.n++;
        const okA = bate(vA, vNome), okB = bate(vB, vNome);
        let marca = '=';
        if (bate(vA, vB)) c.iguais++;
        else if (!okA && okB) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, vA, vB }); }
        else if (okA && !okB) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, vA, vB }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(2)}/${imagens.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(vA).padStart(13)} B=${BRL(vB).padStart(13)}  ${pdf.name.slice(0,28)}`);
    }

    console.log(`\n══ preservar o valor da VISÃO conferida (n=${c.n}) ═══════════`);
    console.log(`   erro de leitura : ${c.erro}`);
    console.log(`   visão não leu   : ${c.semVisao}`);
    console.log(`   A e B iguais    : ${c.iguais}`);
    console.log(`\n   GANHO (A erra, B acerta) : ${c.ganho}`);
    console.log(`   PERDA (A acerta, B erra) : ${c.perda}   ← olhar caso a caso`);
    console.log(`   ambos erram              : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n}`);
    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}`);
    for (const e of exG.slice(0, 10)) console.log(`\n   ganho  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
