/**
 * _medir/_amostra-ia-vs-local.js — vale a pena reler com IA o que hoje só tem leitura
 * de parser LOCAL?
 *
 * Contexto (17/09/2026): por documento no disco, a cobertura de IA é desigual —
 * 01 e 03.2026 têm 100%, mas 04.2026 tem 385 documentos "só-local" e 06.2026 tem 524,
 * além de 197 nunca lidos. Antes de gastar ~US$ 3 e reescrever 1.225 linhas, medir se
 * a IA de fato lê melhor ESTES documentos.
 *
 * `ia-vence-o-parser-local-no-valor` mede 121×9 pareado, mas em OUTRO conjunto —
 * e `ancora-da-fatura-e-de-contexto` registra o custo de extrapolar de um conjunto
 * para outro. Por isso: amostra deste, antes do lote todo.
 *
 * ── A régua ─────────────────────────────────────────────────────────────────
 * Valor do NOME do arquivo (digitado à mão pela equipe, leitura independente) contra:
 *   LOCAL = o que está gravado no banco hoje
 *   IA    = `analyzePdf(pdf, {forceAI:true})` agora, sem gravar
 *
 * Pareado: só contam os documentos em que os dois discordam.
 *   GANHO = local erra, IA acerta
 *   PERDA = local acerta, IA erra   ← se for alto, NÃO releia
 *
 * NÃO GRAVA NADA. `analyzePdf` devolve as rows; quem persiste é `upsertRelatorio`,
 * que este script não chama.
 *
 * Uso:
 *   node _medir/_amostra-ia-vs-local.js 06.2026 --n 40
 *   node _medir/_amostra-ia-vs-local.js 04.2026 --n 40 --semente 7
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

const args = process.argv.slice(2);
const PERIODO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 40;
const iS = args.indexOf('--semente');
const SEMENTE = iS >= 0 ? parseInt(args[iS + 1], 10) : 1;
if (!PERIODO) { console.error('informe MM.AAAA'); process.exit(1); }

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const base = (n) => String(n || '').replace(/#p\d+$/i, '').trim().toLowerCase();
const BRL = (v) => v == null ? '—' : 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

// Sorteio determinístico: a mesma semente devolve a mesma amostra, para poder repetir
// a medição sobre os mesmos documentos.
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

(async () => {
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const porNome = new Map();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            const k = base(row.arquivo);
            if (!porNome.has(k)) porNome.set(k, []);
            porNome.get(k).push(row);
        }
    }

    const [MM, AAAA] = PERIODO.split('.');
    const pdfs = await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`));

    // Alvo: tem row no banco, NENHUMA dela é origem IA, e tem valor no nome (senão não
    // há régua). Documento ausente do banco fica de fora — ali não há "local" a comparar.
    const alvo = pdfs.filter(p => {
        const rows = porNome.get(base(p.name));
        if (!rows || !rows.length) return false;
        if (rows.some(r => /\bIA\b/i.test(String(r.origem || '')))) return false;
        return valorDoNomeArquivo(p.name) != null;
    });

    const amostra = baralhar(alvo, SEMENTE).slice(0, N);
    console.log(`período      : ${PERIODO}`);
    console.log(`só-local com gabarito: ${alvo.length}`);
    console.log(`amostra      : ${amostra.length} (semente ${SEMENTE})`);
    console.log(`NÃO grava no banco.\n`);
    if (!amostra.length) { console.log('nada a medir.'); process.exit(0); }

    const c = { n: 0, erro: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0, localVazio: 0, iaVazio: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);
        const rows = porNome.get(base(pdf.name)) || [];
        let pdLocal = {};
        try { pdLocal = JSON.parse(rows[0].dados_parser || '{}') || {}; } catch (_) {}
        const vLocal = paraNumero(pdLocal['Valor total']);

        let vIA = null;
        try {
            const novas = await pf.analyzePdf(pdf, { forceAI: true });
            const r = (novas || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (novas || [])[0];
            if (r) {
                let pd = {};
                try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}
                vIA = paraNumero(pd['Valor total']);
            }
        } catch (e) {
            c.erro++;
            console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ✗ ${pdf.name.slice(0, 46)} — ${e.message.slice(0, 50)}`);
            continue;
        }

        c.n++;
        if (vLocal == null) c.localVazio++;
        if (vIA == null) c.iaVazio++;
        const okL = bate(vLocal, vNome), okI = bate(vIA, vNome);
        let marca = '=';
        if (bate(vLocal, vIA)) c.iguais++;
        else if (!okL && okI) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, vLocal, vIA }); }
        else if (okL && !okI) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, vLocal, vIA }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(14)} local=${BRL(vLocal).padStart(14)} ia=${BRL(vIA).padStart(14)}  ${pdf.name.slice(0, 34)}`);
    }

    console.log(`\n══ IA vs PARSER LOCAL (${PERIODO}, n=${c.n}) ═════════════════`);
    console.log(`   erro de leitura   : ${c.erro}`);
    console.log(`   valor idêntico    : ${c.iguais}`);
    console.log(`   local sem valor   : ${c.localVazio}`);
    console.log(`   IA sem valor      : ${c.iaVazio}`);
    console.log(`\n   GANHO (local erra, IA acerta) : ${c.ganho}`);
    console.log(`   PERDA (local acerta, IA erra) : ${c.perda}   ← se alto, NÃO releia`);
    console.log(`   ambos erram                   : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n}`);
    if (c.n) console.log(`   extrapolando para ${alvo.length} só-locais: ~${Math.round((c.ganho - c.perda) / c.n * alvo.length)} documentos`);

    for (const e of exP.slice(0, 6)) console.log(`\n   PERDA  ${e.n.slice(0, 60)}\n      nome ${BRL(e.vNome)}  local ${BRL(e.vLocal)}  IA ${BRL(e.vIA)}`);
    for (const e of exG.slice(0, 6)) console.log(`\n   ganho  ${e.n.slice(0, 60)}\n      nome ${BRL(e.vNome)}  local ${BRL(e.vLocal)}  IA ${BRL(e.vIA)}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
