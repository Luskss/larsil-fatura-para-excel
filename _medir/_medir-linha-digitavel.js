/**
 * _medir/_medir-linha-digitavel.js — a linha digitável validada deve vencer a
 * precedência de campo?
 *
 * Contexto (17/09/2026): 1.100 linhas do acervo têm linha digitável de 47 dígitos e o
 * DV mod-10 fecha em 1.100. Onde ela DISCORDA de `Valor total`, ela bate o gabarito do
 * nome 150× contra 8. Ver [linha-digitavel-vence-o-valor].
 *
 * Mas esses 150×8 vêm do BANCO, escrito por código de várias épocas. `ancora-da-fatura-
 * e-de-contexto` registra o custo de confundir as duas coisas: o banco dizia +15 e a
 * releitura disse −7. Então aqui se RELÊ o PDF, nos dois modos, no mesmo processo.
 *
 * ── As duas variantes ───────────────────────────────────────────────────────
 * A (hoje) : `valorPorPrecedencia` como está — boleto vence só se MENOR que o total
 * B (nova) : se `Linha digitável` tem 47 díg e os 3 DVs fecham, o valor decodificado
 *            dela vence antes de tudo (menos a âncora do nº da fatura)
 *
 * Pareado contra o gabarito do NOME do arquivo — só contam os casos em que A e B
 * discordam:
 *   GANHO = A erra, B acerta
 *   PERDA = A acerta, B erra   ← se houver, olhar caso a caso antes de implementar
 *
 * NÃO GRAVA NADA. Chama `analyzePdf`, que devolve rows; quem persiste é
 * `upsertRelatorio`, que este script não chama.
 *
 * CUSTA API: `pareceMultiBoleto` dispara `extrairBoletosAI` independente de `forceAI`.
 * Por isso `--so-simples` pula carnê, e o padrão é uma amostra pequena.
 *
 * Uso:
 *   node _medir/_medir-linha-digitavel.js 06.2026 --n 60
 *   node _medir/_medir-linha-digitavel.js 04.2026 --n 60 --semente 7
 *   node _medir/_medir-linha-digitavel.js --disputados --n 60
 *
 * `--disputados` mira nos documentos que o BANCO marca como discordantes (linha
 * digitável ≠ Valor total), em vez de sortear do acervo inteiro — numa amostra cega,
 * ~2/3 dos documentos nem têm boleto e o resto quase sempre concorda, então o sinal
 * some no ruído. O banco aqui é SÓ o mapa de onde olhar: o veredito continua vindo da
 * releitura e do gabarito do nome, nunca do valor gravado.
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

// A visão é o caminho instável (`pdf-sem-texto-a-visao-chuta`: 3 leituras, 3 valores).
// Desligada, a medição isola a REGRA de precedência sobre texto nativo, que é o que
// a variante B muda. Sem isso o ruído do modelo abafaria o efeito.
process.env.VISAO_PDF = '0';
process.env.TRANSCRICAO_PDF = '0';

const pf = require('../routes/process-folder');
const vp = require('../routes/_valor-do-pagamento');
const { paraNumero } = vp;

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

// ── O DV da linha digitável ──────────────────────────────────────────────────
// Três blocos mod-10. Sem isso, "linha digitável" seria só mais um número lido.
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
// Invariantes. Linhas SINTÉTICAS: os blocos verificados são zeros com o DV calculado,
// e só as 10 últimas posições (o valor) mudam — o repositório é público e a linha
// digitável real identifica banco, beneficiário e valor de um pagamento nosso.
if (Math.abs(valorDaLinhaValidada('00190000090000000000000000000000000000001320983') - 13209.83) > 0.005
    || Math.abs(valorDaLinhaValidada('00190000090000000000000000000000000000001316611') - 13166.11) > 0.005) {
    throw new Error('valorDaLinhaValidada não confere com os casos conhecidos');
}
// Negativos: corromper um dígito de um bloco VERIFICADO (as posições 37-46 não têm DV
// próprio, então mexer no valor não invalida a linha — foi assim que uma primeira versão
// deste teste passou verde sem testar nada).
if (valorDaLinhaValidada('00190000190000000000000000000000000000001320983') !== null
    || valorDaLinhaValidada('00190000090000000000100000000000000000001320983') !== null
    || valorDaLinhaValidada('0019000009000000000000000000000000000000132098') !== null) {
    throw new Error('valorDaLinhaValidada deveria rejeitar linha corrompida/curta');
}

const args = process.argv.slice(2);
const PERIODO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
const DISPUTADOS = args.includes('--disputados');
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 60;
const iS = args.indexOf('--semente');
const SEMENTE = iS >= 0 ? parseInt(args[iS + 1], 10) : 1;
if (!PERIODO && !DISPUTADOS) { console.error('informe MM.AAAA ou --disputados'); process.exit(1); }

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

// Os nomes que o banco marca como disputados (linha digitável válida ≠ Valor total).
// Só o CONJUNTO vem daqui; o valor gravado não entra em veredito nenhum.
async function nomesDisputados() {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const nomes = new Set();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
            const v = valorDaLinhaValidada(pd['Linha digitável']);
            if (v == null) continue;
            const t = paraNumero(pd['Valor total']);
            if (t != null && Math.abs(v - t) > 0.02) {
                nomes.add(String(row.arquivo).replace(/#p\d+$/i, '').trim().toLowerCase());
            }
        }
    }
    return nomes;
}

(async () => {
    let pdfs;
    if (DISPUTADOS) {
        const alvo = await nomesDisputados();
        // Varre os 6 meses de 2026 e fica com os que estão na lista.
        pdfs = [];
        for (const p of ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026']) {
            const [MM, AAAA] = p.split('.');
            try {
                const ps = await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`));
                for (const x of ps) {
                    if (alvo.has(String(x.name).replace(/#p\d+$/i, '').trim().toLowerCase())) pdfs.push(x);
                }
            } catch (_) {}
        }
        console.log(`disputados no banco: ${alvo.size} nome(s); achados no disco: ${pdfs.length}`);
    } else {
        const [MM, AAAA] = PERIODO.split('.');
        pdfs = await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`));
    }
    const comGab = pdfs.filter(p => valorDoNomeArquivo(p.name) != null);
    const amostra = baralhar(comGab, SEMENTE).slice(0, N);

    console.log(`período : ${DISPUTADOS ? 'todos (--disputados)' : PERIODO}`);
    console.log(`no disco: ${pdfs.length}   com gabarito no nome: ${comGab.length}`);
    console.log(`amostra : ${amostra.length} (semente ${SEMENTE})`);
    console.log(`visão e transcrição DESLIGADAS — mede a regra sobre texto nativo.`);
    console.log(`NÃO grava no banco.\n`);

    const c = { n: 0, erro: 0, semLD: 0, ldInvalida: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0 };
    const exG = [], exP = [];

    for (let i = 0; i < amostra.length; i++) {
        const pdf = amostra[i];
        const vNome = valorDoNomeArquivo(pdf.name);
        let rows;
        try {
            rows = await pf.analyzePdf(pdf, {});
        } catch (e) {
            c.erro++;
            console.log(`[${String(i+1).padStart(3)}/${amostra.length}] ✗ ${pdf.name.slice(0,44)} — ${e.message.slice(0,44)}`);
            continue;
        }
        const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
        if (!r) { c.erro++; continue; }
        let pd = {};
        try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}

        // A = o que o código faz hoje (já veio decidido dentro de analyzePdf)
        const vA = paraNumero(pd['Valor total']);

        // B = a linha digitável validada vence
        const ld = pd['Linha digitável'];
        if (!ld) { c.semLD++; continue; }
        const vLD = valorDaLinhaValidada(ld);
        if (vLD == null) { c.ldInvalida++; continue; }

        // A âncora do nº da fatura continua mandando: ela resolve ordem de compra
        // coletiva, que a linha digitável não sabe resolver.
        const vB = pd['Origem do valor pago'] === 'âncora do nº da fatura' ? vA : vLD;

        c.n++;
        const okA = bate(vA, vNome), okB = bate(vB, vNome);
        let marca = '=';
        if (bate(vA, vB)) c.iguais++;
        else if (!okA && okB) { c.ganho++; marca = 'GANHO'; exG.push({ n: pdf.name, vNome, vA, vB, og: pd['Origem do valor pago'] }); }
        else if (okA && !okB) { c.perda++; marca = 'PERDA'; exP.push({ n: pdf.name, vNome, vA, vB, og: pd['Origem do valor pago'] }); }
        else { c.ambos++; marca = 'ambos erram'; }
        console.log(`[${String(i+1).padStart(3)}/${amostra.length}] ${marca.padEnd(11)} nome=${BRL(vNome).padStart(13)} A=${BRL(vA).padStart(13)} B=${BRL(vB).padStart(13)}  ${pdf.name.slice(0,30)}`);
    }

    console.log(`\n══ LINHA DIGITÁVEL vence (${PERIODO}, comparáveis=${c.n}) ═══════════`);
    console.log(`   erro de leitura        : ${c.erro}`);
    console.log(`   sem linha digitável    : ${c.semLD}`);
    console.log(`   linha digitável inválida: ${c.ldInvalida}`);
    console.log(`   A e B iguais           : ${c.iguais}`);
    console.log(`\n   GANHO (A erra, B acerta) : ${c.ganho}`);
    console.log(`   PERDA (A acerta, B erra) : ${c.perda}   ← olhar caso a caso`);
    console.log(`   ambos erram              : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda} em ${c.n} comparáveis`);

    for (const e of exP) console.log(`\n   PERDA  ${e.n.slice(0,60)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}  [origem-A: ${e.og || '—'}]`);
    for (const e of exG.slice(0, 8)) console.log(`\n   ganho  ${e.n.slice(0,60)}\n      nome ${BRL(e.vNome)}  A ${BRL(e.vA)}  B ${BRL(e.vB)}  [origem-A: ${e.og || '—'}]`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
