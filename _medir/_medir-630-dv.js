/**
 * _medir/_medir-630-dv.js — a IA de texto deve sobrescrever um valor que veio de
 * DV VALIDADO?
 *
 * Contexto (17/09/2026). Três medições anteriores enquadram esta:
 *   - [linha-digitavel-vence-o-valor] — a LD como regra GLOBAL de precedência
 *     REPROVOU (+1 em 68): ela prova os dígitos, não qual valor foi pago (boleto com
 *     juros, parcela de carnê).
 *   - [sobrescrita-do-valor-na-630] — proteger o valor da VISÃO deu +3 em 35, mas
 *     um dos ganhos não se reproduz: o veredito da visão é instável.
 *   - [pdf-sem-texto-a-visao-chuta] — o defeito da linha 630 é real e ESTÁVEL.
 *
 * Daí o escopo desta: nem precedência global, nem gatilho instável. Só impedir que
 * `r.valorTotal` (IA de texto) apague um `Valor total` que JÁ É o valor decodificado
 * da linha digitável com os 3 DVs mod-10 fechando. Gatilho determinístico.
 *
 * ── As duas variantes ───────────────────────────────────────────────────────
 * A (hoje) : linha 630 sobrescreve sempre
 * B (nova) : NÃO sobrescreve quando pdComum['Valor total'] == valor(LD validada)
 *
 * Note o que B NÃO faz: não impõe a LD onde o `Valor total` é outro número (isso é a
 * regra global já reprovada), e não protege leitura de modelo nenhum. Ela só preserva
 * aritmética que já estava lá.
 *
 * Régua: gabarito do NOME. Pareado; PERDA = A acerta e B erra.
 *
 * Alvo: documentos com linha digitável — é onde as variantes podem diferir. Fora
 * disso são idênticas por construção e medir só diluiria.
 *
 * NÃO GRAVA NADA. CUSTA API.
 *
 * Uso: node _medir/_medir-630-dv.js --n 60
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
// Invariantes. O caso negativo precisa corromper um dígito do BLOCO VERIFICADO — trocar
// o último dígito só mudaria o valor (posições 37-46 não têm DV próprio), e foi assim
// que a primeira versão deste teste passou verde por engano.
if (Math.abs(valorDaLinhaValidada('00190000090000000000000000000000000000001320983') - 13209.83) > 0.005) {
    throw new Error('valorDaLinhaValidada erra o caso conhecido');
}
if (valorDaLinhaValidada('00190000190000000000000000000000000000001320983') !== null) {  // 9º díg: 8→9
    throw new Error('valorDaLinhaValidada aceitou campo1 corrompido');
}
if (valorDaLinhaValidada('00190000090000000000100000000000000000001320983') !== null) {  // campo2 corrompido
    throw new Error('valorDaLinhaValidada aceitou campo2 corrompido');
}
if (valorDaLinhaValidada('0019000009000000000000000000000000000000132098') !== null) {
    throw new Error('valorDaLinhaValidada aceitou linha curta');
}

// A linha 630 ainda é como eu a li?
const SRC = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
if (!/const pd = \{ \.\.\.pdComum, 'Valor total': r\.valorTotal > 0/.test(SRC)) {
    throw new Error('a linha 630 mudou — reler antes de medir');
}

const args = process.argv.slice(2);
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 60;
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
    // Quem TEM linha digitável, pelo banco. Aqui o banco é só o mapa de onde olhar —
    // o veredito vem da releitura e do gabarito, nunca do valor gravado.
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
                if (comLD.has(base(x.name)) && valorDoNomeArquivo(x.name) != null) pdfs.push(x);
            }
        } catch (_) {}
    }
    const amostra = baralhar(pdfs, SEMENTE).slice(0, N);

    console.log(`com linha digitável válida no banco : ${comLD.size} nome(s)`);
    console.log(`achados no disco com gabarito       : ${pdfs.length}`);
    console.log(`amostra                             : ${amostra.length} (semente ${SEMENTE})`);
    console.log(`\nB = a linha 630 não sobrescreve valor que JÁ É o da LD validada.`);
    console.log(`NÃO grava no banco.\n`);

    const c = { n: 0, erro: 0, semLD: 0, naoAplica: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);
        let rows;
        try { rows = await pf.analyzePdf(pdf, { forceAI: true }); }
        catch (e) {
            c.erro++;
            console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ✗ ${pdf.name.slice(0,42)} — ${e.message.slice(0,38)}`);
            continue;
        }
        const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
        if (!r) { c.erro++; continue; }
        let pd = {};
        try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}

        const vA = paraNumero(pd['Valor total']);
        const vLD = valorDaLinhaValidada(pd['Linha digitável']);
        if (vLD == null) { c.semLD++; continue; }

        // B só age se o valor da LD SOBREVIVERIA — isto é, se `Valor do boleto` (que é
        // onde o extrator grava o valor decodificado) existe e a linha 630 o substituiu
        // por outro número. Reconstruir isso exige saber o que pdComum tinha; a
        // aproximação fiel: o valor da LD é o que estaria lá, então B = vLD quando o
        // que a IA escreveu difere dela.
        const vBoleto = paraNumero(pd['Valor do boleto']);
        const ldEstavaNoCampo = vBoleto != null && bate(vBoleto, vLD);
        if (!ldEstavaNoCampo) { c.naoAplica++; continue; }
        const vB = bate(vA, vLD) ? vA : vLD;

        c.n++;
        const okA = bate(vA, vNome), okB = bate(vB, vNome);
        let marca = '=';
        if (bate(vA, vB)) c.iguais++;
        else if (!okA && okB) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, vA, vB, og: pd['Origem do valor pago'] }); }
        else if (okA && !okB) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, vA, vB, og: pd['Origem do valor pago'] }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(2)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(vA).padStart(13)} B=${BRL(vB).padStart(13)}  ${pdf.name.slice(0,26)}`);
    }

    console.log(`\n══ a 630 não apaga valor de DV validado (n=${c.n}) ═══════════`);
    console.log(`   erro de leitura      : ${c.erro}`);
    console.log(`   sem LD na releitura  : ${c.semLD}`);
    console.log(`   LD não estava no campo: ${c.naoAplica}`);
    console.log(`   A e B iguais         : ${c.iguais}`);
    console.log(`\n   GANHO (A erra, B acerta) : ${c.ganho}`);
    console.log(`   PERDA (A acerta, B erra) : ${c.perda}   ← olhar caso a caso`);
    console.log(`   ambos erram              : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n}`);
    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}  [origem: ${e.og || '—'}]`);
    for (const e of exG.slice(0, 10)) console.log(`\n   ganho  ${e.n.slice(0,58)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}  [origem: ${e.og || '—'}]`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
