/**
 * _medir/_medir-veto-do-total.js — o `Valor total da nota` está vetando o boleto
 * CERTO quando ele próprio é lixo?
 *
 * A regra (`_valor-do-pagamento.js:184`):
 *
 *     if (bol != null && (nota == null || bol < nota)) → boleto
 *
 * O boleto só vence se for MENOR que o total da nota. A trava existe para barrar
 * boleto com juros somados (130,16 onde se pagou 78,09) — e está certa nesse caso.
 *
 * Mas achei em 17/09/2026 (BOBIG NF 1832) um caso em que quem está errado é a NOTA:
 *
 *     Valor do boleto     = 5977,98   ← certo, bate com o nome do arquivo
 *     Valor total da nota =  112,50   ← lixo, "Origem do valor total: soma dos itens"
 *     Valor total         =  112,50   ← escolhido, porque 5977,98 não é < 112,50
 *
 * Hipótese a medir: quando `Origem do valor total` é **soma dos itens**, esse número
 * não deve vetar o boleto. A soma de itens falha quando o PDF traz tabela parcial —
 * é um total DERIVADO, não lido de um campo "Total da nota".
 *
 * ── A régua ─────────────────────────────────────────────────────────────────
 * Pareada sobre o que JÁ está no banco (sem releitura, sem IA): só entram as linhas
 * onde a variante mudaria o valor.
 *
 *   GANHO = a regra atual erra (≠ nome) e a variante acerta
 *   PERDA = a regra atual acerta e a variante erra   ← decide
 *
 * Parcelas `#pN` ficam fora (o nome traz o total, o campo a parcela) e retenção
 * conferida na aritmética da linha também ([[retencao-na-fonte-nao-e-divergencia]]).
 *
 * VARIANTES medidas:
 *   A. soma-dos-itens não veta   — só ignora o veto quando a origem é "soma dos itens"
 *   B. boleto sempre vence       — o veto do total nunca se aplica (controle: mostra
 *                                  o que a trava do 184 realmente protege)
 *
 * Uso: node _medir/_medir-veto-do-total.js [--csv saida.csv]
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
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;

const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

const CHAVES_RET = ['Total das retenções', 'Total tributos federais', 'ISSRF', 'ISS retido',
                    'IRRF', 'PIS', 'COFINS', 'CSLL', 'INSS'];
function ehRetencao(pd, vLido, vNome) {
    if (!(vLido > vNome)) return false;
    let soma = 0;
    for (const k of CHAVES_RET) { const v = paraNumero(pd[k]); if (v != null) soma += v; }
    return soma > 0 && Math.abs(soma - (vLido - vNome)) <= 0.02;
}

// A regra de hoje, isolada (espelha valorPorPrecedencia para a parte que muda).
function escolher(pd, modo) {
    const bol = paraNumero(pd['Valor do boleto']);
    const nota = paraNumero(pd['Valor total da nota']);
    const somaDeItens = /soma dos itens/i.test(String(pd['Origem do valor total'] || ''));

    let vetoVale;
    if (modo === 'atual')      vetoVale = true;
    else if (modo === 'A')     vetoVale = !somaDeItens;   // soma-dos-itens não veta
    else if (modo === 'B')     vetoVale = false;          // o veto nunca se aplica
    else throw new Error('modo?');

    if (bol != null && (nota == null || !vetoVale || bol < nota)) return { v: bol, o: 'boleto' };
    const total = paraNumero(pd['Valor total']);
    if (total != null) return { v: total, o: 'valor total' };
    for (const k of ['Valor total da nota', 'Valor do serviço', 'Valor principal',
                     'Valor da prestação', 'Valor líquido']) {
        const v = paraNumero(pd[k]);
        if (v != null) return { v, o: k.toLowerCase() };
    }
    return { v: null, o: null };
}

(async () => {
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    const res = { A: { g: 0, p: 0, ex: [] }, B: { g: 0, p: 0, ex: [] } };
    let comBoleto = 0, somaItens = 0, vetado = 0, avaliados = 0;
    const vistos = new Set();

    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || /#p\d+$/i.test(row.arquivo)) continue;
            const chave = `${rec.PERIODO}|${row.arquivo}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);

            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { continue; }

            const bol = paraNumero(pd['Valor do boleto']);
            const nota = paraNumero(pd['Valor total da nota']);
            if (bol != null) comBoleto++;
            if (/soma dos itens/i.test(String(pd['Origem do valor total'] || ''))) somaItens++;
            // O caso que a variante A alcança: boleto existe, nota existe, o veto agiu.
            if (bol != null && nota != null && !(bol < nota)) vetado++;

            const vNome = valorDoNomeArquivo(row.arquivo);
            if (!vNome) continue;
            const atual = escolher(pd, 'atual');
            if (atual.v == null) continue;
            if (ehRetencao(pd, atual.v, vNome)) continue;
            avaliados++;

            for (const modo of ['A', 'B']) {
                const alt = escolher(pd, modo);
                if (bate(atual.v, alt.v)) continue;
                const okAtual = bate(atual.v, vNome), okAlt = bate(alt.v, vNome);
                if (!okAtual && okAlt) {
                    res[modo].g++;
                    if (res[modo].ex.length < 40) res[modo].ex.push({ ef: 'GANHO', p: rec.PERIODO, a: row.arquivo, vNome, de: atual.v, para: alt.v, orig: String(pd['Origem do valor total'] || '') });
                } else if (okAtual && !okAlt) {
                    res[modo].p++;
                    if (res[modo].ex.length < 40) res[modo].ex.push({ ef: 'PERDA', p: rec.PERIODO, a: row.arquivo, vNome, de: atual.v, para: alt.v, orig: String(pd['Origem do valor total'] || '') });
                }
            }
        }
    }

    console.log(`══ O VETO DO "TOTAL DA NOTA" SOBRE O BOLETO ═════════════`);
    console.log(`   linhas com Valor do boleto       : ${comBoleto}`);
    console.log(`   linhas com total "soma dos itens": ${somaItens}`);
    console.log(`   veto agiu (boleto >= nota)       : ${vetado}`);
    console.log(`   avaliados (com gabarito no nome) : ${avaliados}\n`);

    for (const [modo, rotulo] of [['A', 'soma-dos-itens NÃO veta'], ['B', 'boleto SEMPRE vence (controle)']]) {
        const r = res[modo];
        console.log(`   ── variante ${modo}: ${rotulo}`);
        console.log(`      GANHO : ${r.g}`);
        console.log(`      PERDA : ${r.p}`);
        console.log(`      LÍQUIDO: ${r.g - r.p >= 0 ? '+' : ''}${r.g - r.p}\n`);
    }

    console.log(`   ── variante A, casos ──`);
    for (const e of res.A.ex.slice(0, 14)) {
        console.log(`   ${e.ef}  ${e.p}  ${BRL(e.de)} → ${BRL(e.para)}   (nome: ${BRL(e.vNome)})`);
        console.log(`      ${e.a.slice(0, 66)}   [${e.orig || '—'}]`);
    }

    if (CSV) {
        const linhas = [['variante','efeito','periodo','arquivo','valor_nome','atual','variante_valor','origem_total'].join(';')];
        for (const modo of ['A', 'B']) {
            for (const e of res[modo].ex) {
                linhas.push([modo, e.ef, e.p, `"${e.a}"`, String(e.vNome).replace('.', ','),
                    String(e.de).replace('.', ','), String(e.para).replace('.', ','), `"${e.orig}"`].join(';'));
            }
        }
        fs.writeFileSync(path.join(RAIZ, CSV), linhas.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
