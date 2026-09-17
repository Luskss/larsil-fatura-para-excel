/**
 * _medir/_medir-origem-erro.js — QUAL mecanismo escolheu o valor errado?
 *
 * `decidirValorPago` grava `Origem do valor pago` em cada linha ('âncora do nº da
 * fatura', 'boleto', 'valor total', ...). Cruzando essa origem com o veredito do
 * gabarito do nome, dá para ver se o erro se concentra num caminho — e um caminho
 * ruim se conserta, enquanto "a IA erra às vezes" não.
 *
 * A pergunta que as medições anteriores não responderam: a trava do gabarito é o
 * melhor lugar para agir, ou existe um mecanismo a montante que erra mais?
 *
 * Também mede o que o VALOR DO BOLETO diria: em documento "NF + BOL" o boleto é a
 * parcela que se paga, e `Valor total da nota` guarda o número anterior. Se o campo
 * certo já estiver gravado na linha, o conserto é de PRECEDÊNCIA, não de leitura —
 * foi o que `_valor-do-pagamento.js` achou antes (46% dos erros tinham o número certo
 * em outra chave).
 *
 * Uso:
 *   node _medir/_medir-origem-erro.js --todos
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

function fatiarFuncao(arquivo, decl, exportar) {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', arquivo), 'utf8');
    const linhas = src.split(/\r?\n/);
    const ini = linhas.findIndex(l => l.startsWith(decl));
    if (ini < 0) throw new Error(`não achei "${decl}" em ${arquivo}`);
    let fim = -1;
    for (let i = ini + 1; i < linhas.length; i++) if (linhas[i] === '}') { fim = i; break; }
    if (fim < 0) throw new Error(`não achei o fim de "${decl}"`);
    return { corpo: linhas.slice(ini, fim + 1).join('\n'), exportar };
}
const trechos = [
    fatiarFuncao('process-folder.js', 'function valorDoNomeArquivo', 'valorDoNomeArquivo'),
    fatiarFuncao('_nf-visao.js', 'function conferirValor', 'conferirValor'),
];
const mod = { exports: {} };
new Function('module', `${trechos.map(t => t.corpo).join('\n')}
module.exports = { ${trechos.map(t => t.exportar).join(', ')} };`)(mod);
const { valorDoNomeArquivo, conferirValor } = mod.exports;
if (conferirValor(660000, 430000) !== 'diverge' || conferirValor(430000, 430000) !== 'bate') {
    throw new Error('régua quebrada');
}

const paraNumero = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(/[R$\s]/g, '');
    if (!s) return null;
    const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) && n > 0 ? n : null;
};
const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    // origem → { bate, diverge }
    const porOrigem = new Map();
    const salvaveis = [];   // diverge, mas OUTRO campo da linha bate com o nome
    const vistos = new Set();
    let comGabarito = 0;

    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || /#p\d+$/i.test(row.arquivo)) continue;
            const chave = `${rec.PERIODO}|${row.arquivo}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);

            let dp = {};
            try { dp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { continue; }

            const vNome = valorDoNomeArquivo(row.arquivo);
            const vLido = paraNumero(dp['Valor total']);
            if (!vNome || !vLido) continue;
            comGabarito++;

            const veredito = conferirValor(vLido, vNome);
            const origem = dp['Origem do valor pago'] || '(sem origem gravada)';
            if (!porOrigem.has(origem)) porOrigem.set(origem, { bate: 0, parcela: 0, diverge: 0 });
            porOrigem.get(origem)[veredito === 'sem-gabarito' ? 'bate' : veredito]++;

            // O número certo já está na linha, em outra chave?
            if (veredito === 'diverge') {
                const outros = ['Valor total da nota', 'Valor do boleto', 'Valor do serviço',
                                'Valor principal', 'Valor da prestação', 'Valor líquido'];
                for (const k of outros) {
                    const v = paraNumero(dp[k]);
                    if (v != null && Math.abs(v - vNome) <= 0.02) {
                        salvaveis.push({ periodo: rec.PERIODO, arquivo: row.arquivo,
                                         vNome, vLido, campo: k, origem });
                        break;
                    }
                }
            }
        }
    }

    console.log(`══ ERRO POR ORIGEM DO VALOR ═════════════════════════════`);
    console.log(`   documentos com gabarito (sem #pN): ${comGabarito}\n`);
    const linhas = [...porOrigem.entries()]
        .map(([o, c]) => ({ o, ...c, tot: c.bate + c.parcela + c.diverge }))
        .sort((a, b) => b.tot - a.tot);
    console.log(`   ${'origem'.padEnd(28)} ${'total'.padStart(6)} ${'bate'.padStart(6)} ${'diverge'.padStart(8)}  taxa erro`);
    for (const l of linhas) {
        const taxa = l.tot ? (100 * l.diverge / l.tot).toFixed(1) + '%' : '—';
        console.log(`   ${l.o.slice(0, 28).padEnd(28)} ${String(l.tot).padStart(6)} ${String(l.bate).padStart(6)} ${String(l.diverge).padStart(8)}  ${taxa.padStart(8)}`);
    }

    console.log(`\n══ O NÚMERO CERTO JÁ ESTÁ NA LINHA? ═════════════════════`);
    console.log(`   divergentes com o valor do nome em OUTRA chave: ${salvaveis.length}`);
    const porCampo = new Map();
    for (const s of salvaveis) porCampo.set(s.campo, (porCampo.get(s.campo) || 0) + 1);
    for (const [k, n] of [...porCampo.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${k.padEnd(24)} ${n}`);
    }
    for (const s of salvaveis.slice(0, 12)) {
        console.log(`   ${s.periodo}  lido ${BRL(s.vLido).padStart(15)} → ${s.campo} tem ${BRL(s.vNome)}`);
        console.log(`      ${s.arquivo.slice(0, 70)}   [origem: ${s.origem}]`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
