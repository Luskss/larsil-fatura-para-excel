/**
 * _medir/_efeito-visao-no-pareamento.js — a visão diminuiu as notas não encontradas?
 *
 * A releitura de 03.2026 com visão gravou campos em 66 documentos que antes não
 * tinham nenhum. A pergunta do usuário é a certa: isso reduz o que o painel mostra
 * como "faltando na pasta"?
 *
 * Não dá para deduzir. Um documento que ganhou emitente e valor só reduz o número
 * se ANTES não casava e AGORA casa — e o pareamento tem três sinais (valor, número,
 * entidade), então campo novo pode não mudar nada, ou pode desempatar um par que
 * já existia por outro caminho.
 *
 * Mede rodando o MESMO `conferirPeriodo` sobre dois índices de OCR:
 *   ANTES  — o cache salvo antes da releitura (`scratchpad/ocr-antes.json`)
 *   DEPOIS — o banco atual (reindexado)
 *
 * Compara lançamentos sem documento, pares, e QUAIS lançamentos mudaram de estado.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const PERIODO = process.argv[2] || '03.2026';
const CACHE_ANTES = process.argv[3] ||
    'C:/Users/LUCAS~1.PER/AppData/Local/Temp/claude/c--Users-lucas-pereira-Herd-larsil-fatura-para-excel-master/7cdbf091-bbba-4e0b-8cbb-2beee2c83536/scratchpad/ocr-antes.json';

function rodar(pasta, planilha, ocr) {
    const docsPorMes = {};
    for (const off of [0, ...p.VIZINHANCA]) {
        const alvo = p.deslocarPeriodo(PERIODO, off);
        docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
            p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
    }
    const lancs = ((planilha[PERIODO] || {}).itens || []).map(p.lancamentoDaPlanilha);
    const r = p.conferirPeriodo(lancs, docsPorMes, PERIODO);
    // Chave estável do lançamento, para saber QUAIS mudaram de estado.
    const chave = l => `${l.entidade}|${l.nf}|${l.valor}`;
    const casados = new Set([...r.pares, ...r.paresVizinhos].map(x => chave(x.lancamento)));
    return {
        totalLanc: lancs.length,
        pares: r.pares.length,
        vizinhos: r.paresVizinhos.length,
        semDoc: r.lancamentosSemDocumento,
        fracos: r.fracos,
        docsSemLanc: r.documentosSemLancamento,
        casados,
        porVia: [...r.pares, ...r.paresVizinhos].reduce((a, x) => {
            a[x.via] = (a[x.via] || 0) + 1; return a;
        }, {}),
        lancs,
        chave,
    };
}

const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
    const { pasta, planilha } = h.carregar();

    if (!fs.existsSync(CACHE_ANTES)) {
        console.error('cache ANTES não encontrado:', CACHE_ANTES);
        process.exit(1);
    }
    const ocrAntes = JSON.parse(fs.readFileSync(CACHE_ANTES, 'utf8'));
    console.error('[efeito] reindexando o banco atual...');
    const ocrDepois = await indexar();

    console.log(`índice ANTES:  ${Object.keys(ocrAntes).length} arquivos`);
    console.log(`índice DEPOIS: ${Object.keys(ocrDepois).length} arquivos\n`);

    const A = rodar(pasta, planilha, ocrAntes);
    const D = rodar(pasta, planilha, ocrDepois);

    console.log(`══ ${PERIODO} ══`);
    console.log('                              ANTES    DEPOIS');
    console.log(`lançamentos na planilha    ${String(A.totalLanc).padStart(8)}${String(D.totalLanc).padStart(10)}`);
    console.log(`  casados (mês)            ${String(A.pares).padStart(8)}${String(D.pares).padStart(10)}`);
    console.log(`  casados (pasta vizinha)  ${String(A.vizinhos).padStart(8)}${String(D.vizinhos).padStart(10)}`);
    console.log(`  SEM DOCUMENTO            ${String(A.semDoc).padStart(8)}${String(D.semDoc).padStart(10)}   ${D.semDoc - A.semDoc >= 0 ? '+' : ''}${D.semDoc - A.semDoc}`);
    console.log(`  pares fracos             ${String(A.fracos).padStart(8)}${String(D.fracos).padStart(10)}`);
    console.log(`documentos sem lançamento  ${String(A.docsSemLanc).padStart(8)}${String(D.docsSemLanc).padStart(10)}`);

    console.log('\nvia de casamento:');
    const vias = new Set([...Object.keys(A.porVia), ...Object.keys(D.porVia)]);
    for (const v of [...vias].sort())
        console.log(`  ${v.padEnd(28)}${String(A.porVia[v] || 0).padStart(6)}${String(D.porVia[v] || 0).padStart(10)}`);

    // Quem mudou de estado — o que responde a pergunta de verdade.
    const ganhou = D.lancs.filter(l => D.casados.has(D.chave(l)) && !A.casados.has(A.chave(l)));
    const perdeu = D.lancs.filter(l => !D.casados.has(D.chave(l)) && A.casados.has(A.chave(l)));

    console.log(`\nlançamentos que PASSARAM a ter documento: ${ganhou.length}`);
    console.log(`  valor: ${brl(ganhou.reduce((s, l) => s + Math.abs(l.valor || 0), 0))}`);
    for (const l of ganhou.slice(0, 20))
        console.log(`    ${String(l.entidade).slice(0, 30).padEnd(30)} NF ${String(l.nf).padEnd(9)} ${brl(Math.abs(l.valor))}`);

    console.log(`\nlançamentos que DEIXARAM de ter documento: ${perdeu.length}` +
        (perdeu.length ? '   ← regressão, investigar' : '   (nenhuma regressão)'));
    for (const l of perdeu.slice(0, 20))
        console.log(`    ${String(l.entidade).slice(0, 30).padEnd(30)} NF ${String(l.nf).padEnd(9)} ${brl(Math.abs(l.valor))}`);

    process.exit(0);
})();
