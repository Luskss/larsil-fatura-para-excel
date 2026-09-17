/**
 * _medir/_medir-visao-vence-transcricao.js — em PDF-IMAGEM, a IA que leu a TRANSCRIÇÃO
 * deve sobrescrever o valor que a VISÃO leu do PAPEL?
 *
 * Contexto (17/09/2026). O que a investigação estabeleceu:
 *   - a guarda da linha digitável em `_nf-visao.js:311` FUNCIONA: a IA devolve os 47
 *     dígitos, o DV fecha, e `valorIA` vira o valor decodificado. Dissecando as etapas
 *     isoladas, os Itaú ACERTAM.
 *   - o estrago é a linha 630, que impõe `r.valorTotal` — a IA de TEXTO, que leu a
 *     TRANSCRIÇÃO do papel, uma geração a mais de ruído que a visão.
 *   - o próprio código diz isso em `process-folder.js:509`: "a visão vem ANTES da IA de
 *     texto porque, em PDF-imagem, ela leu o PAPEL e a IA leu a TRANSCRIÇÃO do papel:
 *     uma geração a menos de ruído". A linha 630 contradiz esse princípio.
 *
 * ── Por que esta variante é diferente das 3 que reprovaram ──────────────────
 * [linha-digitavel-vence-o-valor] e [dv-nao-sabe-o-que-foi-pago] faziam a LD vencer
 * SEMPRE, e perdiam em guia pública e boleto com juros, onde a LD diverge do pago por
 * bom motivo. [sobrescrita-do-valor-na-630] usava o veredito da visão como gatilho, que
 * é instável.
 *
 * Esta não impõe a LD nem confia em veredito: só evita que a leitura de SEGUNDA MÃO
 * (transcrição) sobreponha a de PRIMEIRA (papel), e SÓ em PDF-imagem, que é onde a
 * distinção existe. Em PDF com texto nativo nada muda.
 *
 * ── As variantes ────────────────────────────────────────────────────────────
 * A (hoje) : `r.valorTotal` sempre vence na linha 630
 * B (nova) : em PDF-IMAGEM com visão bem-sucedida, o valor da visão permanece;
 *            `r.valorTotal` só preenche se a visão não trouxe valor
 *
 * Régua: gabarito do NOME. Pareado. PERDA = A acerta e B erra.
 * Cada documento é lido `--repeticoes` vezes ([repetir-o-ganho-antes-de-somar]).
 * Reporta ATIVOS e INATIVOS separados ([dv-nao-sabe-o-que-foi-pago]).
 *
 * NÃO GRAVA NADA. CUSTA API.
 *
 * Uso: node _medir/_medir-visao-vence-transcricao.js --n 30 --repeticoes 2
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

const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const { lerPorVisao } = require('../routes/_nf-visao');
const { paraNumero } = require('../routes/_valor-do-pagamento');

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

if (!/const pd = \{ \.\.\.pdComum, 'Valor total': r\.valorTotal > 0/
    .test(fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8'))) {
    throw new Error('a linha 630 mudou — reler antes de medir');
}

const args = process.argv.slice(2);
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 30;
const iR = args.indexOf('--repeticoes');
const REP = iR >= 0 ? parseInt(args[iR + 1], 10) : 2;
const iS = args.indexOf('--semente');
const SEMENTE = iS >= 0 ? parseInt(args[iS + 1], 10) : 1;

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const base = (n) => String(n || '').replace(/#p\d+$/i, '').trim().toLowerCase();
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
function consolidar(vals) {
    const ks = vals.map(v => v == null ? 'null' : v.toFixed(2));
    const c = new Map();
    for (const k of ks) c.set(k, (c.get(k) || 0) + 1);
    const [m] = [...c.entries()].sort((a, b) => b[1] - a[1]);
    return { valor: m[0] === 'null' ? null : Number(m[0]), instavel: c.size > 1 };
}

(async () => {
    // PDF-imagem: onde a visão roda e a distinção papel/transcrição existe.
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const imagens = new Set();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (row.arquivo && /Imagem/i.test(String(row.conteudo || ''))) imagens.add(base(row.arquivo));
        }
    }

    let pdfs = [];
    for (const p of ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026']) {
        const [MM, AAAA] = p.split('.');
        try {
            for (const x of await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`))) {
                if (imagens.has(base(x.name)) && valorDoNomeArquivo(x.name) != null) pdfs.push(x);
            }
        } catch (_) {}
    }
    const amostra = baralhar(pdfs, SEMENTE).slice(0, N);

    console.log(`PDF-imagem com gabarito : ${pdfs.length}`);
    console.log(`amostra                 : ${amostra.length} (semente ${SEMENTE}, ${REP} leitura(s))`);
    console.log(`\nB = em PDF-imagem, o valor da VISÃO não é sobreposto pela IA de texto.`);
    console.log(`NÃO grava no banco.\n`);

    const c = { n: 0, erro: 0, semVisao: 0, inativo: 0, ativo: 0,
                ganho: 0, perda: 0, ambos: 0, instA: 0, instB: 0, semGab: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);
        const buf = fs.readFileSync(pdf.path);

        const vsA = [], vsB = [];
        let falhou = false, semV = false;
        for (let k = 0; k < REP; k++) {
            try {
                const rows = await pf.analyzePdf(pdf, { forceAI: true });
                const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
                if (!r) { falhou = true; break; }
                let pd = {};
                try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}
                vsA.push(paraNumero(pd['Valor total']));

                const rv = await lerPorVisao(buf, pdf.name, vNome);
                if (!rv.campos) { semV = true; vsB.push(vsA[vsA.length - 1]); continue; }
                // B: a visão permanece se trouxe valor; senão cai para o de A.
                const vv = paraNumero(rv.campos['Valor total']);
                vsB.push(vv != null ? vv : vsA[vsA.length - 1]);
            } catch (e) { falhou = true; break; }
        }
        if (falhou || !vsA.length) {
            c.erro++;
            console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ✗ ${pdf.name.slice(0,40)}`);
            continue;
        }
        if (semV) c.semVisao++;

        const A = consolidar(vsA), B = consolidar(vsB);
        if (A.instavel) c.instA++;
        if (B.instavel) c.instB++;
        c.n++;

        if (bate(A.valor, B.valor)) {
            c.inativo++;
            console.log(`[${String(i+1).padStart(2)}/${amostra.length}] =           nome=${BRL(vNome).padStart(13)} A=${BRL(A.valor).padStart(13)}  ${pdf.name.slice(0,26)}`);
            continue;
        }
        c.ativo++;
        const okA = bate(A.valor, vNome), okB = bate(B.valor, vNome);
        let marca;
        if (!okA && okB) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, a: A.valor, b: B.valor, iA: A.instavel, iB: B.instavel }); }
        else if (okA && !okB) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, a: A.valor, b: B.valor, iA: A.instavel, iB: B.instavel }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(A.valor).padStart(13)}${A.instavel?'~':' '} B=${BRL(B.valor).padStart(13)}${B.instavel?'~':' '}  ${pdf.name.slice(0,22)}`);
    }

    console.log(`\n══ a VISÃO não é sobreposta pela transcrição (n=${c.n}) ══════`);
    console.log(`   erro de leitura  : ${c.erro}`);
    console.log(`   visão não leu    : ${c.semVisao}`);
    console.log(`   INATIVOS (A = B) : ${c.inativo}   ← B não muda nada`);
    console.log(`\n   ATIVOS (A ≠ B)   : ${c.ativo}`);
    console.log(`      B ganha       : ${c.ganho}`);
    console.log(`      B PERDE       : ${c.perda}`);
    console.log(`      ambos erram   : ${c.ambos}`);
    console.log(`   instáveis: A=${c.instA}  B=${c.instB}`);
    const dec = c.ganho + c.perda;
    if (dec) console.log(`\n   entre DECIDÍVEIS: ${c.ganho}/${dec} a favor de B (${(100*c.ganho/dec).toFixed(0)}%)`);
    console.log(`   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n}`);

    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.a)}${e.iA?' (instável)':''}  B ${BRL(e.b)}${e.iB?' (instável)':''}`);
    for (const e of exG.slice(0, 10)) console.log(`\n   ganho  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.a)}${e.iA?' (instável)':''}  B ${BRL(e.b)}${e.iB?' (instável)':''}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
