/**
 * _medir/_medir-trava-valor.js — estender a trava do gabarito do nome (hoje só em
 * `lerPorVisao`, para PDF-imagem) à leitura por TEXTO pegaria mais acerto ou mais erro?
 *
 * Contexto: o contrato do Daycoval foi gravado com R$ 660.000 (Valor Definitivo do
 * Arrendamento) enquanto o nome do arquivo diz R$ 430.000 (o VRG, que é o que saiu da
 * conta). `conferirValor` teria dito 'diverge' — mas ela nunca roda em PDF com texto.
 *
 * ── A pergunta que decide ────────────────────────────────────────────────────
 * `total-da-nota-nao-e-valor-lancado` registra que nome ≠ total é LEGÍTIMO com
 * frequência (o nome traz a parcela). Então a trava pode rejeitar leitura boa em
 * massa. O que se mede aqui é a DISTRIBUIÇÃO dos vereditos sobre o que está gravado:
 *
 *   bate        → trava não faria nada
 *   parcela     → razão inteira 2..60: a trava ACEITA (já é exceção prevista)
 *   diverge     → a trava agiria. Quantos são? E são erro ou acerto?
 *
 * Um 'diverge' só é ERRO DA TRAVA se o valor gravado estiver certo. Como não há
 * gabarito além do nome, o script NÃO decide isso sozinho: ele quantifica e lista
 * os maiores para inspeção, que é o que `inspecao-anima-medicao-decide` manda fazer
 * ao contrário — medir primeiro, inspecionar o que a medição apontar.
 *
 * ── Por que só documentos com valor no nome ─────────────────────────────────
 * Sem gabarito não há trava. A cobertura (quantos % têm valor no nome) é parte do
 * resultado: uma trava que só alcança 30% do acervo vale menos que uma que alcança 90%.
 *
 * Uso:
 *   node _medir/_medir-trava-valor.js --todos
 *   node _medir/_medir-trava-valor.js 04.2026 --csv saida.csv
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

// `valorDoNomeArquivo` e `conferirValor` são internas de módulos diferentes.
// Extraídas do FONTE para medir exatamente o que roda.
// Fatiar por LINHA (da declaração até o `}` na coluna 0) em vez de por um trecho de
// comentário: o comentário muda quando alguém reescreve a documentação, e a fatia
// silenciosamente pega código demais ou de menos.
function fatiarFuncao(arquivo, decl, exportar) {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', arquivo), 'utf8');
    const linhas = src.split(/\r?\n/);
    const ini = linhas.findIndex(l => l.startsWith(decl));
    if (ini < 0) throw new Error(`não achei "${decl}" em ${arquivo}`);
    let fim = -1;
    for (let i = ini + 1; i < linhas.length; i++) {
        if (linhas[i] === '}') { fim = i; break; }
    }
    if (fim < 0) throw new Error(`não achei o fim de "${decl}" em ${arquivo}`);
    return { corpo: linhas.slice(ini, fim + 1).join('\n'), exportar };
}

const trechos = [
    fatiarFuncao('process-folder.js', 'function valorDoNomeArquivo', 'valorDoNomeArquivo'),
    fatiarFuncao('_nf-visao.js', 'function conferirValor', 'conferirValor'),
    fatiarFuncao('_nf-visao.js', 'function pareceTruncamentoDeMilhar', 'pareceTruncamentoDeMilhar'),
];
const mod = { exports: {} };
new Function('module', `${trechos.map(t => t.corpo).join('\n')}
module.exports = { ${trechos.map(t => t.exportar).join(', ')} };`)(mod);
const { valorDoNomeArquivo, conferirValor, pareceTruncamentoDeMilhar } = mod.exports;

// Invariante: se a fatia pegou a função errada, o caso conhecido denuncia.
// 660.000 lido contra 430.000 no nome é 'diverge' (razão 1,53, não inteira).
if (valorDoNomeArquivo('004.DOC-430000,00-PIX ENVIADO Macponta.pdf') !== 430000
    || conferirValor(660000, 430000) !== 'diverge'
    || conferirValor(430000, 430000) !== 'bate'
    || conferirValor(860000, 430000) !== 'parcela') {
    throw new Error('as funções fatiadas não se comportam como esperado — régua quebrada');
}

const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;
const ALVO = args.find(a => /^\d{2}\.\d{4}$/.test(a));

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

    const cont = { total: 0, parcelaPn: 0, semGabarito: 0, semValor: 0, bate: 0, parcela: 0, diverge: 0, truncou: 0 };
    const divergentes = [];
    const vistos = new Set();

    for (const rec of rs.recordset) {
        if (ALVO && rec.PERIODO !== ALVO) continue;
        if (!TODOS && !ALVO) continue;
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            // Dedup: o mesmo arquivo aparece no M do seu mês e, se for parcela, em
            // vários. Contar duas vezes inflaria a distribuição.
            const chave = `${rec.PERIODO}|${row.arquivo}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);

            let dp = {};
            try { dp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { continue; }

            const vNome = valorDoNomeArquivo(row.arquivo);
            const vLido = paraNumero(dp['Valor total']);
            cont.total++;

            // Parcela de carnê (#pN) NÃO entra: `conferirValor` foi escrita para
            // comparar o valor de UM documento com o gabarito do nome, e numa parcela
            // o nome traz o valor do documento inteiro enquanto o campo traz a parcela
            // — 'diverge' ali é a régua errada, não erro de leitura. Medido: das 5.860
            // divergências da primeira rodada, 5.768 eram #pN. Contá-las inventaria um
            // problema que não existe ([[gabarito-frouxo-inventa-erro]]).
            if (/#p\d+$/i.test(row.arquivo)) { cont.parcelaPn++; continue; }

            if (!vNome) { cont.semGabarito++; continue; }
            if (!vLido) { cont.semValor++; continue; }

            const v = conferirValor(vLido, vNome);
            if (v === 'bate') cont.bate++;
            else if (v === 'parcela') cont.parcela++;
            else if (v === 'diverge') {
                cont.diverge++;
                const trunc = pareceTruncamentoDeMilhar(vLido, vNome);
                if (trunc) cont.truncou++;
                divergentes.push({
                    periodo: rec.PERIODO, arquivo: row.arquivo, vNome, vLido,
                    razao: vLido / vNome, trunc,
                    emitente: dp['Emitente'] || '', razao_social: dp['Razão social (nota)'] || '',
                });
            }
        }
    }

    const comGabarito = cont.bate + cont.parcela + cont.diverge;
    const pct = (n) => comGabarito ? (100 * n / comGabarito).toFixed(1) + '%' : '—';

    console.log(`══ TRAVA DO GABARITO NA LEITURA POR TEXTO ═══════════════`);
    console.log(`   linhas no banco        : ${cont.total}`);
    console.log(`   parcelas #pN (fora)    : ${cont.parcelaPn}  (régua não se aplica)`);
    console.log(`   sem valor no nome      : ${cont.semGabarito}  (trava não alcança)`);
    console.log(`   sem valor lido         : ${cont.semValor}`);
    console.log(`   COM gabarito           : ${comGabarito}  (${(100 * comGabarito / cont.total).toFixed(1)}% do acervo)`);
    console.log(``);
    console.log(`   bate    : ${String(cont.bate).padStart(5)}  ${pct(cont.bate).padStart(6)}   trava não agiria`);
    console.log(`   parcela : ${String(cont.parcela).padStart(5)}  ${pct(cont.parcela).padStart(6)}   trava ACEITA (exceção prevista)`);
    console.log(`   diverge : ${String(cont.diverge).padStart(5)}  ${pct(cont.diverge).padStart(6)}   ← a trava AGIRIA aqui`);
    console.log(`      dos quais truncamento de milhar: ${cont.truncou}`);

    divergentes.sort((a, b) => b.vLido - a.vLido);
    console.log(`\n── os 15 maiores 'diverge' (valor lido) ─────────────────`);
    for (const d of divergentes.slice(0, 15)) {
        console.log(`   ${d.periodo}  lido ${BRL(d.vLido).padStart(16)}  nome ${BRL(d.vNome).padStart(16)}  x${d.razao.toFixed(2).padStart(7)}${d.trunc ? '  [trunc]' : ''}`);
        console.log(`      ${d.arquivo.slice(0, 74)}`);
    }

    if (CSV) {
        const linhas = [['periodo','arquivo','valor_nome','valor_lido','razao','truncamento','emitente','razao_social'].join(';')];
        for (const d of divergentes) {
            linhas.push([d.periodo, `"${d.arquivo}"`, String(d.vNome).replace('.', ','),
                         String(d.vLido).replace('.', ','), d.razao.toFixed(4).replace('.', ','),
                         d.trunc ? 'sim' : 'nao', `"${d.emitente}"`, `"${d.razao_social}"`].join(';'));
        }
        fs.writeFileSync(path.join(RAIZ, CSV), linhas.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV} (${divergentes.length} divergentes)`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
