/**
 * _medir/_conferir-reprocessamento-03.js — o reprocessamento resolveu?
 *
 * Roda DEPOIS de `_reprocessar-03.js` e responde uma coisa só: as linhas de
 * 03.2026 que estavam com origem vazia e sem nenhum campo do pareamento passaram a
 * ter dado?
 *
 * A conferência é pelo CONTEÚDO gravado, não pelo log do processamento — que é a
 * lição de [[cache-esconde-mudanca-de-extracao]] e de
 * [[releitura-congela-versao-do-parser]]: o log diz "processados N" mesmo quando
 * gravou vazio, e a contagem de linhas não muda quando o conteúdo muda.
 *
 * Imprime o ANTES esperado (87 linhas com origem vazia, medido em 11/09/2026 por
 * `_origem-vazia.js`) ao lado do DEPOIS real, por origem e por campo preenchido.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_conferir-reprocessamento-03.js [periodo]
 */
'use strict';
const h = require('./harness');
const { getConnection, sql } = require('../config');

const PERIODO = process.argv[2] || '03.2026';

// Baseline medido por `_origem-vazia.js` e `_fallback-parser-no-banco.js` em
// 11/09/2026, ANTES do reprocessamento. Fica no código para a comparação não
// depender de eu lembrar os números.
const ANTES = { origemVazia: 87, totalLinhas: 1253 };

const SEP = ';';
function parseCsv(txt) {
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === SEP) { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';

const ROTULOS = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const CAMPOS = Object.keys(ROTULOS);
const temCampo = (pd, c) => !!pd && ROTULOS[c].some(k => !VAZIO(pd[k]));

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('tipo', sql.Char(1), 'M')
        .input('periodo', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO, TOTAL_ARQUIVOS, ATUALIZADO_EM FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@tipo AND PERIODO=@periodo');
    if (!r.recordset.length) { console.log('sem relatório'); process.exit(1); }

    const row = r.recordset[0];
    console.log(`período: ${PERIODO}`);
    if (row.ATUALIZADO_EM) console.log(`atualizado em: ${new Date(row.ATUALIZADO_EM).toISOString()}`);

    const linhas = parseCsv(String(row.CONTEUDO || '').replace(/^﻿/, ''));
    const head = linhas[0].map(s => String(s).replace(/^﻿/, '').trim());
    const I = k => head.indexOf(k);

    const acc = {};
    let total = 0, vaziaSemNada = 0, vaziaComAlgo = 0;
    const recuperados = [];
    for (const l of linhas.slice(1)) {
        if (!l[I('arquivo')]) continue;
        total++;
        const origem = String(l[I('origem')] || '').trim() || '(vazio)';
        let pd = null;
        try { pd = JSON.parse(l[I('dados_parser')] || 'null'); } catch (_) {}
        const a = acc[origem] || (acc[origem] = { n: 0, semNenhum: 0 });
        a.n++;
        const tem = CAMPOS.filter(c => temCampo(pd, c)).length;
        if (!tem) a.semNenhum++;
        if (origem === '(vazio)' || origem === '—') {
            if (tem) { vaziaComAlgo++; if (recuperados.length < 12) recuperados.push({ arq: l[I('arquivo')], tipo: l[I('tipo')], tem }); }
            else vaziaSemNada++;
        }
    }

    console.log(`\nlinhas: ${total}  (antes: ${ANTES.totalLinhas})`);
    console.log('\nPOR ORIGEM');
    console.log('origem                 linhas   sem nenhum campo');
    for (const [o, a] of Object.entries(acc).sort((x, y) => y[1].n - x[1].n))
        console.log(o.slice(0, 20).padEnd(22) + String(a.n).padStart(6) + String(a.semNenhum).padStart(18));

    const vaziaTotal = vaziaSemNada + vaziaComAlgo;
    console.log('\n── O ALVO: linhas com origem vazia ─────────────────────────');
    console.log(`   antes:  ${ANTES.origemVazia} linhas, todas sem campo`);
    console.log(`   agora:  ${vaziaTotal} linhas  →  ${vaziaComAlgo} com algum campo, ${vaziaSemNada} ainda sem`);
    if (vaziaTotal < ANTES.origemVazia)
        console.log(`   ${ANTES.origemVazia - vaziaTotal} linhas SAÍRAM da faixa (ganharam carimbo de origem)`);

    if (recuperados.length) {
        console.log('\n   exemplos recuperados:');
        for (const x of recuperados)
            console.log(`     ${String(x.tem)}/4 campos  ${String(x.tipo || '?').slice(0, 16).padEnd(17)} ${String(x.arq).slice(0, 50)}`);
    }

    const visao = acc['visão (IA)'] ? acc['visão (IA)'].n : 0;
    console.log(`\nlinhas com origem "visão (IA)": ${visao}`);
    console.log('(era 50 no acervo INTEIRO antes; se subiu, a visão leu os PDF-imagem)');
    process.exit(0);
})();
