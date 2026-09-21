/**
 * _medir/_meses-nao-processados-v2.js — o buraco de 07-09/2026, com a régua certa.
 *
 * A v1 (`_meses-nao-processados.js`) dimensionou bem os PDFs (1.386 fora do banco)
 * mas errou feio na planilha: contou **15.326 lançamentos e R$ 971 milhões** só em
 * 01/2026, quando o painel fala em ~3.057 lançamentos em SEIS meses.
 *
 * A causa: li a coluna `DATA` de TODAS as linhas da aba, sem os filtros que a rota
 * aplica (ORIG/FILIAL de escopo, contas sem documento, categorias não-fiscais) e
 * sem deduplicar — a planilha traz cada parcela futura como linha própria, por isso
 * aparecem meses até 2030.
 *
 * `harness.carregar().planilha` já é a planilha lida PELO CAMINHO DA ROTA
 * (`contarNaPlanilha`), com os filtros de produção. É o número que o painel mostra.
 * Esta versão usa isso, e só complementa com a varredura da pasta.
 *
 * ⚠️ O harness só carrega `PERIODOS` (jan–jun). Para ver 07-09 preciso chamar
 * `contarNaPlanilha` diretamente e ler os meses que interessam.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const base = s => String(s || '').replace(/#p\d+$/i, '');

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const noBanco = new Set(Object.keys(idx).map(base));

    // a planilha PELO CAMINHO DA ROTA — os mesmos filtros do painel
    console.error('[medir] lendo a planilha pelo caminho da rota...');
    const porMes = rota.contarNaPlanilha(process.env.PLANILHA_PATH);

    const meses = Object.keys(c.pasta.arquivosPorMes || {}).sort((a, b) => {
        const [ma, aa] = a.split('.'), [mb, ab] = b.split('.');
        return (aa - ab) || (ma - mb);
    });

    console.log('── pasta × banco × planilha (régua do painel) ──────────────\n');
    console.log('  mês       PDFs   no banco   faltam   lançamentos       valor');
    let pdfFaltam = 0, lancSemCobertura = 0, valSemCobertura = 0;
    const semBanco = [];

    for (const m of meses) {
        const arqs = c.pasta.arquivosPorMes[m] || [];
        const dentro = arqs.filter(a => noBanco.has(base(a.nome))).length;
        const fora = arqs.length - dentro;
        const pl = porMes[m] || {};
        const lancs = (pl.itens || []).length || pl.lancamentos || 0;
        const valor = (pl.itens || []).reduce((s, l) => s + Math.abs(Number(l.valor) || 0), 0);
        const marca = fora > arqs.length * 0.5 ? '  ←' : '';
        console.log(`  ${m}  ${String(arqs.length).padStart(5)}  ${String(dentro).padStart(9)}  ${String(fora).padStart(7)}  ${String(lancs).padStart(12)}  ${brl(valor).padStart(16)}${marca}`);
        if (fora > arqs.length * 0.5) {
            semBanco.push(m);
            pdfFaltam += fora;
            lancSemCobertura += lancs;
            valSemCobertura += valor;
        }
    }

    console.log(`\n${'═'.repeat(68)}`);
    console.log('O BURACO');
    console.log('═'.repeat(68));
    console.log(`\n  meses sem processamento: ${semBanco.join(', ') || '(nenhum)'}`);
    console.log(`  PDFs a processar:        ${pdfFaltam}`);
    console.log(`  lançamentos esperando:   ${lancSemCobertura}`);
    console.log(`  valor envolvido:         ${brl(valSemCobertura)}`);

    // referência: o que os 6 meses medidos representam
    const refLanc = h.PERIODOS.reduce((s, m) => s + ((porMes[m] || {}).itens || []).length, 0);
    const refPdf = h.PERIODOS.reduce((s, m) => s + (c.pasta.arquivosPorMes[m] || []).length, 0);
    console.log(`\n  para comparar, jan–jun/2026: ${refPdf} PDFs e ${refLanc} lançamentos`);
    console.log(`  o buraco é ${pct(pdfFaltam, refPdf)} do volume de 6 meses, em PDFs`);
    console.log(`  e ${pct(lancSemCobertura, refLanc)} em lançamentos`);

    console.log('\n── por que isto é diferente de reescanear ──────────────────');
    console.log('  Estes PDFs NUNCA foram lidos: não há extração boa para sobrescrever,');
    console.log('  então o risco de [[reescanear-nao-se-paga]] (101 linhas de IA relidas');
    console.log('  por parser local) NÃO se aplica. É scan de documento novo.');
    if (lancSemCobertura > 0) {
        console.log('\n  E há lançamento esperando documento: processar faz o painel');
        console.log('  responder por esses meses, que hoje ele simplesmente não cobre.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
