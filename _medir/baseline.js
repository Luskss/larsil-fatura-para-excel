/**
 * _medir/baseline.js — mede o motor ATUAL (_pareamento.js) nos 6 períodos.
 * É o número contra o qual toda mudança tem de ser comparada.
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

function medirPeriodo(c, periodo) {
    const pl = c.planilha[periodo] || { lancamentos: 0, itens: [] };
    const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);

    const documentosPorMes = {};
    for (const off of [0, ...par.VIZINHANCA]) {
        const alvo = par.deslocarPeriodo(periodo, off);
        const arquivos = c.pasta.arquivosPorMes[alvo] || [];
        documentosPorMes[alvo] = arquivos.map(a => par.documentoDoArquivo(a.nome, a.rel));
    }

    const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
    const todos = [...r.pares, ...r.paresVizinhos];
    const porVia = todos.reduce((a, p) => { a[p.via] = (a[p.via] || 0) + 1; return a; }, {});
    return {
        periodo,
        lancamentos: lancamentos.length,
        docsNoMes: (documentosPorMes[periodo] || []).length,
        conferidos: todos.length,
        noMes: r.pares.length,
        vizinhos: r.paresVizinhos.length,
        semDocumento: r.lancamentosSemDocumento,
        docsSemLancamento: r.documentosSemLancamento,
        fracos: r.fracos,
        porVia,
    };
}

function medirTudo(c) {
    return h.PERIODOS.map(p => medirPeriodo(c, p));
}

function resumir(linhas) {
    const s = linhas.reduce((a, l) => {
        a.lancamentos += l.lancamentos; a.conferidos += l.conferidos;
        a.semDocumento += l.semDocumento; a.fracos += l.fracos;
        a.docsSemLancamento += l.docsSemLancamento;
        for (const [k, n] of Object.entries(l.porVia)) a.porVia[k] = (a.porVia[k] || 0) + n;
        return a;
    }, { lancamentos: 0, conferidos: 0, semDocumento: 0, fracos: 0, docsSemLancamento: 0, porVia: {} });
    s.cobertura = s.conferidos / s.lancamentos;
    return s;
}

if (require.main === module) {
    const c = h.carregar();
    const linhas = medirTudo(c);
    console.log('período   lanç  docs  confer  noMês  viz  semDoc  docSemL  fracos');
    for (const l of linhas) {
        console.log(
            `${l.periodo}  ${String(l.lancamentos).padStart(4)}  ${String(l.docsNoMes).padStart(4)}` +
            `  ${String(l.conferidos).padStart(6)}  ${String(l.noMes).padStart(5)}` +
            `  ${String(l.vizinhos).padStart(3)}  ${String(l.semDocumento).padStart(6)}` +
            `  ${String(l.docsSemLancamento).padStart(7)}  ${String(l.fracos).padStart(6)}`);
    }
    const s = resumir(linhas);
    console.log('\nTOTAL');
    console.log(`  lançamentos ......... ${s.lancamentos}`);
    console.log(`  conferidos .......... ${s.conferidos}  (${(s.cobertura * 100).toFixed(1)}%)`);
    console.log(`  sem documento ....... ${s.semDocumento}`);
    console.log(`  docs sem lançamento . ${s.docsSemLancamento}`);
    console.log(`  fracos (1 sinal) .... ${s.fracos}  (${(s.fracos / s.conferidos * 100).toFixed(1)}% dos pares)`);
    console.log('  por via:');
    for (const [k, n] of Object.entries(s.porVia).sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(n).padStart(5)}  ${k}`);
}

module.exports = { medirPeriodo, medirTudo, resumir };
