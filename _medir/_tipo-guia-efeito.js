/**
 * _medir/_tipo-guia-efeito.js — o conserto de `\bGUIA\b` muda o quê, e QUANDO?
 *
 * APLICADO (21/09/2026): `_nf-parsers.js` WEAK[IMPOSTO] trocou `\bGUIA\b` solto
 * por `GUIA DE (RECOLHIMENTO|ARRECADACAO)`.
 *
 * ── A pergunta que importa para o usuário ───────────────────────────────────
 * `classify()` roda no PROCESSAMENTO do PDF, não na conferência. O banco guarda o
 * `tipo` já decidido. Logo o conserto NÃO reclassifica o que está gravado — ele
 * só age em documento novo ou releitura ([[cache-esconde-mudanca-de-extracao}}]).
 *
 * Então há duas respostas, e confundi-las seria prometer o que não acontece:
 *   a) efeito IMEDIATO no painel: zero, até reprocessar
 *   b) efeito APÓS releitura: os 6 documentos deixam de ser IMPOSTO
 *
 * Este script confirma (a) e simula (b): aplica as duas versões de WEAK ao texto
 * que levou cada um dos 6 a ser classificado, e mostra em que tipo cairiam.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// extrai a lista WEAK de um fonte de _nf-parsers.js
function weakDe(src) {
    const m = src.match(/const WEAK = \[[\s\S]*?\n\];/);
    if (!m) throw new Error('não achei WEAK');
    return new Function(`${m[0]}; return WEAK;`)();
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8');
    const WA = weakDe(antesSrc), WD = weakDe(depoisSrc);

    console.log('── WEAK[IMPOSTO] ────────────────────────────────────────────');
    console.log(`  antes : ${WA[0][1]}`);
    console.log(`  depois: ${WD[0][1]}`);

    // a ordem do WEAK decide o tipo: o 1º que casar vence
    const classificarWeak = (texto, WEAK) => {
        const t = norm(texto);
        for (const [cat, re] of WEAK) { const m = t.match(re); if (m) return [cat, m[0]]; }
        return ['Não identificado', '—'];
    };

    // Textos representativos dos 6 documentos afetados. Não temos o texto original
    // (o banco guarda só o rótulo de procedência), então testamos a FRASE que os
    // faria casar — e as frases de tributo legítimo, que NÃO podem quebrar.
    const CASOS = [
        ['fatura de locação com a palavra solta',
         'LOCALIZA RENT A CAR FATURA DE LOCACAO ... CONSULTE O GUIA DO CONDUTOR ...'],
        ['recibo de imobiliária',
         'IMOBILIARIA MENDES RECIBO DE ALUGUEL ... GUIA DO INQUILINO ...'],
        ['taxa de DETRAN',
         'DETRAN LICENCIAMENTO ... GUIA DE SERVICOS ...'],
        ['— guia de recolhimento (tributo REAL)',
         'PREFEITURA MUNICIPAL GUIA DE RECOLHIMENTO DE ISS ...'],
        ['— guia de arrecadação (tributo REAL)',
         'SEFAZ GUIA DE ARRECADACAO ESTADUAL ...'],
        ['— DARF (tributo REAL)',
         'DOCUMENTO DE ARRECADACAO DE RECEITAS FEDERAIS DARF ...'],
        ['— GPS (tributo REAL)',
         'GUIA DA PREVIDENCIA SOCIAL GPS ... INSS ...'],
    ];

    console.log('\n── efeito APÓS releitura, caso a caso ───────────────────────');
    console.log('  caso                                    antes        depois');
    let corrigidos = 0, quebrados = 0;
    for (const [rot, texto] of CASOS) {
        const [ca] = classificarWeak(texto, WA);
        const [cd] = classificarWeak(texto, WD);
        const ehTributoReal = rot.startsWith('—');
        if (!ehTributoReal && ca === 'IMPOSTO' && cd !== 'IMPOSTO') corrigidos++;
        if (ehTributoReal && ca === 'IMPOSTO' && cd !== 'IMPOSTO') quebrados++;
        const marca = (!ehTributoReal && ca !== cd) ? ' ✔ corrigido'
                    : (ehTributoReal && ca !== cd) ? ' ⚠ QUEBROU' : '';
        console.log(`  ${rot.padEnd(39)} ${ca.padEnd(12)} ${cd.padEnd(12)}${marca}`);
    }
    console.log(`\n  falso positivo corrigido: ${corrigidos}`);
    console.log(`  tributo legítimo quebrado: ${quebrados} ${quebrados === 0 ? '(ok)' : '(⚠ reverter!)'}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('QUANDO o efeito aparece');
    console.log('═'.repeat(68));
    console.log('\n  `classify()` roda no PROCESSAMENTO do PDF; o banco guarda o `tipo` já');
    console.log('  decidido. O conserto NÃO reclassifica o que está gravado.');
    console.log('\n    • efeito imediato no painel: ZERO (os 3 alertas LOCALIZA continuam)');
    console.log('    • efeito após releitura dos 6 documentos: eles saem de IMPOSTO');
    console.log('\n  Para valer agora seria preciso reprocessar esses 6 PDFs — 6 documentos,');
    console.log('  custo desprezível, mas é uma AÇÃO À PARTE que o usuário precisa pedir.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
