/**
 * _medir/_conferir-as-perdas.js — as 9 perdas de "boleto primeiro" são reais?
 *
 * A regra "preferir `Valor do boleto`" mede GANHA 923 / PERDE 9. Antes de aplicar,
 * as 9 precisam ser olhadas uma a uma: se forem um documento só repetido em vários
 * relatórios, o risco é de 1 caso, não de 9.
 *
 * E há uma pergunta anterior: as perdas são erro de LEITURA ou do GABARITO? O caso
 * visto (RODRIGO, nome diz 231,50, boleto 46,30, nota 231,50) tem cara de carnê —
 * 231,50 = 5 × 46,30. Se o nome traz o TOTAL do carnê e o boleto é UMA parcela, então
 * quem está certo depende do que se paga, e o gabarito do nome não decide sozinho
 * ([[total-da-nota-nao-e-valor-lancado]]).
 *
 * Também confere a OUTRA metade do achado: os 700 casos em que o valor certo estava
 * em `Valor total` (e não no boleto) — que classe é essa?
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

    const vistos = new Set();
    const linhas = [];
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const ch = `${reg.TIPO}|${reg.PERIODO}|${arq}`;
            if (vistos.has(ch)) continue;
            vistos.add(ch);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            linhas.push({ arq, base, pd, gab: g.valor, tipoRel: reg.TIPO, periodo: reg.PERIODO });
        }

    // ── As perdas: hoje acerta, com boleto-primeiro erra ────────────────────
    const perdas = [];
    for (const l of linhas) {
        const hoje = j.num(primeiro(l.pd, ROT_VALOR));
        const bol  = j.num(l.pd['Valor do boleto']);
        const novo = bol ?? hoje;
        if (j.jValor(hoje, l.gab) === 'ok' && j.jValor(novo, l.gab) !== 'ok')
            perdas.push({ ...l, hoje, bol });
    }
    console.log(`PERDAS de "boleto primeiro": ${perdas.length} linha(s)`);
    const porArquivo = new Map();
    for (const p of perdas) {
        const k = p.base;
        if (!porArquivo.has(k)) porArquivo.set(k, []);
        porArquivo.get(k).push(p);
    }
    console.log(`   documentos DISTINTOS afetados: ${porArquivo.size}\n`);
    for (const [base, ps] of porArquivo) {
        const p = ps[0];
        const razao = p.hoje / p.bol;
        console.log(`   ${base.slice(0, 58)}`);
        console.log(`      aparece em ${ps.length} relatório(s): ` +
            ps.map(x => `${x.tipoRel}${x.periodo}`).join(' '));
        console.log(`      nome=${p.gab}  nota=${p.hoje}  boleto=${p.bol}` +
            `   nota/boleto = ${razao.toFixed(2)}`);
        console.log(`      parcelas no doc: ${JSON.stringify(p.pd['Parcelas'] ?? p.pd['Qtd. parcelas'] ?? '—')}` +
            `   tipo=${JSON.stringify(p.pd['Tipo de guia'] ?? '')}`);
    }

    // ── A outra metade: os casos em que `Valor total` é que acerta ──────────
    let viaTotal = 0, viaBoleto = 0, ambos = 0;
    const semBoleto = [];
    for (const l of linhas) {
        const hoje = j.num(primeiro(l.pd, ROT_VALOR));
        if (j.jValor(hoje, l.gab) === 'ok') continue;
        const bolOk = j.num(l.pd['Valor do boleto']) != null &&
            Math.abs(j.num(l.pd['Valor do boleto']) - l.gab) <= 0.02;
        const totOk = j.num(l.pd['Valor total']) != null &&
            Math.abs(j.num(l.pd['Valor total']) - l.gab) <= 0.02;
        if (bolOk && totOk) ambos++;
        else if (bolOk) viaBoleto++;
        else if (totOk) { viaTotal++; if (semBoleto.length < 8) semBoleto.push(l); }
    }
    console.log(`\nONDE ESTÁ O VALOR CERTO, nos erros de hoje:`);
    console.log(`   só em 'Valor do boleto':  ${viaBoleto}`);
    console.log(`   só em 'Valor total':      ${viaTotal}`);
    console.log(`   nas duas:                 ${ambos}`);

    if (semBoleto.length) {
        console.log(`\n   exemplos em que 'Valor total' acerta e o boleto não resolve:`);
        for (const l of semBoleto) {
            console.log(`      nome=${String(l.gab).padStart(10)}` +
                `  nota=${String(j.num(l.pd['Valor total da nota']) ?? '—').padStart(11)}` +
                `  total=${String(j.num(l.pd['Valor total']) ?? '—').padStart(10)}` +
                `  bol=${String(j.num(l.pd['Valor do boleto']) ?? '—').padStart(9)}  ${l.base.slice(0, 30)}`);
        }
    }
    process.exit(0);
})();
