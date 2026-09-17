/**
 * _medir/_medir-precedencia-local.js — A/B: o que acontece se `decidirValorPago`
 * rodar também no caminho dos PARSERS LOCAIS?
 *
 * Hoje ela só é chamada dentro de `analyzeViaAI` (process-folder.js:592). Medido em
 * 17/09/2026: das 2.868 linhas com gabarito no nome (sem #pN), **2.228 (78%) não têm
 * `Origem do valor pago`** — nunca passaram por ela — e é lá que estão 80 dos 92
 * valores divergentes.
 *
 * ── Como se mede sem reler nada ─────────────────────────────────────────────
 * `decidirValorPago(pd, {text, numeroDoNome})` é PURA: recebe o dados_parser já
 * gravado e o texto do PDF, e devolve um pd novo. Então dá para aplicá-la sobre o
 * que está no banco e comparar os dois valores com o gabarito do NOME do arquivo —
 * sem chamar IA e sem gravar.
 *
 *   ANTES  = `Valor total` como está hoje no banco
 *   DEPOIS = `Valor total` que `decidirValorPago` escolheria
 *
 * ── A régua, e por que ela não é o 'diverge' da medição anterior ────────────
 * Aqui o veredito é ganho/perda PAREADO, não taxa agregada: só contam os documentos
 * em que ANTES e DEPOIS discordam entre si. Comparar duas taxas médias compararia a
 * dificuldade dos conjuntos ([[metrica-pareada-nao-ratio]], [[media-agregada-esconde-par-falso]]).
 *
 *   GANHO  = antes errava (≠ nome) e depois acerta (= nome)
 *   PERDA  = antes acertava e depois erra   ← o número que decide
 *
 * ── A retenção é contada à parte, não como erro ─────────────────────────────
 * Em NFS-e com imposto retido o nome traz o LÍQUIDO e o campo o BRUTO: 'diverge' ali
 * é a régua errada, não erro ([[retencao-na-fonte-nao-e-divergencia]]). Sem separar
 * isso, uma mudança que preferisse o líquido pareceria ganhar 16 documentos que já
 * estavam certos. Aqui o caso é reconhecido pela ARITMÉTICA da própria linha
 * (bruto − retenções = líquido), nunca por alíquota adivinhada.
 *
 * Uso:
 *   node _medir/_medir-precedencia-local.js 04.2026
 *   node _medir/_medir-precedencia-local.js --todos [--csv saida.csv]
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

const { PDFParse } = require('pdf-parse');
const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const { decidirValorPago, paraNumero } = require('../routes/_valor-do-pagamento');

function fatiarFuncao(arquivo, decl, exportar) {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', arquivo), 'utf8');
    const linhas = src.split(/\r?\n/);
    const ini = linhas.findIndex(l => l.startsWith(decl));
    if (ini < 0) throw new Error(`não achei "${decl}" em ${arquivo}`);
    let fim = -1;
    for (let i = ini + 1; i < linhas.length; i++) if (linhas[i] === '}') { fim = i; break; }
    if (fim < 0) throw new Error(`não achei o fim de "${decl}"`);
    return linhas.slice(ini, fim + 1).join('\n');
}
// `RE_NUM_NOME` é declarada FORA de `numeroDoNomeArquivo`; sem trazê-la junto a
// função existe mas lança ao ser chamada.
function linhaConst(arquivo, nome) {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', arquivo), 'utf8');
    const l = src.split(/\r?\n/).find(x => x.startsWith(`const ${nome} =`));
    if (!l) throw new Error(`não achei a constante ${nome} em ${arquivo}`);
    return l;
}

const mod = { exports: {} };
new Function('module', `${[
    fatiarFuncao('process-folder.js', 'function valorDoNomeArquivo'),
    linhaConst('process-folder.js', 'RE_NUM_NOME'),
    fatiarFuncao('process-folder.js', 'function numeroDoNomeArquivo'),
].join('\n')}
module.exports = { valorDoNomeArquivo, numeroDoNomeArquivo };`)(mod);
const { valorDoNomeArquivo, numeroDoNomeArquivo } = mod.exports;

// `numeroDoNomeArquivo` depende de RE_NUM_NOME, declarada FORA da função. Se a fatia
// não a trouxe, a chamada lança — e a âncora ficaria silenciosamente desligada,
// medindo só metade da mudança. Melhor quebrar aqui.
try {
    if (valorDoNomeArquivo('004.DOC-430000,00-PIX ENVIADO Macponta.pdf') !== 430000) throw new Error('valorDoNomeArquivo');
    if (String(numeroDoNomeArquivo('009.DOC- 741,53 - 2026.04.29. SKILLHUB. NFS 11691 + BOL.pdf')) !== '11691') throw new Error('numeroDoNomeArquivo');
} catch (e) {
    throw new Error(`régua quebrada (${e.message}) — a fatia do fonte não trouxe o que precisa`);
}

const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;
const ALVO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
// `--sem-ancora`: mede só a REGRA DE CAMPO. A âncora depende do número da fatura
// aparecer no texto ao lado do valor daquela fatura; no caminho local ela erra mais
// do que acerta (medido: -7), e a regra de campo sozinha vale +10.
const SEM_ANCORA = args.includes('--sem-ancora');
if (!TODOS && !ALVO) { console.error('informe MM.AAAA ou --todos'); process.exit(1); }

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

// Retenção CONFERIDA na própria linha: bruto − Σretenções = líquido. Nunca alíquota
// adivinhada — `_retencao-aritmetica.js` reprovou isso (explica só 38%).
const CHAVES_RET = ['Total das retenções', 'Total tributos federais', 'ISSRF', 'ISS retido',
                    'IRRF', 'PIS', 'COFINS', 'CSLL', 'INSS'];
function ehRetencao(pd, vLido, vNome) {
    if (!(vLido > vNome)) return false;
    const dif = vLido - vNome;
    let soma = 0;
    for (const k of CHAVES_RET) {
        const v = paraNumero(pd[k]);
        if (v != null) soma += v;
    }
    return soma > 0 && Math.abs(soma - dif) <= 0.02;
}

(async () => {
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    // Índice do disco: nome-base → caminho. O texto do PDF é o que a âncora precisa.
    const noDisco = new Map();
    const periodos = TODOS ? ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026'] : [ALVO];
    for (const p of periodos) {
        const [MM, AAAA] = p.split('.');
        try {
            for (const pdf of await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`))) {
                noDisco.set(pdf.name.toLowerCase(), pdf.path);
            }
        } catch (e) { console.log(`${p}: pasta inacessível`); }
    }
    console.log(`disco: ${noDisco.size} documento(s)\n`);

    const cache = new Map();
    async function textoDe(nome) {
        const k = nome.toLowerCase();
        if (cache.has(k)) return cache.get(k);
        const p = noDisco.get(k);
        let txt = '';
        if (p) {
            try {
                const parser = new PDFParse({ data: new Uint8Array(await fs.promises.readFile(p)) });
                try {
                    const r = await parser.getText();
                    txt = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
                } finally { try { await parser.destroy(); } catch (_) {} }
            } catch (_) {}
        }
        cache.set(k, txt);
        return txt;
    }

    const c = { alvo: 0, semTexto: 0, iguais: 0, ganho: 0, perda: 0, ambosErram: 0, retencao: 0 };
    const exGanho = [], exPerda = [];
    const vistos = new Set();

    for (const rec of rs.recordset) {
        if (!TODOS && rec.PERIODO !== ALVO) continue;
        if (TODOS && !periodos.includes(rec.PERIODO)) continue;
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || /#p\d+$/i.test(row.arquivo)) continue;
            const chave = `${rec.PERIODO}|${row.arquivo}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);

            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { continue; }

            // Só o que NÃO passou por decidirValorPago — é a população da mudança.
            if (pd['Origem do valor pago']) continue;

            const vNome = valorDoNomeArquivo(row.arquivo);
            const vAntes = paraNumero(pd['Valor total']);
            if (!vNome || !vAntes) continue;
            c.alvo++;

            // Retenção: o 'erro' é da régua, não da leitura. Fora da conta.
            if (ehRetencao(pd, vAntes, vNome)) { c.retencao++; continue; }

            const text = await textoDe(row.arquivo);
            if (!text) { c.semTexto++; continue; }

            // Sem `numeroDoNome` a âncora não age e `decidirValorPago` cai na regra de
            // campo — é o próprio código decidindo, não uma reimplementação da regra.
            const depois = decidirValorPago(pd, {
                text,
                numeroDoNome: SEM_ANCORA ? null : numeroDoNomeArquivo(row.arquivo),
            });
            const vDepois = paraNumero(depois['Valor total']);

            if (bate(vAntes, vDepois)) { c.iguais++; continue; }

            const okAntes = bate(vAntes, vNome), okDepois = bate(vDepois, vNome);
            if (!okAntes && okDepois) {
                c.ganho++;
                exGanho.push({ p: rec.PERIODO, a: row.arquivo, vAntes, vDepois, vNome, o: depois['Origem do valor pago'] });
            } else if (okAntes && !okDepois) {
                c.perda++;
                exPerda.push({ p: rec.PERIODO, a: row.arquivo, vAntes, vDepois, vNome, o: depois['Origem do valor pago'] });
            } else {
                c.ambosErram++;
            }
        }
    }

    console.log(`══ A/B: decidirValorPago no caminho local ═══════════════`);
    console.log(`   população (sem 'Origem', com gabarito) : ${c.alvo}`);
    console.log(`   retenção conferida (fora da conta)     : ${c.retencao}`);
    console.log(`   sem texto no disco                     : ${c.semTexto}`);
    console.log(`   valor inalterado                       : ${c.iguais}`);
    console.log(``);
    console.log(`   ── só os que MUDAM ──`);
    console.log(`   GANHO (errava → acerta) : ${c.ganho}`);
    console.log(`   PERDA (acertava → erra) : ${c.perda}   ← decide`);
    console.log(`   ambos erram             : ${c.ambosErram}`);
    const liq = c.ganho - c.perda;
    console.log(`\n   LÍQUIDO: ${liq >= 0 ? '+' : ''}${liq}`);

    for (const e of exPerda.slice(0, 10)) {
        console.log(`\n   PERDA ${e.p}  ${BRL(e.vAntes)} → ${BRL(e.vDepois)}  (nome: ${BRL(e.vNome)})  [${e.o}]`);
        console.log(`      ${e.a.slice(0, 70)}`);
    }
    for (const e of exGanho.slice(0, 6)) {
        console.log(`\n   ganho ${e.p}  ${BRL(e.vAntes)} → ${BRL(e.vDepois)}  (nome: ${BRL(e.vNome)})  [${e.o}]`);
        console.log(`      ${e.a.slice(0, 70)}`);
    }

    if (CSV) {
        const linhas = [['efeito','periodo','arquivo','valor_nome','antes','depois','origem'].join(';')];
        for (const [ef, arr] of [['GANHO', exGanho], ['PERDA', exPerda]]) {
            for (const e of arr) linhas.push([ef, e.p, `"${e.a}"`, String(e.vNome).replace('.', ','),
                String(e.vAntes).replace('.', ','), String(e.vDepois).replace('.', ','), `"${e.o || ''}"`].join(';'));
        }
        fs.writeFileSync(path.join(RAIZ, CSV), linhas.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
