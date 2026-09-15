/**
 * _medir/_estado-de-um-mes.js — o retrato de UM período, para comparar antes/depois.
 *
 * `_estado-do-acervo.js` mede o acervo inteiro; para acompanhar uma releitura é
 * preciso isolar o mês, senão o ganho de 900 documentos se dilui em 4.000 e a
 * medição não distingue "funcionou" de "não fez nada".
 *
 * Grava o retrato em JSON no scratchpad quando `--salvar <arquivo>` é passado, para
 * que o DEPOIS possa ser comparado com o ANTES número a número em vez de de olho.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_estado-de-um-mes.js 03.2026 [--salvar caminho.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const PERIODO = process.argv[2] || '03.2026';
const iSalvar = process.argv.indexOf('--salvar');
const SALVAR = iSalvar > 0 ? process.argv[iSalvar + 1] : null;

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const CH_VALOR  = ['Valor total', 'Valor total da nota', 'Valor do boleto', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const CH_NUMERO = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Nº da NFS-e', 'Número do documento',
                   'Numero da NF'];
const CH_EMIT   = ['Emitente', 'Razão social', 'Nome do emitente'];
const CH_RET    = ['ISS retido', 'IRRF retido', 'INSS retido', 'CSLL retido',
                   'COFINS retido', 'PIS retido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';

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
    const rr = await pool.request().input('p', sql.VarChar(20), PERIODO)
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE PERIODO=@p');

    if (!rr.recordset.length) { console.log(`nenhum relatório para ${PERIODO}`); process.exit(1); }

    const docs = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;
            const base = path.basename(arq);
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!docs.has(base)) docs.set(base, { pd, base, origem: x.origem, conteudo: x.conteudo });
        }
    const todos = [...docs.values()];
    const fiscais = todos.filter(d => !(rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(d.base)));
    const comPd = fiscais.filter(d => d.pd);

    const R = { periodo: PERIODO, docs: todos.length, fiscais: fiscais.length, comPd: comPd.length,
                origem: {}, valor: { gab: 0, ok: 0, parcela: 0, erro: 0, vazio: 0 },
                numero: { gab: 0, ok: 0, erro: 0, vazio: 0 },
                cobertura: {}, retencao: 0 };

    for (const d of fiscais) {
        const f = familia(d.origem);
        R.origem[f] = (R.origem[f] || 0) + 1;
    }
    for (const d of comPd) {
        const g = j.gabaritos(d.base);
        if (g.valor != null) {
            R.valor.gab++;
            const lido = j.num(d.pd['Valor total']) ?? j.num(primeiro(d.pd, CH_VALOR));
            const c = j.jValor(lido, g.valor);
            if (c === 'ok') R.valor.ok++; else if (c === 'parcela') R.valor.parcela++;
            else if (c === 'vazio') R.valor.vazio++; else R.valor.erro++;
        }
        if (g.numero != null) {
            R.numero.gab++;
            const c = jNum(primeiro(d.pd, CH_NUMERO), g.numero);
            if (c === 'ok') R.numero.ok++; else if (c === 'vazio') R.numero.vazio++; else R.numero.erro++;
        }
        if (!VAZIO(primeiro(d.pd, CH_RET))) R.retencao++;
    }
    for (const [nome, ks] of [['valor', CH_VALOR], ['número', CH_NUMERO], ['emitente', CH_EMIT]])
        R.cobertura[nome] = comPd.filter(d => !VAZIO(primeiro(d.pd, ks))).length;

    console.log('═'.repeat(70));
    console.log(`ESTADO DE ${PERIODO}`);
    console.log('═'.repeat(70));
    console.log(`documentos: ${R.docs}   fiscais: ${R.fiscais}   com dados_parser: ${R.comPd}`);
    console.log('\nORIGEM');
    for (const [f, c] of Object.entries(R.origem).sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(c).padStart(5)}  ${f}`);
    console.log('\nCOBERTURA');
    for (const [k, v] of Object.entries(R.cobertura))
        console.log(`   ${k.padEnd(10)} ${String(v).padStart(5)}  ${pct(v, R.comPd).padStart(5)}`);
    console.log(`   retenção   ${String(R.retencao).padStart(5)}  ${pct(R.retencao, R.comPd).padStart(5)}`);
    console.log('\nPRECISÃO');
    console.log(`   VALOR  (${R.valor.gab} com gabarito)`);
    console.log(`      certo    ${String(R.valor.ok).padStart(5)}  ${pct(R.valor.ok, R.valor.gab).padStart(5)}`);
    console.log(`      ~parcela ${String(R.valor.parcela).padStart(5)}  ${pct(R.valor.parcela, R.valor.gab).padStart(5)}`);
    console.log(`      ERRADO   ${String(R.valor.erro).padStart(5)}  ${pct(R.valor.erro, R.valor.gab).padStart(5)}`);
    console.log(`      vazio    ${String(R.valor.vazio).padStart(5)}  ${pct(R.valor.vazio, R.valor.gab).padStart(5)}`);
    console.log(`   NÚMERO (${R.numero.gab} com gabarito)`);
    console.log(`      certo    ${String(R.numero.ok).padStart(5)}  ${pct(R.numero.ok, R.numero.gab).padStart(5)}`);
    console.log(`      ERRADO   ${String(R.numero.erro).padStart(5)}  ${pct(R.numero.erro, R.numero.gab).padStart(5)}`);
    console.log(`      vazio    ${String(R.numero.vazio).padStart(5)}  ${pct(R.numero.vazio, R.numero.gab).padStart(5)}`);
    console.log('═'.repeat(70));

    if (SALVAR) {
        fs.writeFileSync(SALVAR, JSON.stringify(R, null, 2), 'utf8');
        console.log(`retrato salvo em ${SALVAR}`);
    }
    process.exit(0);
})();
