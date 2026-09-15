/**
 * _medir/_estado-do-acervo.js — o retrato do que está GRAVADO hoje.
 *
 * Pergunta do usuário (14/09/2026): "quais campos ele salva sem problema e como está
 * a cobertura?"
 *
 * Duas perguntas diferentes, que este script não mistura:
 *
 *   COBERTURA — o campo está preenchido? (mede se o extrator alcança o documento)
 *   PRECISÃO  — o que está lá está CERTO? (só dá para medir onde há gabarito)
 *
 * Um campo com 100% de cobertura e 50% de precisão é pior que um com 60% e 95%: o
 * primeiro mente em silêncio. Por isso as duas colunas andam juntas no relatório.
 *
 * O gabarito é o NOME DO ARQUIVO, que a contabilidade digita: valor, número e data.
 * Para os demais campos não há gabarito — deles só se pode medir cobertura, e o
 * relatório diz isso explicitamente em vez de inventar uma taxa.
 *
 * ── O recorte que evita a taxa enganosa ─────────────────────────────────────
 * 58% do acervo é documento que `categoriaNaoFiscal` filtra da conferência (consórcio,
 * empréstimo, financiamento). Misturar os dois grupos produz números que não
 * respondem a pergunta de ninguém — ver [[transcritos-fora-da-conferencia]]. O
 * relatório sai nos DOIS recortes, com o fiscal em primeiro lugar.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_estado-do-acervo.js
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

// Os campos que o pareamento realmente consulta, na ordem de precedência que
// comparar-notas.js usa. Agrupados por PAPEL, porque "cobertura do valor" é a união
// das chaves de valor, não a de cada uma isolada.
const GRUPOS = {
    'valor':      ['Valor total', 'Valor total da nota', 'Valor do boleto', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'],
    'número':     ['Nº da NF-e', 'Nº da NF-e (chave)', 'Nº da NFS-e', 'Número do documento',
                   'Numero da NF'],
    'emitente':   ['Emitente', 'Razão social', 'Nome do emitente'],
    'CNPJ':       ['CNPJ emitente', 'CNPJ'],
    'data':       ['Data de emissão', 'Data de vencimento'],
    'chave':      ['Chave de acesso', 'Nº da NF-e (chave)'],
    'boleto':     ['Linha digitável', 'Banco do boleto'],
    'retenção':   ['ISS retido', 'IRRF retido', 'INSS retido', 'CSLL retido',
                   'COFINS retido', 'PIS retido'],
};

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';
const temAlgum = (pd, ks) => ks.some(k => !VAZIO(pd[k]));

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    // Deduplica por nome de arquivo: o mesmo documento aparece no relatório diário e no
    // mensal, e contá-lo duas vezes inflaria tudo igualmente (ver parcelas-pn-sobram).
    const docs = new Map();
    const periodos = new Set();
    for (const reg of rr.recordset) {
        periodos.add(reg.PERIODO);
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;
            const base = path.basename(arq);
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!docs.has(base) || (pd && !docs.get(base).pd)) {
                docs.set(base, { pd, base, origem: x.origem, conteudo: x.conteudo, tipo: x.tipo });
            }
        }
    }

    const todos = [...docs.values()];
    const fiscais = todos.filter(d => !(rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(d.base)));

    console.log('═'.repeat(74));
    console.log('ESTADO DO ACERVO');
    console.log('═'.repeat(74));
    console.log(`períodos no banco:      ${periodos.size}`);
    console.log(`documentos distintos:   ${todos.length}`);
    console.log(`  escopo FISCAL:        ${fiscais.length}  (é o que a conferência usa)`);
    console.log(`  filtrados:            ${todos.length - fiscais.length}  (consórcio, empréstimo, financiamento)`);

    for (const [rotulo, conjunto] of [['ESCOPO FISCAL', fiscais], ['ACERVO INTEIRO', todos]]) {
        const comPd = conjunto.filter(d => d.pd);
        console.log('\n' + '─'.repeat(74));
        console.log(`${rotulo} — ${conjunto.length} documentos, ${comPd.length} com dados_parser`);
        console.log('─'.repeat(74));

        // ── COBERTURA por grupo de campos
        console.log('\nCOBERTURA (o campo está preenchido?)\n');
        console.log('   campo          preenchidos   cobertura');
        for (const [nome, chaves] of Object.entries(GRUPOS)) {
            const n = comPd.filter(d => temAlgum(d.pd, chaves)).length;
            console.log(`   ${nome.padEnd(13)} ${String(n).padStart(9)}   ${pct(n, comPd.length).padStart(6)}`);
        }

        // ── PRECISÃO onde há gabarito no nome
        console.log('\nPRECISÃO (o que está lá bate com o nome do arquivo?)\n');
        let gv = 0, vOk = 0, vErro = 0, vParcela = 0, vVazio = 0;
        let gn = 0, nOk = 0, nErro = 0, nVazio = 0;
        for (const d of comPd) {
            const g = j.gabaritos(d.base);
            if (g.valor != null) {
                gv++;
                const lido = j.num(d.pd['Valor total'])
                    ?? j.num(GRUPOS.valor.map(k => d.pd[k]).find(v => !VAZIO(v)));
                if (lido == null) vVazio++;
                else {
                    const c = j.jValor(lido, g.valor);
                    if (c === 'ok') vOk++; else if (c === 'parcela') vParcela++; else vErro++;
                }
            }
            if (g.numero != null) {
                gn++;
                const lido = GRUPOS.número.map(k => d.pd[k]).find(v => !VAZIO(v));
                if (lido == null) nVazio++;
                else {
                    const a = String(lido).replace(/\D/g, '');
                    const b = String(g.numero).replace(/\D/g, '');
                    if (a && b && (a === b || a.endsWith(b) || b.endsWith(a))) nOk++; else nErro++;
                }
            }
        }
        console.log(`   VALOR  — ${gv} documentos com valor no nome`);
        console.log(`      certo      ${String(vOk).padStart(6)}   ${pct(vOk, gv).padStart(5)}`);
        console.log(`      ~parcela   ${String(vParcela).padStart(6)}   ${pct(vParcela, gv).padStart(5)}   (lido é múltiplo/submúltiplo)`);
        console.log(`      ERRADO     ${String(vErro).padStart(6)}   ${pct(vErro, gv).padStart(5)}`);
        console.log(`      vazio      ${String(vVazio).padStart(6)}   ${pct(vVazio, gv).padStart(5)}`);
        console.log(`   NÚMERO — ${gn} documentos com número no nome`);
        console.log(`      certo      ${String(nOk).padStart(6)}   ${pct(nOk, gn).padStart(5)}`);
        console.log(`      ERRADO     ${String(nErro).padStart(6)}   ${pct(nErro, gn).padStart(5)}`);
        console.log(`      vazio      ${String(nVazio).padStart(6)}   ${pct(nVazio, gn).padStart(5)}`);

        // ── Por onde o dado entrou
        const porOrigem = new Map(), porConteudo = new Map();
        for (const d of conjunto) {
            const o = String(d.origem || '(vazio)');
            porOrigem.set(o, (porOrigem.get(o) || 0) + 1);
            const c = String(d.conteudo || '(vazio)');
            porConteudo.set(c, (porConteudo.get(c) || 0) + 1);
        }
        console.log('\nCOMO O DADO ENTROU\n');
        for (const [o, c] of [...porOrigem].sort((a, b) => b[1] - a[1]).slice(0, 6))
            console.log(`   ${String(c).padStart(6)}  origem: ${o}`);
        for (const [o, c] of [...porConteudo].sort((a, b) => b[1] - a[1]).slice(0, 6))
            console.log(`   ${String(c).padStart(6)}  conteúdo: ${o}`);
    }

    console.log('\n' + '═'.repeat(74));
    process.exit(0);
})();
