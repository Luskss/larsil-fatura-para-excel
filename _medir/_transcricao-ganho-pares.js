/**
 * _medir/_transcricao-ganho-pares.js — as linhas transcritas ganharam PAR?
 *
 * Preencher campo não é o objetivo; casar lançamento com documento é. `_transcricao-preencheu.js`
 * mostrou que as 58 linhas transcritas trazem 3,36 dos 4 campos (contra 2,24 do texto
 * nativo), mas campo preenchido pode não mudar nada no pareamento: há três sinais
 * (valor, número, entidade) e um campo novo pode só reforçar par que já existia.
 *
 * Roda `conferirPeriodo` de VERDADE, pelo caminho de `_efeito-visao-no-pareamento.js`
 * — `documentoDoArquivo` + `enriquecerComOcr`, senão o documento fica sem data e o
 * veto de janela some ([[armadilha-medir-sem-ocr]]).
 *
 * ── Por que roda TODOS os períodos ───────────────────────────────────────────
 * 1ª versão rodou só 03.2026 e achou 6 dos 58 documentos transcritos — os outros 52
 * "sumiram". Não sumiram: um documento fica na pasta do mês em que foi PAGO, mas casa
 * com o lançamento pela data do papel, que pode ser de outro mês
 * ([[vizinhanca-mistura-meses]] mede 46% dos pares vindo de pastas vizinhas). Medir
 * um período só responde por um sexto do acervo e dá taxa falsa.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_transcricao-ganho-pares.js
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

function classe(conteudo) {
    const c = String(conteudo || '');
    if (/transcri/i.test(c)) return 'transcrição';
    if (/\(OCR\)/i.test(c))  return 'OCR';
    if (/^Imagem\s*$/i.test(c)) return 'imagem NÃO LIDA';
    return 'texto nativo';
}

(async () => {
    const { pasta, planilha } = h.carregar();

    // Como cada arquivo foi lido — de TODOS os relatórios mensais, não só um.
    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    const classeDe = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO))
            classeDe.set(path.basename(String(x.arquivo).replace(/#p\d+$/, '')), classe(x.conteudo));
    console.error(`[pares] ${rr.recordset.length} relatórios, ${classeDe.size} arquivos classificados`);

    console.error('[pares] reindexando o banco...');
    const ocr = await indexar();

    const nomeDoc = d => path.basename(String(d?.arquivo || d?.nome || '').replace(/#p\d+$/, ''));
    const pareados = new Set();
    const viaPorClasse = {};
    let totLanc = 0, totPares = 0, totSem = 0;

    for (const PERIODO of h.PERIODOS) {
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(PERIODO, off);
            docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
        }
        const lancs = ((planilha[PERIODO] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const res = p.conferirPeriodo(lancs, docsPorMes, PERIODO);
        const pares = [...res.pares, ...res.paresVizinhos];
        totLanc += lancs.length; totPares += pares.length;
        totSem += (res.lancamentosSemDocumento || []).length;
        console.log(`${PERIODO}: ${String(lancs.length).padStart(4)} lanç · ${String(pares.length).padStart(4)} pares`);

        for (const x of pares) {
            const n = nomeDoc(x.documento);
            if (!n) continue;
            pareados.add(n);
            const k = classeDe.get(n) || '(sem relatório)';
            viaPorClasse[k] = viaPorClasse[k] || {};
            viaPorClasse[k][x.via] = (viaPorClasse[k][x.via] || 0) + 1;
        }
    }
    console.log(`\nTOTAL: ${totLanc} lançamentos · ${totPares} pares · ${totSem} sem documento`);

    const tot = {}, com = {};
    for (const [nome, k] of classeDe) {
        tot[k] = (tot[k] || 0) + 1;
        if (pareados.has(nome)) com[k] = (com[k] || 0) + 1;
    }

    console.log('\nDOCUMENTOS QUE ENTRARAM EM ALGUM PAR, por como foram lidos (todos os meses)');
    console.log('   classe             docs   pareados   taxa');
    for (const k of ['transcrição', 'OCR', 'imagem NÃO LIDA', 'texto nativo']) {
        if (!tot[k]) continue;
        const c = com[k] || 0;
        console.log('   ' + k.padEnd(18) + String(tot[k]).padStart(5) + String(c).padStart(11) +
            (100 * c / tot[k]).toFixed(0).padStart(6) + '%');
    }

    console.log('\nPOR QUAL SINAL casaram (via), por classe de leitura');
    for (const k of Object.keys(viaPorClasse))
        console.log('   ' + k.padEnd(20) + JSON.stringify(viaPorClasse[k]));

    process.exit(0);
})();
