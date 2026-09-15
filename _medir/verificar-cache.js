/**
 * _medir/verificar-cache.js — igual a `verificar.js`, mas lê o índice do OCR de
 * `.cache/ocr.json` em vez de consultar o SQL.
 *
 * Existe porque `verificar.js` precisa do banco, que nem sempre alcança daqui (a
 * rede `\\larsil-dell` cai fora do VPN). O índice cacheado é o MESMO que
 * `contarNoCsv` produziu, então o caminho medido continua sendo o de produção:
 * `documentoDoArquivo` + `enriquecerComOcr` + `conferirPeriodo`.
 *
 * Medir SEM `enriquecerComOcr` (como faz `baseline.js`) dá outro número — o
 * documento fica sem data e o veto de janela some. Não é comparável.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const par = require('../routes/_pareamento');

function indiceOcr() {
    const f = path.join(h.CACHE, 'ocr.json');
    if (!fs.existsSync(f)) throw new Error('falta _medir/.cache/ocr.json — rode _medir/ocr.js');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function medir() {
    const c = h.carregar();
    const idx = indiceOcr();
    // O MESMO resolvedor da rota: prefere a chave `pasta|arquivo` e cai no nome.
    const { ocrDoDocumento } = h.internasDaRota();

    const tot = { lanc: 0, conf: 0, sem: 0, fracos: 0, porVia: {}, porForca: {} };
    const linhas = [];
    for (const periodo of h.PERIODOS) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel),
                    ocrDoDocumento(idx, a.nome, a.rel)));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const todos = [...r.pares, ...r.paresVizinhos];
        for (const p of todos) {
            tot.porVia[p.via] = (tot.porVia[p.via] || 0) + 1;
            tot.porForca[p.forca] = (tot.porForca[p.forca] || 0) + 1;
        }
        linhas.push({ periodo, lanc: lancamentos.length, conf: todos.length,
                      sem: r.lancamentosSemDocumento, fracos: r.fracos });
        tot.lanc += lancamentos.length; tot.conf += todos.length;
        tot.sem += r.lancamentosSemDocumento; tot.fracos += r.fracos;
    }
    return { linhas, tot };
}

if (require.main === module) {
    const { linhas, tot } = medir();
    console.log('período   lanç  confer  semDoc  fracos');
    for (const l of linhas)
        console.log(`${l.periodo}  ${String(l.lanc).padStart(4)}  ${String(l.conf).padStart(6)}` +
            `  ${String(l.sem).padStart(6)}  ${String(l.fracos).padStart(6)}`);
    console.log(`\nTOTAL  lançamentos ${tot.lanc}  conferidos ${tot.conf}` +
        ` (${(tot.conf / tot.lanc * 100).toFixed(1)}%)  semDoc ${tot.sem}  fracos ${tot.fracos}`);
    // "2º campo" = pares com pelo menos 2 dos 3 sinais. É a métrica de PRECISÃO
    // que escolheu a regra atual (§10): cobertura comprada com par fraco não conta.
    const doisMais = Object.entries(tot.porForca)
        .reduce((s, [f, n]) => s + (Number(f) >= 2 ? n : 0), 0);
    console.log(`confirmados por 2º campo: ${doisMais} (${(doisMais / tot.conf * 100).toFixed(1)}%)`);
    console.log('por via:');
    for (const [k, n] of Object.entries(tot.porVia).sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(n).padStart(5)}  ${k}`);
}

module.exports = { medir, indiceOcr };
