/**
 * _medir/_reprocessar-arquivos.js — reprocessa ARQUIVOS ESPECÍFICOS, não a pasta.
 *
 * Pergunta do usuário (11/09/2026): tem como forçar o scan só nos que deram
 * problema? `processFolderAuto` não aceita filtro de arquivo — só `forceAI` e
 * `forceLocal`, e varre a pasta inteira (933 arquivos, 34 minutos, ~US$ 2,40).
 *
 * Para consertar 2 linhas isso é desproporcional. Este script usa as MESMAS peças
 * da rota — `analyzePdf` para ler e `upsertRelatorio` para gravar — sobre uma lista
 * explícita de arquivos.
 *
 * ── Por que é seguro gravar só um pedaço ─────────────────────────────────────
 * `upsertRelatorio` faz merge por `arquivo|pasta` e PRESERVA as linhas que não
 * aparecem no lote novo (é o que o comentário dele descreve: "preserva entradas
 * antigas"). E trata parcelas como bloco: ao gravar qualquer linha de um PDF,
 * remove todas as antigas daquele PDF antes de inserir — então um documento que
 * agora rende menos parcelas não deixa sobras ([[parcelas-pn-sobram-no-upsert]]).
 *
 * ── O que este script NÃO faz ────────────────────────────────────────────────
 * Não recalcula o relatório DIÁRIO ('D'), só o mensal ('M'). A rota grava os dois;
 * aqui o alvo é a linha que a conferência lê. Se o diário importar, rodar o scan
 * completo.
 *
 * Uso:
 *   node _medir/_reprocessar-arquivos.js 03.2026 "trecho do nome" ["outro"] ...
 *   node _medir/_reprocessar-arquivos.js 03.2026 --trava     (os do bug da TRAVA)
 *   ... --confirmar   para gravar de verdade (sem isso é dry-run)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const pare = require('../routes/_pareamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const args = process.argv.slice(2);
const CONFIRMAR = args.includes('--confirmar');
const PERIODO = args.find(a => /^\d{2}\.\d{4}$/.test(a)) || '03.2026';
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const SUB = `2026.${PERIODO.split('.')[0]}.EXTRATOS CONTABILIDADE`;

// Os arquivos do bug da TRAVA achado em `_medir/_auditar-pos-scan.js`: a visão
// marcou o valor como não-confiável e o parser sobre texto TRANSCRITO gravou um
// `Valor total` por cima, sem passar pelo gabarito.
const ALVOS_TRAVA = [
    '002.DOC- 52610,67-2026.03.04.FN.SANTANDER.FT7900',
    '038.doc- 1459,72 pgto ADTO SALARIAL - estorno 20.03',
];

const trechos = args.includes('--trava')
    ? ALVOS_TRAVA
    : args.filter(a => !a.startsWith('--') && !/^\d{2}\.\d{4}$/.test(a));

if (!trechos.length) {
    console.log('nenhum trecho de nome informado. Use --trava ou passe trechos.');
    process.exit(1);
}

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

(async () => {
    console.log(`período: ${PERIODO}`);
    console.log(`pasta:   ${path.join(RAIZ_ARQ, SUB)}`);
    console.log(`alvos:   ${trechos.length} trecho(s) de nome\n`);

    // Acha os PDFs na pasta do período. `collectPdfs` da rota já aplica o filtro de
    // CPV/extrato e devolve `{path, name, folder}` — a forma que `analyzePdf` espera.
    const todos = await pf.collectPdfs(path.join(RAIZ_ARQ, SUB));
    const alvos = todos.filter(p => trechos.some(t => p.name.includes(t)));

    if (!alvos.length) { console.log('nenhum arquivo casou com os trechos.'); process.exit(1); }
    console.log(`arquivos encontrados: ${alvos.length}`);
    for (const a of alvos) console.log(`   ${a.name.slice(0, 66)}`);

    // Estado ATUAL no banco, para comparar depois.
    const pool = await getConnection();
    const antes = new Map();
    {
        const r = await pool.request()
            .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
        if (r.recordset.length)
            for (const x of pf.csvToRows(r.recordset[0].CONTEUDO)) antes.set(x.arquivo, x);
    }

    console.log('\n── ANTES (no banco) ────────────────────────────────────────');
    for (const a of alvos) {
        const x = antes.get(a.name);
        if (!x) { console.log(`   ${a.name.slice(0, 50)}: (sem linha)`); continue; }
        let d = null; try { d = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        console.log(`   ${a.name.slice(0, 54)}`);
        console.log(`      conteudo=${x.conteudo}  origem=${JSON.stringify(x.origem)}  tipo=${x.tipo}`);
        // As DUAS chaves: o DANFE usa 'Valor total da nota' e os outros tipos
        // 'Valor total'. Olhar só uma mostrou `undefined` onde havia valor —
        // ver [[chave-do-parser-e-em-portugues]].
        console.log(`      Valor total=${JSON.stringify(d && (d['Valor total'] || d['Valor total da nota']))}` +
            `  divergente=${JSON.stringify(d && d['Valor lido (não confere com o nome)'])}`);
    }

    if (!CONFIRMAR) {
        console.log('\nDRY-RUN — nada gravado. Acrescente --confirmar para executar.');
        process.exit(0);
    }

    // Relê cada um pelo caminho LOCAL (visão + transcrição + parsers), o MESMO que o
    // scan usou — `analyzePdf` sem `forceAI`. A função passou a ser exportada para
    // isto; antes só `processFolderAuto` era público e ele varre a pasta inteira.
    console.log('\n── RELENDO ─────────────────────────────────────────────────');
    const novasRows = [];
    for (const a of alvos) {
        console.log(`   ${a.name.slice(0, 58)}`);
        const rows = await pf.analyzePdf(a, {});
        if (!rows || !rows.length) { console.log('      (nenhuma row)'); continue; }
        for (const r of rows) novasRows.push(r);
        for (const r of rows) {
            let d = null; try { d = JSON.parse(r.dados_parser || 'null'); } catch (_) {}
            console.log(`      → conteudo=${r.conteudo}  tipo=${r.tipo}  origem=${JSON.stringify(r.origem)}`);
            console.log(`        Valor total=${JSON.stringify(d && d['Valor total'])}` +
                `  divergente=${JSON.stringify(d && d['Valor lido (não confere com o nome)'])}` +
                `  transcrito=${JSON.stringify(d && d['Valor lido do texto transcrito'])}`);
        }
    }

    if (!novasRows.length) { console.log('\nnada a gravar.'); process.exit(1); }

    await pf.upsertRelatorio(pool, 'M', PERIODO, novasRows);
    console.log(`\n✓ gravadas ${novasRows.length} row(s) em ${PERIODO} (merge preserva o resto)`);
    console.log('Confira com: node _medir/_auditar-pos-scan.js ' + PERIODO);
    process.exit(0);
})();
