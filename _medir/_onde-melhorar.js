/**
 * _medir/_onde-melhorar.js — o 63% é limite do SISTEMA ou idade do DADO?
 *
 * Pergunta do usuário (14/09/2026): como melhorar os números de `_estado-do-acervo.js`.
 *
 * A pergunta não se responde olhando a média, porque o acervo é uma mistura de épocas:
 * linhas gravadas pelo parser local antigo convivem com linhas gravadas pela IA, e as
 * melhorias de 09–11/09 (NFS-e, dois layouts, visão, decisão de valor) só alcançaram o
 * que foi relido — quase nada.
 *
 * Se a precisão por ORIGEM for muito diferente, o 63% mede o passado e a releitura
 * sozinha move o número, sem código novo. Se for parecida, o limite é do sistema e aí
 * sim é preciso inventar algo.
 *
 * Mesma lógica pareada de [[ia-vence-o-parser-local-no-valor]] — a média solta compara
 * DIFICULDADE, não motor —, mas aqui a pergunta é outra: não "qual motor é melhor",
 * e sim "quanto do erro atual é dado velho".
 *
 * Mede três coisas que apontam consertos diferentes:
 *   1. precisão de valor e número POR ORIGEM (IA · conteúdo · conteúdo fraco)
 *   2. anatomia dos erros de NÚMERO — o campo mais frágil (19% errado), nunca
 *      investigado. Erro de número pode ser leitura, mas também pode ser o gabarito
 *      do nome apontando outro documento do pacote ([[acessorio-nao-separa-do-fiscal]]).
 *   3. os VAZIOS: são PDF-imagem (a visão alcança) ou texto nativo (leitura pobre)?
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_onde-melhorar.js
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const CH_VALOR  = ['Valor total', 'Valor total da nota', 'Valor do boleto', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const CH_NUMERO = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Nº da NFS-e', 'Número do documento',
                   'Numero da NF'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';

// Normaliza a origem em três famílias — os rótulos variam ("conteúdo (fraco)",
// "conteúdo (emitente)") e o que importa é o MOTOR que leu.
function familia(o) {
    const s = String(o || '').toLowerCase();
    if (s.includes('visão') || s.includes('visao')) return 'visão (IA)';
    if (s.includes('ia')) return 'IA';
    if (s.includes('fraco')) return 'conteúdo (fraco)';
    if (s.includes('conteúdo') || s.includes('conteudo')) return 'conteúdo';
    return '(sem origem)';
}

const jNum = (lido, gab) => {
    if (gab == null) return 's/gab';
    if (lido == null) return 'vazio';
    const a = String(lido).replace(/\D/g, ''), b = String(gab).replace(/\D/g, '');
    if (!a || !b) return 'vazio';
    return (a === b || a.endsWith(b) || b.endsWith(a)) ? 'ok' : 'erro';
};

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    const docs = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;
            const base = path.basename(arq);
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            if (!docs.has(base)) docs.set(base, { pd, base, origem: x.origem, conteudo: x.conteudo });
        }
    const todos = [...docs.values()];
    console.log(`escopo fiscal com dados_parser: ${todos.length}\n`);

    // ── 1. PRECISÃO POR ORIGEM ───────────────────────────────────────────────
    console.log('═'.repeat(78));
    console.log('1. O ERRO É DO SISTEMA OU DO DADO VELHO? — precisão por origem');
    console.log('═'.repeat(78));
    const porOrig = new Map();
    for (const d of todos) {
        const f = familia(d.origem);
        if (!porOrig.has(f)) porOrig.set(f, { n: 0, gv: 0, vOk: 0, vPar: 0, vErr: 0, vVaz: 0,
                                             gn: 0, nOk: 0, nErr: 0, nVaz: 0 });
        const s = porOrig.get(f);
        s.n++;
        const g = j.gabaritos(d.base);
        if (g.valor != null) {
            s.gv++;
            const lido = j.num(d.pd['Valor total']) ?? j.num(primeiro(d.pd, CH_VALOR));
            const c = j.jValor(lido, g.valor);
            if (c === 'ok') s.vOk++; else if (c === 'parcela') s.vPar++;
            else if (c === 'vazio') s.vVaz++; else s.vErr++;
        }
        if (g.numero != null) {
            s.gn++;
            const c = jNum(primeiro(d.pd, CH_NUMERO), g.numero);
            if (c === 'ok') s.nOk++; else if (c === 'vazio') s.nVaz++; else s.nErr++;
        }
    }
    console.log('\n   origem              docs      VALOR certo       NÚMERO certo');
    for (const [f, s] of [...porOrig].sort((a, b) => b[1].n - a[1].n))
        console.log(`   ${f.padEnd(18)} ${String(s.n).padStart(5)}` +
            `   ${String(s.vOk).padStart(5)}/${String(s.gv).padEnd(5)} ${pct(s.vOk, s.gv).padStart(5)}` +
            `   ${String(s.nOk).padStart(5)}/${String(s.gn).padEnd(5)} ${pct(s.nOk, s.gn).padStart(5)}`);

    console.log('\n   detalhe do VALOR por origem:');
    console.log('   origem              certo  ~parcela   ERRADO   vazio');
    for (const [f, s] of [...porOrig].sort((a, b) => b[1].n - a[1].n))
        console.log(`   ${f.padEnd(18)} ${pct(s.vOk, s.gv).padStart(5)} ${pct(s.vPar, s.gv).padStart(9)}` +
            ` ${pct(s.vErr, s.gv).padStart(8)} ${pct(s.vVaz, s.gv).padStart(7)}`);

    // ── 2. ANATOMIA DOS ERROS DE NÚMERO ──────────────────────────────────────
    console.log('\n' + '═'.repeat(78));
    console.log('2. OS ERROS DE NÚMERO (19%) — que tipo de erro é?');
    console.log('═'.repeat(78));
    const cls = new Map();
    const exemplos = new Map();
    for (const d of todos) {
        const g = j.gabaritos(d.base);
        if (g.numero == null) continue;
        const lido = primeiro(d.pd, CH_NUMERO);
        if (jNum(lido, g.numero) !== 'erro') continue;
        const a = String(lido).replace(/\D/g, ''), b = String(g.numero).replace(/\D/g, '');
        let k;
        if (a.length === 44) k = 'leu a CHAVE de acesso (44 dígitos)';
        else if (a.length > 12) k = 'número longo demais (nosso número/linha?)';
        else if (b.length <= 3) k = 'gabarito curto (≤3 díg) — pode ser o nome que engana';
        else if (a.includes(b) || b.includes(a)) k = 'contido, mas não pelas bordas';
        else if (/\+/.test(d.base)) k = 'PACOTE (+BOL/+AUT) — nome tem mais de um doc';
        else k = 'sem relação aparente';
        cls.set(k, (cls.get(k) || 0) + 1);
        if (!exemplos.has(k)) exemplos.set(k, []);
        if (exemplos.get(k).length < 3)
            exemplos.get(k).push(`nome=${b.padEnd(10)} lido=${a.slice(0, 20).padEnd(20)} ${d.base.slice(0, 40)}`);
    }
    const totErr = [...cls.values()].reduce((x, y) => x + y, 0);
    console.log(`\n   ${totErr} erros de número classificados:\n`);
    for (const [k, c] of [...cls].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(c).padStart(5)}  ${pct(c, totErr).padStart(4)}  ${k}`);
        for (const e of exemplos.get(k) || []) console.log(`              ${e}`);
    }

    // ── 3. OS VAZIOS ─────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(78));
    console.log('3. OS VAZIOS — a visão alcança, ou é leitura pobre de texto nativo?');
    console.log('═'.repeat(78));
    let vazioTexto = 0, vazioImagem = 0, vazioOutro = 0;
    const exTexto = [];
    for (const d of todos) {
        const g = j.gabaritos(d.base);
        if (g.valor == null) continue;
        const lido = j.num(d.pd['Valor total']) ?? j.num(primeiro(d.pd, CH_VALOR));
        if (lido != null) continue;
        const c = String(d.conteudo || '');
        if (/imagem/i.test(c)) vazioImagem++;
        else if (/texto/i.test(c)) { vazioTexto++; if (exTexto.length < 6) exTexto.push(`${familia(d.origem).padEnd(18)} ${d.base.slice(0, 48)}`); }
        else vazioOutro++;
    }
    const totVaz = vazioTexto + vazioImagem + vazioOutro;
    console.log(`\n   ${totVaz} documentos fiscais com valor no nome e NENHUM valor lido:`);
    console.log(`      texto nativo:  ${String(vazioTexto).padStart(5)}  ${pct(vazioTexto, totVaz).padStart(5)}  ← leitura pobre; a visão NÃO ajuda`);
    console.log(`      imagem:        ${String(vazioImagem).padStart(5)}  ${pct(vazioImagem, totVaz).padStart(5)}  ← a visão alcança`);
    console.log(`      outro/vazio:   ${String(vazioOutro).padStart(5)}  ${pct(vazioOutro, totVaz).padStart(5)}`);
    if (exTexto.length) {
        console.log('\n   exemplos de texto nativo sem valor lido:');
        for (const e of exTexto) console.log(`      ${e}`);
    }

    console.log('\n' + '═'.repeat(78));
    process.exit(0);
})();
