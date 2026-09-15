/**
 * _medir/_transcricao-por-que-nao-pareia.js — 2% contra 47% é resultado ou é a régua?
 *
 * `_transcricao-ganho-pares.js` deu: texto nativo pareia 47% dos documentos, transcrição
 * 2%. Diferença dessa ordem quase nunca é o efeito medido — é a medição.
 *
 * Três explicações possíveis, e elas pedem ações opostas:
 *   (a) a transcrição lê mal e o par não se forma       → reverter a transcrição
 *   (b) o documento transcrito NÃO TEM lançamento par   → 2% é o teto, não a falha
 *   (c) o pareamento nem chega a ver esses documentos    → bug de caminho
 *
 * Distingue assim: para cada documento transcrito, procura na planilha um lançamento
 * com o valor do GABARITO (o nome do arquivo). Se não existe lançamento com aquele
 * valor, o documento não tinha par para ganhar — e a taxa baixa é (b).
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

function classe(c) {
    c = String(c || '');
    if (/transcri/i.test(c)) return 'transcrição';
    if (/\(OCR\)/i.test(c))  return 'OCR';
    if (/^Imagem\s*$/i.test(c)) return 'imagem NÃO LIDA';
    return 'texto nativo';
}

(async () => {
    const { pasta, planilha } = h.carregar();

    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    const classeDe = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO))
            classeDe.set(path.basename(String(x.arquivo).replace(/#p\d+$/, '')), classe(x.conteudo));

    // Todos os valores lançados na planilha, em centavos, no acervo inteiro.
    const valores = new Map();
    for (const per of h.PERIODOS)
        for (const it of ((planilha[per] || {}).itens || [])) {
            const l = p.lancamentoDaPlanilha(it);
            const v = Math.round(Number(l.valor) * 100);
            if (Number.isFinite(v) && v > 0) valores.set(v, (valores.get(v) || 0) + 1);
        }
    console.log(`planilha: ${valores.size} valores distintos em ${h.PERIODOS.length} períodos\n`);

    // Nomes que existem na PASTA (é o que o pareamento enxerga).
    const naPasta = new Set();
    for (const per of Object.keys(pasta.arquivosPorMes))
        for (const a of pasta.arquivosPorMes[per]) naPasta.add(a.nome);

    const res = {};
    for (const [nome, k] of classeDe) {
        const r = res[k] || (res[k] = { n: 0, foraDaPasta: 0, semGab: 0, comLanc: 0, semLanc: 0 });
        r.n++;
        if (!naPasta.has(nome)) { r.foraDaPasta++; continue; }
        const g = j.gabaritos(nome).valor;
        if (g == null) { r.semGab++; continue; }
        if (valores.has(Math.round(g * 100))) r.comLanc++; else r.semLanc++;
    }

    console.log('O DOCUMENTO TINHA PAR PARA GANHAR? (valor do nome × valores da planilha)');
    console.log('   classe             docs  fora-da-pasta  s/gabarito  TEM lanç  não tem');
    for (const k of ['transcrição', 'OCR', 'imagem NÃO LIDA', 'texto nativo']) {
        const r = res[k]; if (!r) continue;
        console.log('   ' + k.padEnd(18) + String(r.n).padStart(5) + String(r.foraDaPasta).padStart(15) +
            String(r.semGab).padStart(12) + String(r.comLanc).padStart(10) + String(r.semLanc).padStart(9));
    }

    // Detalhe: os transcritos que existem na pasta, um a um.
    console.log('\nDETALHE — os transcritos que ESTÃO na pasta:');
    let i = 0;
    for (const [nome, k] of classeDe) {
        if (k !== 'transcrição' || !naPasta.has(nome)) continue;
        const g = j.gabaritos(nome).valor;
        const tem = g != null && valores.has(Math.round(g * 100));
        console.log(`   ${tem ? 'TEM LANÇ ' : g == null ? 's/gab    ' : 'sem lanç '} ${String(g ?? '').padStart(11)}  ${nome.slice(0, 46)}`);
        if (++i >= 45) { console.log('   ...'); break; }
    }
    process.exit(0);
})();
