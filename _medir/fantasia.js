/**
 * _medir/fantasia.js — a coluna FANTASIA resolve os casos do grupo (b)?
 *
 * A auditoria de 03/2026 achou lançamentos cujo documento está na pasta com valor
 * E número idênticos, mas arquivado sob OUTRO nome: KUHNEN E CHAVES como
 * "TORNEARIA", V M CARNEIRO como "VERIDYANA", C & F como "CEF".
 *
 * `lancamentoDaPlanilha` já junta os tokens de FANTASIA aos de ENTIDADE. Este
 * script pergunta: a coluna está preenchida? e quando está, ela traz o nome que o
 * arquivista de fato escreveu?
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();

    // ── 1. Preenchimento da coluna ──────────────────────────────────────────
    console.log('=== COBERTURA DA COLUNA FANTASIA ===\n');
    let totGeral = 0, comFant = 0, fantIgual = 0, fantDifer = 0;
    for (const p of h.PERIODOS) {
        const itens = (c.planilha[p] || { itens: [] }).itens || [];
        let n = 0, f = 0;
        for (const i of itens) {
            n++;
            const fant = String(i.fantasia || '').trim();
            if (fant) {
                f++;
                const ent = String(i.entidade || '').trim();
                if (fant.toUpperCase() === ent.toUpperCase()) fantIgual++; else fantDifer++;
            }
        }
        totGeral += n; comFant += f;
        console.log(`${p}  ${String(n).padStart(4)} lançamentos, ${String(f).padStart(4)} com FANTASIA (${(f / n * 100).toFixed(1)}%)`);
    }
    console.log(`\nTOTAL ${totGeral} lançamentos, ${comFant} com FANTASIA (${(comFant / totGeral * 100).toFixed(1)}%)`);
    console.log(`  FANTASIA idêntica à ENTIDADE ... ${fantIgual}  (não acrescenta sinal)`);
    console.log(`  FANTASIA diferente ............. ${fantDifer}  (acrescenta sinal)`);

    // ── 2. Amostra de fantasias que acrescentam algo ─────────────────────────
    console.log('\n=== AMOSTRA: entidade × fantasia distintas ===\n');
    const vistos = new Set();
    let mostrados = 0;
    for (const p of h.PERIODOS) {
        for (const i of (c.planilha[p] || { itens: [] }).itens || []) {
            const fant = String(i.fantasia || '').trim();
            const ent = String(i.entidade || '').trim();
            if (!fant || fant.toUpperCase() === ent.toUpperCase()) continue;
            const k = ent + '|' + fant;
            if (vistos.has(k)) continue;
            vistos.add(k);
            if (mostrados++ < 30) console.log(`  ${ent.slice(0, 45).padEnd(45)} → ${fant}`);
        }
    }
    console.log(`  ... ${vistos.size} pares distintos no total`);

    // ── 3. Os casos concretos do grupo (b) ──────────────────────────────────
    console.log('\n=== OS CASOS DA AUDITORIA DE MARÇO ===\n');
    const ALVOS = [
        ['KUHNEN', '12040'], ['KUHNEN', '12027'], ['CARNEIRO', '1639'],
        ['C & F', '11027'], ['C D B', '30581'], ['RAQUIEL', '313'],
        ['MAQNELSON', '226713'],
    ];
    const itens = (c.planilha['03.2026'] || { itens: [] }).itens || [];
    for (const [nome, nf] of ALVOS) {
        const achado = itens.find(i =>
            String(i.entidade || '').toUpperCase().includes(nome.toUpperCase()) &&
            String(i.nf || '').replace(/\D/g, '') === nf.replace(/\D/g, ''));
        if (!achado) { console.log(`  ${nome} NF ${nf}: não achei na planilha`); continue; }
        const l = par.lancamentoDaPlanilha(achado);
        console.log(`  ${achado.entidade}`);
        console.log(`     NF ${achado.nf} · R$ ${achado.valor}`);
        console.log(`     FANTASIA: ${achado.fantasia ? `"${achado.fantasia}"` : '(VAZIA)'}`);
        console.log(`     tokens do lançamento: ${[...l.tokens].join(', ') || '(nenhum)'}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
