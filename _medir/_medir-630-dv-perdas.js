/**
 * _medir/_medir-630-dv-perdas.js — a variante B da linha 630 PERDE alguma coisa?
 *
 * Contexto (17/09/2026): `_medir/_medir-630-dv.js` deu +2 em 51 (que virou +1 real ao
 * repetir os ganhos 3×, ver [repetir-o-ganho-antes-de-somar]). Zero perdas — mas com
 * n=51 e só 2 casos ativos, "zero perdas" pode ser só falta de amostra.
 *
 * Esta medição inverte o foco: em vez de contar ganho, PROCURA PERDA. A variante B só
 * age quando `Valor total` (da IA) difere do valor da linha digitável validada, então
 * é exatamente nesses casos que ela pode errar. Aqui se reúnem TODOS eles e se pergunta
 * quem acerta o gabarito.
 *
 * ── Por que isto é diferente do outro script ─────────────────────────────────
 * O outro sorteava do acervo e media o líquido; os casos ATIVOS (onde A≠B) eram 2 em 51.
 * Este varre muito mais documentos e só reporta os ativos — a taxa de perda entre os
 * ativos é a pergunta real. Uma variante que age em 4% dos documentos e erra em 30%
 * deles é ruim mesmo dando líquido positivo.
 *
 * Cada caso ativo é lido 3× (`--repeticoes`), porque `r.valorTotal` oscila entre
 * execuções e um caso instável inverte a conclusão.
 *
 * Classifica cada ativo:
 *   DV ACERTA / IA ERRA  → ganho de B
 *   IA ACERTA / DV ERRA  → PERDA de B          ← o que este script caça
 *   ambos erram          → indiferente
 *   sem gabarito no nome → não classificável
 *   INSTÁVEL             → A muda entre execuções; não conta para nenhum lado
 *
 * NÃO GRAVA NADA. CUSTA API.
 *
 * Uso: node _medir/_medir-630-dv-perdas.js --n 120
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

function mod10(b) {
    let s = 0, p = 2;
    for (let i = b.length - 1; i >= 0; i--) { let x = Number(b[i]) * p; if (x > 9) x -= 9; s += x; p = p === 2 ? 1 : 2; }
    return s % 10 === 0 ? 0 : 10 - (s % 10);
}
function valorDaLinhaValidada(ld) {
    const d = String(ld || '').replace(/\D/g, '');
    if (d.length !== 47) return null;
    if (mod10(d.slice(0, 9)) !== Number(d[9])) return null;
    if (mod10(d.slice(10, 20)) !== Number(d[20])) return null;
    if (mod10(d.slice(21, 31)) !== Number(d[31])) return null;
    const v = Number(d.slice(37, 47)) / 100;
    return v > 0 ? v : null;
}
if (Math.abs(valorDaLinhaValidada('00190000090000000000000000000000000000001320983') - 13209.83) > 0.005) {
    throw new Error('valorDaLinhaValidada erra o caso conhecido');
}
if (valorDaLinhaValidada('00190000190000000000000000000000000000001320983') !== null) {
    throw new Error('valorDaLinhaValidada aceitou campo1 corrompido');
}

const args = process.argv.slice(2);
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 120;
const iR = args.indexOf('--repeticoes');
const REP = iR >= 0 ? parseInt(args[iR + 1], 10) : 3;
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

(async () => {
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const comLD = new Set();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
            if (valorDaLinhaValidada(pd['Linha digitável']) != null) comLD.add(base(row.arquivo));
        }
    }

    let pdfs = [];
    for (const p of ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026']) {
        const [MM, AAAA] = p.split('.');
        try {
            for (const x of await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`))) {
                if (comLD.has(base(x.name))) pdfs.push(x);
            }
        } catch (_) {}
    }
    const amostra = baralhar(pdfs, SEMENTE).slice(0, N);

    console.log(`documentos com LD válida no banco : ${comLD.size}`);
    console.log(`achados no disco                  : ${pdfs.length}`);
    console.log(`amostra                           : ${amostra.length} (semente ${SEMENTE})`);
    console.log(`cada caso ATIVO é relido ${REP}× para detectar instabilidade.`);
    console.log(`NÃO grava no banco.\n`);

    const c = { lidos: 0, erro: 0, semLD: 0, inativo: 0, ativo: 0,
                ganho: 0, perda: 0, ambos: 0, semGab: 0, instavel: 0 };
    const exP = [], exG = [], exI = [], exAmbos = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);

        const leituras = [];
        let falhou = false;
        for (let k = 0; k < REP; k++) {
            try {
                const rows = await pf.analyzePdf(pdf, { forceAI: true });
                const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
                if (!r) { falhou = true; break; }
                let pd = {};
                try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}
                leituras.push({
                    vA: paraNumero(pd['Valor total']),
                    vLD: valorDaLinhaValidada(pd['Linha digitável']),
                    og: pd['Origem do valor pago'],
                });
            } catch (e) { falhou = true; break; }
            // Só vale repetir se o 1º passe mostrar que o caso é ATIVO; senão gasta API à toa.
            if (k === 0) {
                const L0 = leituras[0];
                if (L0.vLD == null || bate(L0.vA, L0.vLD)) break;
            }
        }
        if (falhou || !leituras.length) {
            c.erro++;
            console.log(`[${String(i+1).padStart(3)}/${amostra.length}] ✗ ${pdf.name.slice(0,40)}`);
            continue;
        }
        c.lidos++;

        const L0 = leituras[0];
        if (L0.vLD == null) { c.semLD++; continue; }
        if (bate(L0.vA, L0.vLD)) { c.inativo++; continue; }

        c.ativo++;
        // A oscilou entre as repetições?
        const distintos = new Set(leituras.map(x => x.vA == null ? 'null' : x.vA.toFixed(2)));
        if (distintos.size > 1) {
            c.instavel++;
            exI.push({ n: pdf.name, vNome, vals: [...distintos], vLD: L0.vLD });
            console.log(`[${String(i+1).padStart(3)}/${amostra.length}] INSTÁVEL   A∈{${[...distintos].join(', ')}}  LD=${L0.vLD}  ${pdf.name.slice(0,26)}`);
            continue;
        }
        if (vNome == null) {
            c.semGab++;
            console.log(`[${String(i+1).padStart(3)}/${amostra.length}] sem-gabarito  A=${BRL(L0.vA)} LD=${BRL(L0.vLD)}  ${pdf.name.slice(0,26)}`);
            continue;
        }

        const okA = bate(L0.vA, vNome), okLD = bate(L0.vLD, vNome);
        let marca;
        if (!okA && okLD) { c.ganho++; marca = 'ganho'; exG.push({ n: pdf.name, vNome, vA: L0.vA, vLD: L0.vLD, og: L0.og }); }
        else if (okA && !okLD) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, vA: L0.vA, vLD: L0.vLD, og: L0.og }); }
        else { c.ambos++; marca = 'ambos erram'; exAmbos.push({ n: pdf.name, vNome, vA: L0.vA, vLD: L0.vLD }); }
        console.log(`[${String(i+1).padStart(3)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(L0.vA).padStart(13)} LD=${BRL(L0.vLD).padStart(13)}  ${pdf.name.slice(0,24)}`);
    }

    console.log(`\n══ a variante B PERDE algo? ═════════════════════════════════`);
    console.log(`   documentos lidos      : ${c.lidos}`);
    console.log(`   erro de leitura       : ${c.erro}`);
    console.log(`   sem LD na releitura   : ${c.semLD}`);
    console.log(`   INATIVOS (A já = LD)  : ${c.inativo}   ← B não faz nada aqui`);
    console.log(`\n   ATIVOS (A ≠ LD)       : ${c.ativo}   ← só aqui B muda o resultado`);
    console.log(`      instáveis (A oscila): ${c.instavel}`);
    console.log(`      sem gabarito        : ${c.semGab}`);
    console.log(`      B ganha             : ${c.ganho}`);
    console.log(`      B PERDE             : ${c.perda}   ← a resposta da pergunta`);
    console.log(`      ambos erram         : ${c.ambos}`);
    const decid = c.ganho + c.perda;
    if (decid) console.log(`\n   entre os DECIDÍVEIS: ${c.ganho}/${decid} a favor de B (${(100*c.ganho/decid).toFixed(0)}%)`);

    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,60)}\n      nome ${BRL(e.vNome)}  IA ${BRL(e.vA)}  LD ${BRL(e.vLD)}  [origem: ${e.og || '—'}]`);
    for (const e of exG.slice(0, 8)) console.log(`\n   ganho  ${e.n.slice(0,60)}\n      nome ${BRL(e.vNome)}  IA ${BRL(e.vA)}  LD ${BRL(e.vLD)}  [origem: ${e.og || '—'}]`);
    for (const e of exAmbos.slice(0, 5)) console.log(`\n   ambos  ${e.n.slice(0,60)}\n      nome ${BRL(e.vNome)}  IA ${BRL(e.vA)}  LD ${BRL(e.vLD)}`);
    for (const e of exI.slice(0, 5)) console.log(`\n   instável  ${e.n.slice(0,56)}\n      nome ${BRL(e.vNome)}  A∈{${e.vals.join(', ')}}  LD ${BRL(e.vLD)}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
