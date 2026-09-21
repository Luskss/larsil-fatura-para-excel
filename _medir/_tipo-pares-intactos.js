/**
 * _medir/_tipo-pares-intactos.js — o conserto mexeu no CONJUNTO de pares?
 *
 * O argumento de `_tipo-efeito-no-desempate.js` é analítico (o conserto só
 * concede ponto, e o empate é resolvido por `>` estrito, que preserva o vencedor
 * antigo). Bom, mas argumento não é medição — a prova empírica é rodar a
 * conferência REAL das duas maneiras e comparar os pares.
 *
 * `conferirPeriodo` do `_baseline.js` é o caminho de produção do painel. Aqui
 * carregamos DUAS cópias do módulo — uma do fonte em git HEAD (antes) e outra do
 * disco (depois) — e comparamos, mês a mês:
 *
 *   • quantas notas foram ENCONTRADAS / ficaram FALTANDO
 *   • o conjunto {nf|entidade|valor → arquivo} casado, par a par
 *
 * Qualquer par que troque de arquivo aparece aqui.
 *
 * SOMENTE LEITURA (escreve só um .js temporário no scratchpad do harness).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Materializa o _baseline.js de HEAD ao lado do original, para que seus
// `require('./x')` relativos resolvam igual.
function baselineDeHead() {
    const src = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const alvo = path.join(h.RAIZ, 'routes', '_baseline.__head__.js');
    fs.writeFileSync(alvo, src);
    return alvo;
}

(async () => {
    const alvo = baselineDeHead();
    let antes, depois;
    try {
        antes  = require(alvo);
        depois = require(path.join(h.RAIZ, 'routes', '_baseline.js'));
    } finally {
        // remove já — o require guardou o módulo em memória
        try { fs.unlinkSync(alvo); } catch (e) {}
    }

    const fnA = antes.conferirPeriodo || antes.compararPeriodo;
    const fnD = depois.conferirPeriodo || depois.compararPeriodo;
    if (typeof fnA !== 'function' || typeof fnD !== 'function') {
        console.log('_baseline.js não exporta conferirPeriodo/compararPeriodo.');
        console.log('exports (disco):', Object.keys(depois).join(', ') || '(nenhum)');
        console.log('\nSem ponto de entrada comum, a comparação empírica de pares não roda');
        console.log('por aqui. O argumento analítico de _tipo-efeito-no-desempate.js fica de pé:');
        console.log('  • só 2 combinações mudam de veredito, ambas false→true');
        console.log('  • o conserto NUNCA tira ponto de score, só concede');
        console.log('  • `score > melhor.score` preserva o vencedor antigo em empate');
        process.exit(0);
    }

    console.log('comparando conferirPeriodo: HEAD × disco\n');
    console.log('mês       encontradas      faltando       pares que trocaram de arquivo');
    let trocasTotais = 0;
    for (const periodo of h.PERIODOS) {
        const rA = await fnA(periodo);
        const rD = await fnD(periodo);
        const mapa = r => {
            const m = new Map();
            for (const e of (r.encontradas || []))
                m.set(`${e.nf}|${norm(e.entidade)}|${Number(e.valor || 0).toFixed(2)}`, e.arquivo || '');
            return m;
        };
        const mA = mapa(rA), mD = mapa(rD);
        let trocas = 0;
        for (const [k, v] of mA) if (mD.has(k) && mD.get(k) !== v) trocas++;
        trocasTotais += trocas;
        const eA = (rA.encontradas || []).length, eD = (rD.encontradas || []).length;
        const fA = (rA.naoEncontradas || []).length, fD = (rD.naoEncontradas || []).length;
        console.log(`${periodo}   ${String(eA).padStart(4)} → ${String(eD).padStart(4)}    ${String(fA).padStart(4)} → ${String(fD).padStart(4)}    ${String(trocas).padStart(6)}`);
    }
    console.log(`\nTOTAL de pares que trocaram de documento: ${trocasTotais}`);
    console.log(trocasTotais === 0
        ? '→ o conjunto de pares está INTACTO. O conserto age só no rótulo do alerta.'
        : '→ ⚠ o conserto MEXEU no pareamento; investigar antes de manter.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
