/**
 * _medir/_datas-ruins-no-banco.js — qual o alcance do bug da data sem validação?
 *
 * ACHADO em 11/09/2026 (`_medir/_auditar-caminho-pdf.js`, invariante E): 3 linhas de
 * 03.2026 com `Data de emissão = "31/12/1970"` — epoch 0 formatado. Todas com
 * origem `IA`.
 *
 * A causa é uma ASSIMETRIA entre os dois caminhos de leitura:
 *
 *   `_nf-visao.js:346-353`  →  valida: dia 1-31, mês 1-12, ano em
 *                              [anoAgora-6, anoAgora+1]. Só grava se plausível.
 *   `process-folder.js:376` →  `if (r.dataEmissao) pd['Data de emissão'] = r.dataEmissao;`
 *                              grava a string CRUA da IA, sem conferir nada.
 *
 * O comentário de `_nf-visao.js` diz por que a trava existe: "num comprovante de
 * 02/03/2026 a IA devolveu 02/03/2028 — dia e mês certos, ano errado. Uma data no
 * futuro distante desloca o documento para uma pasta-mês inexistente e ele SOME da
 * conferência". A defesa foi posta num caminho e esquecida no outro.
 *
 * Este script mede o alcance em TODOS os períodos antes de qualquer conserto:
 * quantas linhas, em que meses, por qual origem, e com que valor em jogo.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_datas-ruins-no-banco.js
 */
'use strict';
const h = require('./harness');
const pare = require('../routes/_pareamento');
const { getConnection, sql } = require('../config');
const { csvToRows } = require('../routes/process-folder');
const path = require('path');

const CAMPOS_DATA = ['Data de emissão', 'Data de vencimento', 'Competência', 'Período de apuração'];

// A MESMA janela que `_nf-visao.js` usa, para o diagnóstico falar a língua da
// defesa que já existe: do ano anterior ao próximo.
const anoAgora = new Date().getFullYear();
const JAN = anoAgora - 6, JAX = anoAgora + 1;

function classificar(s) {
    const t = String(s || '').trim();
    if (!t || t === '—') return null;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return { tipo: 'FORMATO', v: t };
    const [d, m, a] = t.split('/').map(Number);
    if (d < 1 || d > 31) return { tipo: 'DIA', v: t };
    if (m < 1 || m > 12) return { tipo: 'MES', v: t };
    if (a === 1970) return { tipo: 'EPOCH-0', v: t };
    if (a < JAN) return { tipo: 'ANO-ANTIGO', v: t };
    if (a > JAX) return { tipo: 'ANO-FUTURO', v: t };
    return null;
}

const numBR = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
};

(async () => {
    const pool = await getConnection();
    console.log(`janela plausível: [${JAN}, ${JAX}]  (a mesma de _nf-visao.js)\n`);

    const porTipo = {}, porOrigem = {}, porPeriodo = {};
    const casos = [];
    let totalLinhas = 0;

    for (const periodo of h.PERIODOS) {
        const r = await pool.request()
            .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
        if (!r.recordset.length) continue;
        const rows = csvToRows(r.recordset[0].CONTEUDO);
        totalLinhas += rows.length;

        for (const row of rows) {
            let pd = null;
            try { pd = JSON.parse(row.dados_parser || 'null'); } catch (_) { continue; }
            if (!pd) continue;
            for (const campo of CAMPOS_DATA) {
                const c = classificar(pd[campo]);
                if (!c) continue;
                const org = String(row.origem || '(vazio)').trim() || '(vazio)';
                porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1;
                porOrigem[org] = (porOrigem[org] || 0) + 1;
                porPeriodo[periodo] = (porPeriodo[periodo] || 0) + 1;
                const base = path.basename(String(row.arquivo).replace(/#p\d+$/, ''));
                casos.push({
                    periodo, arquivo: row.arquivo, origem: org, tipo: row.tipo,
                    campo, valorLido: c.v, classe: c.tipo,
                    gabValor: pare.valorDoNome(base),
                    valorGravado: numBR(pd['Valor total'] || pd['Valor total da nota']),
                });
            }
        }
    }

    console.log(`linhas varridas: ${totalLinhas}`);
    console.log(`datas inválidas: ${casos.length}\n`);

    const tabela = (rot, m) => {
        console.log(rot);
        for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1]))
            console.log(`   ${String(v).padStart(5)}  ${k}`);
    };
    if (casos.length) {
        tabela('POR CLASSE DE ERRO', porTipo);
        tabela('\nPOR ORIGEM', porOrigem);
        tabela('\nPOR PERÍODO', porPeriodo);

        console.log('\n── os casos ────────────────────────────────────────────────');
        for (const c of casos.slice(0, 40)) {
            console.log(`  [${c.periodo}] ${c.classe.padEnd(11)} ${c.campo.padEnd(20)} = ${c.valorLido}`);
            console.log(`      origem=${c.origem.padEnd(12)} tipo=${String(c.tipo || '?').slice(0, 14).padEnd(15)} valor=${c.valorGravado ?? '—'} (nome=${c.gabValor ?? '—'})`);
            console.log(`      ${String(c.arquivo).slice(0, 66)}`);
        }
        if (casos.length > 40) console.log(`  ... e mais ${casos.length - 40}`);

        // O dano concreto: data no FUTURO desloca o documento para pasta-mês
        // inexistente e ele sai da conferência (o motivo da trava na visão).
        const futuro = casos.filter(c => c.classe === 'ANO-FUTURO');
        const epoch = casos.filter(c => c.classe === 'EPOCH-0');
        console.log('\n── DANO ────────────────────────────────────────────────────');
        console.log(`   ANO-FUTURO: ${futuro.length}  ← desloca o documento para mês inexistente`);
        console.log(`   EPOCH-0:    ${epoch.length}  ← "31/12/1970": a IA devolveu 0/vazio e alguém formatou`);
        const comValor = casos.filter(c => c.gabValor).reduce((s, c) => s + c.gabValor, 0);
        console.log(`   valor (pelo nome) dos documentos afetados: R$ ${comValor.toFixed(2)}`);
    } else {
        console.log('nenhuma data inválida — o bug não se materializou no acervo.');
    }

    console.log('\nA correção natural é levar a sanidade de ano de _nf-visao.js:346-353');
    console.log('para o caminho da IA de texto (process-folder.js:376) — mesma janela.');
    process.exit(0);
})();
