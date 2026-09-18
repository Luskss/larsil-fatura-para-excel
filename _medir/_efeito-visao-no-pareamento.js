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
// O índice ANTES é um retrato do banco, salvo antes da releitura. O padrão fica em
// `_medir/.cache/` (dentro do projeto, ignorado pelo git) e NÃO no scratchpad da
// sessão: o caminho anterior trazia um ID de sessão de 10/09/2026 embutido, e bastou
// a sessão acabar para o script depender de um arquivo que ninguém consegue recriar.
//
// Para tirar um retrato novo antes de reler um mês:
//   node -e "require('./_medir/ocr').indexar().then(o=>require('fs').writeFileSync('_medir/.cache/ocr-antes.json',JSON.stringify(o)))"
const CACHE_ANTES = process.argv[3] || path.join(__dirname, '.cache', 'ocr-antes.json');

function rodar(pasta, planilha, ocr) {
    const docsPorMes = {};
    for (const off of [0, ...p.VIZINHANCA]) {
        const alvo = p.deslocarPeriodo(PERIODO, off);
        docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
            p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
    }
    const lancs = ((planilha[PERIODO] || {}).itens || []).map(p.lancamentoDaPlanilha);
    const r = p.conferirPeriodo(lancs, docsPorMes, PERIODO);

    // `conferirPeriodo` devolve DOIS campos parecidos e de tipos diferentes:
    //   lancamentosSemDocumento → NÚMERO (a contagem)
    //   semDocumento            → a LISTA
    // Ler o número como se fosse lista é o defeito que este script teve até 18/09/2026:
    // `semDoc` recebia a contagem e a comparação ANTES×DEPOIS imprimia o mesmo valor nos
    // dois lados. Pior que quebrar — o script terminava com "+0" e cara de medição boa,
    // justamente no indicador que a pendência de 03.2026 mandava conferir.
    // A invariante abaixo falha alto se `conferirPeriodo` trocar os tipos de novo.
    if (typeof r.lancamentosSemDocumento !== 'number' || !Array.isArray(r.semDocumento)) {
        throw new Error('_pareamento mudou: esperado lancamentosSemDocumento:number e semDocumento:array');
    }
    if (r.semDocumento.length !== r.lancamentosSemDocumento) {
        throw new Error(`contagem ≠ lista: ${r.lancamentosSemDocumento} × ${r.semDocumento.length}`);
    }

    // Chave estável do lançamento, para saber QUAIS mudaram de estado.
    // Conferido em 03.2026: 628 lançamentos, 628 chaves distintas — não colide.
    const chave = l => `${l.entidade}|${l.nf}|${l.valor}`;
    const casados = new Set([...r.pares, ...r.paresVizinhos].map(x => chave(x.lancamento)));
    return {
        totalLanc: lancs.length,
        pares: r.pares.length,
        vizinhos: r.paresVizinhos.length,
        semDoc: r.semDocumento.length,
        // A lista, para dizer QUAIS lançamentos ficaram sem papel — a contagem sozinha
        // não distingue "trocou de estado" de "nada mudou".
        semDocLista: r.semDocumento,
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
        console.error(`\ncache ANTES não encontrado: ${CACHE_ANTES}\n`);
        console.error('Este script compara DOIS retratos do banco, e o "antes" tem de ter');
        console.error('sido salvo ANTES da releitura — depois dela, não há como recriá-lo.\n');
        console.error('Para tirar o retrato antes de reler um mês:');
        console.error(`  node -e "require('./_medir/ocr').indexar().then(o=>require('fs').writeFileSync('_medir/.cache/ocr-antes.json',JSON.stringify(o)))"\n`);
        console.error('Se a releitura JÁ aconteceu, este script não serve. Compare os meses');
        console.error('entre si — os que nunca tiveram o defeito são a linha de base (§17.7).\n');
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

    // ── Conferência cruzada: dois caminhos independentes para o mesmo número ────
    // O delta de "sem documento" (contagem) tem de bater com perdeu − ganhou (lista).
    // Se divergirem, um dos dois está errado e o relatório acima não vale — foi
    // exatamente assim que o defeito de `semDoc` passou despercebido: ele imprimia
    // "+0" enquanto os pares mudavam, e nada no script contestava.
    const deltaContagem = D.semDoc - A.semDoc;
    const deltaLista = perdeu.length - ganhou.length;
    console.log(`\n── conferência cruzada ──`);
    console.log(`   delta de "sem documento" : ${deltaContagem >= 0 ? '+' : ''}${deltaContagem}`);
    console.log(`   perdeu − ganhou          : ${deltaLista >= 0 ? '+' : ''}${deltaLista}`);
    if (deltaContagem !== deltaLista) {
        console.log(`   ⚠ DIVERGEM — o relatório acima não é confiável.`);
        console.log(`     Causa provável: um lançamento trocou de documento sem trocar de estado,`);
        console.log(`     ou a chave do lançamento colidiu. Investigue antes de concluir nada.`);
    } else {
        console.log(`   ✓ batem`);
    }

    process.exit(0);
})();
