/**
 * _medir/_tipo-guia-fraco.js — tirar `\bGUIA\b` do marcador FRACO custa quanto?
 *
 * ALVO (21/09/2026): a última família consertável desta rodada é FATURA→IMPOSTO,
 * 3 alertas, todos LOCALIZA, todos com evidência "GUIA" e origem
 * `conteúdo (fraco)`. A regra é a linha 84 de `_nf-parsers.js`:
 *
 *     ['IMPOSTO', /\bGUIA\b|\bDCTFWEB\b|\bINSS\b|\bFGTS\b|\bDARF\b|\bGPS\b/]
 *
 * `\bGUIA\b` sozinho é fraquíssimo: casa com "guia" em texto corrido (uma fatura
 * de locação de veículo menciona "guia de recolhimento", "guia do condutor"...).
 * Os outros termos da lista (DARF, GPS, INSS, FGTS, DCTFWeb) são inequívocos.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Quantos documentos do acervo estão classificados IMPOSTO apoiados SÓ em "GUIA"?
 *   • se forem só os 3 + poucos, remover o termo é cirúrgico
 *   • se muitos IMPOSTOs legítimos dependerem dele, remover quebra o que funciona
 *
 * O contrapeso importa: uma guia municipal de ISS pode não dizer DARF nem GPS, e
 * ser reconhecida só por "GUIA" ([[filtro-nao-fiscal-regra-a-regra]]: 15 dos 21
 * padrões custam zero, mas alguns custam caro).
 *
 * SOMENTE LEITURA — não altera _nf-parsers.js.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// os termos inequívocos que sobrariam se "GUIA" saísse
const FORTES_IMPOSTO = /\bDCTFWEB\b|\bINSS\b|\bFGTS\b|\bDARF\b|\bGPS\b|ARRECADACAO DE RECEITAS|GUIA DA PREVIDENCIA|GUIA DO FGTS|\bGNRE\b|\bGFD\b/;

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const impostos = Object.entries(idx).filter(([, i]) => i.tipo === 'IMPOSTO');

    let soGuia = 0, outroForte = 0, viaIA = 0, viaEmitente = 0, viaForte = 0;
    const listaSoGuia = [];

    for (const [arq, i] of impostos) {
        const ev = String(i.evidencia || '').trim();
        const org = String(i.origem || '').trim();
        const evN = norm(ev);

        if (/^IA:/i.test(ev) || org === 'IA' || /IA/.test(org)) { viaIA++; continue; }
        if (/emitente/i.test(org)) { viaEmitente++; continue; }

        if (evN === 'GUIA') { soGuia++; listaSoGuia.push([arq, ev, org]); }
        else if (FORTES_IMPOSTO.test(evN)) { viaForte++; }
        else { outroForte++; }
    }

    console.log(`documentos IMPOSTO no acervo: ${impostos.length}\n`);
    console.log('  por via de classificação:');
    console.log(`    evidência é exatamente "GUIA" (o termo em risco): ${String(soGuia).padStart(4)}  ${pct(soGuia, impostos.length)}`);
    console.log(`    termo inequívoco (DARF/GPS/INSS/FGTS/DCTFWeb):    ${String(viaForte).padStart(4)}  ${pct(viaForte, impostos.length)}`);
    console.log(`    emitente público:                                 ${String(viaEmitente).padStart(4)}  ${pct(viaEmitente, impostos.length)}`);
    console.log(`    IA:                                               ${String(viaIA).padStart(4)}  ${pct(viaIA, impostos.length)}`);
    console.log(`    outra evidência:                                  ${String(outroForte).padStart(4)}  ${pct(outroForte, impostos.length)}`);

    console.log('\n── os documentos que dependem SÓ de "GUIA" ──────────────────');
    for (const [arq, ev, org] of listaSoGuia)
        console.log(`   [${org}] ${arq.slice(0, 62)}`);

    // quantos desses parecem imposto DE VERDADE pelo nome?
    const PARECE_TRIBUTO = /\bDARF\b|\bGPS\b|\bINSS\b|\bFGTS\b|\bGUIA\b|\bIPVA\b|\bISS\b|\bICMS\b|\bDAM\b|\bTRIBUTO\b|PREFEITURA|RECEITA FEDERAL/;
    const tributoNoNome = listaSoGuia.filter(([arq]) => PARECE_TRIBUTO.test(norm(arq))).length;
    console.log(`\n  destes ${listaSoGuia.length}, quantos parecem tributo pelo NOME: ${tributoNoNome}`);
    console.log(`  quantos NÃO parecem (candidatos a falso positivo):   ${listaSoGuia.length - tributoNoNome}`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log('LEITURA');
    console.log('═'.repeat(70));
    console.log(`\n  Remover \\bGUIA\\b do WEAK afeta ${soGuia} documento(s) — ${pct(soGuia, impostos.length)} dos IMPOSTOs.`);
    if (tributoNoNome === 0) {
        console.log('  NENHUM deles parece tributo pelo nome: são todos falso positivo do');
        console.log('  termo solto. Remover é cirúrgico e não quebra imposto legítimo,');
        console.log('  porque os tributos reais são pegos por DARF/GPS/INSS/FGTS ou pelo');
        console.log('  emitente público.');
    } else {
        console.log(`  ⚠ ${tributoNoNome} parece(m) tributo de verdade — remover o termo os perderia.`);
        console.log('  Nesse caso a regra melhor é exigir CONTEXTO junto de "GUIA"');
        console.log('  (ex.: "GUIA DE RECOLHIMENTO", "GUIA DE ARRECADACAO"), não removê-lo.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
