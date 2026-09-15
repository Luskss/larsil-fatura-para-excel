/**
 * _medir/_vizinho-e-consorcio.js — quanto dos "erros" é defeito da régua?
 *
 * A anatomia dos 7.617 erros de valor deu duas classes suspeitas:
 *
 *   vizinho    2.169 (28%) — diferença < 5%, e os exemplos são de CENTAVOS
 *                            (897,15 × 897,20 · 1366,37 × 1366,32 · 249,86 × 249,84)
 *   outro      3.475 (46%) — mas 2.867 deles são CONSORCIO
 *
 * Duas hipóteses, cada uma com consequência oposta:
 *   (a) são erros reais de leitura → mexer no prompt/pipeline
 *   (b) são defeito do GABARITO ou do escopo → o índice está mentindo e o conserto
 *       é na medição, não no sistema
 *
 * [[gabarito-frouxo-inventa-erro]] já mostrou 7 de 11 "erros" sendo defeito da régua
 * num caso anterior — e um deles INVERTEU um resultado. Então (b) se checa primeiro.
 *
 * Para CONSORCIO há um fato conhecido: consórcio é filtrado da conferência por
 * `categoriaNaoFiscal` ([[transcritos-fora-da-conferencia]]). Se 2.867 "erros" estão
 * em documentos que o sistema nem usa, eles não são problema a resolver.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');

    // Faixas de diferença relativa, para ver se "vizinho" é centavo ou não.
    const faixas = [
        ['≤ 2 centavos',   (d, g) => d <= 0.02],
        ['≤ 10 centavos',  (d, g) => d <= 0.10],
        ['≤ 1 real',       (d, g) => d <= 1],
        ['≤ 0,5%',         (d, g) => d / g <= 0.005],
        ['≤ 2%',           (d, g) => d / g <= 0.02],
        ['≤ 5%',           (d, g) => d / g <= 0.05],
    ];
    const cont = faixas.map(() => 0);
    let vizinhos = 0;

    // Erros dentro × fora do escopo da conferência.
    const escopo = { dentro: 0, fora: 0 };
    const foraPorCat = new Map();
    const dentroPorTipo = new Map();
    const vistos = new Set();

    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const ch = `${reg.TIPO}|${reg.PERIODO}|${arq}`;
            if (vistos.has(ch)) continue;
            vistos.add(ch);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const v = j.num(primeiro(pd, ROT_VALOR));
            if (v == null) continue;
            const cls = j.jValor(v, g.valor);
            if (cls === 'ok') continue;
            if (cls !== 'erro' && cls !== 'parcela') continue;

            const d = Math.abs(v - g.valor);
            if (d / g.valor < 0.05) {
                vizinhos++;
                faixas.forEach(([, f], i) => { if (f(d, g.valor)) cont[i]++; });
            }

            const cat = rota.categoriaNaoFiscal ? rota.categoriaNaoFiscal(base) : null;
            if (cat) {
                escopo.fora++;
                foraPorCat.set(cat, (foraPorCat.get(cat) || 0) + 1);
            } else {
                escopo.dentro++;
                const t = String(x.tipo || '?');
                dentroPorTipo.set(t, (dentroPorTipo.get(t) || 0) + 1);
            }
        }

    console.log(`1) A CLASSE "vizinho" (${vizinhos} casos) — de que tamanho é a diferença?`);
    faixas.forEach(([nome], i) =>
        console.log(`   ${nome.padEnd(16)} ${String(cont[i]).padStart(6)}` +
            `  (${(100 * cont[i] / vizinhos).toFixed(0)}% dos vizinhos)`));

    const tot = escopo.dentro + escopo.fora;
    console.log(`\n2) OS ERROS ESTÃO NO ESCOPO DA CONFERÊNCIA? (${tot} erros)`);
    console.log(`   DENTRO (documento fiscal):  ${escopo.dentro}  (${(100 * escopo.dentro / tot).toFixed(0)}%)`);
    console.log(`   FORA  (não-fiscal filtrado): ${escopo.fora}  (${(100 * escopo.fora / tot).toFixed(0)}%)`);

    console.log('\n   os de FORA, por categoria:');
    for (const [c, n] of [...foraPorCat].sort((a, b) => b[1] - a[1]).slice(0, 8))
        console.log(`      ${String(n).padStart(5)}  ${c}`);

    console.log('\n   os de DENTRO, por tipo de documento:');
    for (const [t, n] of [...dentroPorTipo].sort((a, b) => b[1] - a[1]).slice(0, 8))
        console.log(`      ${String(n).padStart(5)}  ${t}`);
    process.exit(0);
})();
