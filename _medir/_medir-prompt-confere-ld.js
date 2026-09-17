/**
 * _medir/_medir-prompt-confere-ld.js — o PROMPT pode conferir o valor contra a linha
 * digitável que ele mesmo está lendo?
 *
 * Contexto (17/09/2026). Todas as tentativas anteriores mexiam em PRECEDÊNCIA (quem
 * vence depois que os dois números existem) e reprovaram:
 *   [linha-digitavel-vence-o-valor] +1/68 · [sobrescrita-do-valor-na-630] +1/51 ·
 *   [dv-nao-sabe-o-que-foi-pago] 1 perda em 5 ativos.
 *
 * Esta ataca a ORIGEM. Inspecionando a resposta crua da visão nos boletos Itaú:
 *     ondeAcheiOValor = "Valor do Documento"   ← campo CERTO
 *     valorTotal      = 166.13                 ← papel diz 13.166,11
 * A IA olha o lugar certo e erra a TRANSCRIÇÃO — truncamento de milhar, estável entre
 * execuções. E na MESMA resposta ela devolve a linha digitável, cujas posições 37-46
 * carregam o valor. Ela tem a prova na mão e não a usa.
 *
 * ── As duas variantes ───────────────────────────────────────────────────────
 * A (hoje) : PROMPT de produção
 * B (nova) : PROMPT + instrução de conferir valorTotal contra as posições 37-46 da
 *            linha digitável ANTES de responder, e corrigir se divergir
 *
 * Isto NÃO é precedência: nada no código muda, e a linha digitável não "vence" nada.
 * É a IA conferindo o próprio trabalho contra um campo verificável da mesma página —
 * e só onde existe boleto, que é onde a conferência é possível.
 *
 * Régua: gabarito do NOME. Pareado. PERDA = A acerta e B erra.
 * Cada documento é lido `--repeticoes` vezes em CADA variante: a instabilidade da
 * leitura foi o que invalidou duas medições anteriores ([repetir-o-ganho-antes-de-somar]).
 *
 * Alvo: PDF-IMAGEM com linha digitável — onde a visão roda E há o que conferir.
 *
 * NÃO GRAVA NADA. CUSTA API (2 variantes × repetições × documentos).
 *
 * Uso: node _medir/_medir-prompt-confere-ld.js --n 25 --repeticoes 2
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
const { paginasEmPng } = require('../routes/_nf-visao');
const { callOpenAI } = require('../routes/_helpers');

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

// O prompt de produção sai do FONTE — uma cópia envelheceria em silêncio.
const PROMPT_A = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', '_nf-visao.js'), 'utf8');
    const i = src.indexOf('const PROMPT = `');
    const f = src.indexOf('`;', i);
    if (i < 0 || f < 0) throw new Error('não achei o PROMPT no fonte');
    return src.slice(i + 'const PROMPT = `'.length, f);
})();
if (!/ondeAcheiOValor/.test(PROMPT_A) || !/linhaDigitavel/.test(PROMPT_A) || PROMPT_A.length < 800) {
    throw new Error('PROMPT fatiado do fonte parece errado');
}

// A única diferença de B. Acrescentada ao FIM, para não reordenar o que já funciona
// ([remendo-de-prompt-quebra-o-que-funciona]: mexer no meio quebrou o que ia bem).
const EXTRA_B = `

CONFERÊNCIA OBRIGATÓRIA DO VALOR (só quando há linha digitável de boleto):
A linha digitável de 47 dígitos codifica o valor nas 10 ÚLTIMAS posições, em CENTAVOS.
Exemplo: "...1464 0001316611" → os 10 últimos são 0001316611 → 1316611 centavos →
R$ 13.166,11.
Antes de responder:
  1. conte os dígitos da linha digitável que você copiou (tem de ser 47);
  2. pegue os 10 ÚLTIMOS, leia como centavos;
  3. compare com o valorTotal que você leu do campo impresso.
Se os dois DIVERGIREM, o valor da linha digitável é o correto — corrija valorTotal
para ele e escreva em ondeAcheiOValor: "linha digitável (corrigi o valor lido)".
Se não houver linha digitável, ignore esta conferência.`;

const args = process.argv.slice(2);
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 25;
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

async function perguntar(prompt, imgs) {
    const r = await callOpenAI(process.env.OPENAI_API_KEY, {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            ...imgs.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
        ]}],
        max_tokens: 900,
        temperature: 0,
    });
    if (!r.ok || r.httpCode !== 200) return { erro: `HTTP ${r.httpCode}` };
    let env = null;
    try { env = JSON.parse(r.body); } catch (_) { return { erro: 'envelope não-JSON' }; }
    const txt = (env.choices && env.choices[0] && env.choices[0].message && env.choices[0].message.content) || '';
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { j = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    if (!j) return { erro: 'conteúdo não-JSON' };
    const n = Number(j.valorTotal);
    return { valor: Number.isFinite(n) && n > 0 ? n : null, onde: j.ondeAcheiOValor || '', ld: String(j.linhaDigitavel || '') };
}

// Moda das repetições; devolve também se houve divergência entre elas.
function consolidar(vals) {
    const chaves = vals.map(v => v == null ? 'null' : v.toFixed(2));
    const cont = new Map();
    for (const k of chaves) cont.set(k, (cont.get(k) || 0) + 1);
    const [melhor] = [...cont.entries()].sort((a, b) => b[1] - a[1]);
    return { valor: melhor[0] === 'null' ? null : Number(melhor[0]), instavel: cont.size > 1 };
}

(async () => {
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const alvo = new Set();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
            const ld = String(pd['Linha digitável'] || '').replace(/\D/g, '');
            // PDF-imagem (a visão só roda aí) COM boleto (onde há o que conferir).
            if (ld.length === 47 && /Imagem/i.test(String(row.conteudo || ''))) alvo.add(base(row.arquivo));
        }
    }

    let pdfs = [];
    for (const p of ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026']) {
        const [MM, AAAA] = p.split('.');
        try {
            for (const x of await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`))) {
                if (alvo.has(base(x.name)) && valorDoNomeArquivo(x.name) != null) pdfs.push(x);
            }
        } catch (_) {}
    }
    const amostra = baralhar(pdfs, SEMENTE).slice(0, N);

    console.log(`PDF-imagem com boleto e gabarito : ${pdfs.length}`);
    console.log(`amostra                          : ${amostra.length} (semente ${SEMENTE}, ${REP} leitura(s) por variante)`);
    console.log(`\nB = PROMPT + conferência do valor contra as posições 37-46 da LD.`);
    console.log(`NÃO grava no banco.\n`);

    const c = { n: 0, erro: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0, instA: 0, instB: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);
        let imgs;
        try { imgs = await paginasEmPng(fs.readFileSync(pdf.path), 2); }
        catch (e) { c.erro++; continue; }
        if (!imgs.length) { c.erro++; continue; }

        const rA = [], rB = [];
        for (let k = 0; k < REP; k++) {
            const a = await perguntar(PROMPT_A, imgs);
            const b = await perguntar(PROMPT_A + EXTRA_B, imgs);
            if (a.erro || b.erro) { rA.length = 0; break; }
            rA.push(a.valor); rB.push(b.valor);
        }
        if (!rA.length) {
            c.erro++;
            console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ✗ ${pdf.name.slice(0,40)}`);
            continue;
        }
        const A = consolidar(rA), B = consolidar(rB);
        if (A.instavel) c.instA++;
        if (B.instavel) c.instB++;

        c.n++;
        const okA = bate(A.valor, vNome), okB = bate(B.valor, vNome);
        let marca = '=';
        if (bate(A.valor, B.valor)) c.iguais++;
        else if (!okA && okB) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, a: A.valor, b: B.valor }); }
        else if (okA && !okB) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, a: A.valor, b: B.valor }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(A.valor).padStart(13)}${A.instavel?'~':' '} B=${BRL(B.valor).padStart(13)}${B.instavel?'~':' '}  ${pdf.name.slice(0,24)}`);
    }

    console.log(`\n══ PROMPT confere o valor contra a LD (n=${c.n}) ═════════════`);
    console.log(`   erro de leitura : ${c.erro}`);
    console.log(`   A e B iguais    : ${c.iguais}`);
    console.log(`   instáveis: A=${c.instA}  B=${c.instB}   (~ = variou entre repetições)`);
    console.log(`\n   GANHO (A erra, B acerta) : ${c.ganho}`);
    console.log(`   PERDA (A acerta, B erra) : ${c.perda}`);
    console.log(`   ambos erram              : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n}`);
    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.a)}  B ${BRL(e.b)}`);
    for (const e of exG.slice(0, 10)) console.log(`\n   ganho  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.a)}  B ${BRL(e.b)}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
