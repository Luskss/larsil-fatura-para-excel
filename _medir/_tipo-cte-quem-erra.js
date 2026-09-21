/**
 * _medir/_tipo-cte-quem-erra.js — em NF→CTE, quem está errado?
 *
 * A ANATOMIA (21/09/2026) mostrou algo que contradiz meu rótulo de "falso":
 * dos 10 alertas NF→CTE, metade tem evidência FORTE e correta lida do papel —
 * `CT-E`, `DACTE`, `MDF-E`, via `conteúdo`, não via IA:
 *
 *     RODONAVES. NF 325062 + BOL    evid="CT-E"    via=conteúdo
 *     JB PRESTACAO. NF 282 + BOL    evid="DACTE"   via=conteúdo
 *     CADORE. NF 986513 + BOL       evid="MDF-E"   via=conteúdo
 *
 * E o acervo inteiro só tem 15 documentos CTE, nenhum com "CT-e" no nome.
 *
 * Eu chamei esses 10 de "falsos" porque a minha testemunha (`tipoDoNome`) lê "NF"
 * no nome e concorda com a planilha. Mas o arquivista escreve "NF" como sinônimo
 * genérico de *nota*, e o transportador emite CT-e. Se o PAPEL diz DACTE, quem
 * diverge é a planilha — e o alerta PROCEDE.
 *
 * Régua frouxa inventa erro ([[gabarito-frouxo-inventa-erro]]); aqui ela pode estar
 * inventando um ACERTO do outro lado, condenando o classificador que acertou.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Para cada documento CTE do acervo, a evidência é FORTE (marcador canônico lido
 * do papel) ou FRACA/IA? E o emitente é transportadora?
 *
 * evidência forte + emitente transportador → o classificador ACERTOU; o alerta
 * procede e NÃO deve ser silenciado.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// marcadores canônicos de CT-e: só aparecem num conhecimento de transporte
const FORTE_CTE = /\bDACTE\b|\bCT-?E\b|\bMDF-?E\b|CONHECIMENTO DE TRANSPORTE|DOCUMENTO AUXILIAR DO CONHECIMENTO|TRANSPORTE RODOVIARIO DE CARGAS/;
const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|TRANSPORTE DE CARGA|\bRODONAVES\b|PRINCESA DOS CAMPOS/;

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    const ctes = Object.entries(idx).filter(([, i]) => i.tipo === 'CTE');
    console.log(`documentos classificados CTE no acervo: ${ctes.length}\n`);

    let forte = 0, fraco = 0, transp = 0;
    console.log('evid.  via              transportador?  arquivo');
    for (const [arq, i] of ctes) {
        const ev = String(i.evidencia || '');
        const ehForte = FORTE_CTE.test(norm(ev));
        // o emitente pode estar na evidência ("IA: RODONAVES...") ou no nome
        const ehTransp = TRANSPORTADOR.test(norm(ev)) || TRANSPORTADOR.test(norm(arq));
        if (ehForte) forte++; else fraco++;
        if (ehTransp) transp++;
        console.log(`  ${ehForte ? 'FORTE' : 'fraca'}  ${String(i.origem || '—').padEnd(16)} ${(ehTransp ? 'sim' : 'não').padEnd(14)} ${arq.slice(0, 46)}`);
        if (!ehForte) console.log(`         evidência: "${ev.slice(0, 56)}"`);
    }

    console.log(`\n  evidência FORTE (marcador canônico do papel): ${forte}  ${pct(forte, ctes.length)}`);
    console.log(`  evidência fraca / IA:                        ${fraco}  ${pct(fraco, ctes.length)}`);
    console.log(`  emitente é transportadora:                   ${transp}  ${pct(transp, ctes.length)}`);

    console.log('\n── VEREDITO ────────────────────────────────────────────────');
    if (forte >= ctes.length * 0.5 && transp >= ctes.length * 0.5) {
        console.log('  A classificação CTE está CERTA na maioria: marcador canônico lido do');
        console.log('  papel + emitente transportador. Quem diverge é a PLANILHA, que lança');
        console.log('  o frete como "NOTA FISCAL RFB".');
        console.log('\n  → o alerta NF→CTE PROCEDE. Silenciá-lo seria esconder uma divergência');
        console.log('    real de classificação contábil. NÃO consertar.');
        console.log('\n  → e a minha régua (`tipoDoNome`) é que erra aqui: o arquivista escreve');
        console.log('    "NF" como sinônimo de nota, não como tipo fiscal. Os 10 "falsos"');
        console.log('    NF→CTE são na verdade PROCEDENTES.');
    } else {
        console.log('  A classificação CTE é frágil — vale investigar caso a caso.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
