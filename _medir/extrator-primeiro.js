/**
 * _medir/extrator-primeiro.js — a inversão custa pares? quais?
 *
 * A medição agregada diz −1 par e +0,3pp de 2º campo. O usuário pediu: se houver
 * perda, reverter. Mas "−1 par" pode esconder trocas (N perdidos, N-1 ganhos), que
 * é coisa diferente de uma perda líquida de 1 caso bom.
 *
 * Este script compara par a par: quantos se perdem, quantos se ganham, quantos
 * trocam de documento — e imprime cada um para conferência.
 */
'use strict';
const h = require('./harness');
const v = require('./variantes');
const ocrMod = require('./ocr');

(async () => {
    const c = h.carregar();
    const idx = await ocrMod.indexar();
    const OPT = { ocr: true, minDigitosNum: 1 };

    const base = v.rodar(c, idx, OPT);
    const nova = v.rodar(c, idx, { ...OPT, ocrPrimeiro: true });

    const mapa = linhas => {
        const m = new Map();
        for (const L of linhas)
            for (const p of (L.pares || []))
                m.set(`${L.periodo}|${p.lancamento.nf}|${p.lancamento.entidade}|${p.lancamento.valor}`,
                      p.documento.arquivo);
        return m;
    };
    const mb = mapa(base), mn = mapa(nova);

    const ganhos = [], perdas = [], trocas = [];
    for (const [k, arq] of mn) {
        if (!mb.has(k)) ganhos.push(`${k}\n     ${arq}`);
        else if (mb.get(k) !== arq) trocas.push(`${k}\n     ${mb.get(k)}\n  -> ${arq}`);
    }
    for (const [k, arq] of mb) if (!mn.has(k)) perdas.push(`${k}\n     ${arq}`);

    const sb = v.resumir(base), sn = v.resumir(nova);
    const qb = v.qualidade(base), qn = v.qualidade(nova);

    console.log('=== NOME PRIMEIRO  ×  EXTRATOR PRIMEIRO ===\n');
    console.log(`  pares      ${sb.conferidos}  →  ${sn.conferidos}   (${sn.conferidos - sb.conferidos >= 0 ? '+' : ''}${sn.conferidos - sb.conferidos})`);
    console.log(`  2º campo   ${(qb.pcConfirmado * 100).toFixed(2)}%  →  ${(qn.pcConfirmado * 100).toFixed(2)}%` +
        `   (${((qn.pcConfirmado - qb.pcConfirmado) * 100) >= 0 ? '+' : ''}${((qn.pcConfirmado - qb.pcConfirmado) * 100).toFixed(2)}pp)`);
    console.log(`  contraditos ${qb.contraditos}  →  ${qn.contraditos}`);
    console.log(`  fracos      ${sb.fracos}  →  ${sn.fracos}`);

    console.log(`\n  par a par:  ${ganhos.length} ganhos, ${perdas.length} perdas, ${trocas.length} trocas`);

    if (perdas.length) { console.log('\n  PERDAS:'); console.log('  ' + perdas.join('\n  ')); }
    if (ganhos.length) { console.log('\n  GANHOS:'); console.log('  ' + ganhos.slice(0, 15).join('\n  ')); }
    if (trocas.length) { console.log('\n  TROCAS:'); console.log('  ' + trocas.slice(0, 15).join('\n  ')); }

    console.log('\n── por período ──');
    for (const p of h.PERIODOS) {
        const lb = base.find(x => x.periodo === p), ln = nova.find(x => x.periodo === p);
        console.log(`  ${p}   ${lb.conferidos}/${lb.semDocumento}  →  ${ln.conferidos}/${ln.semDocumento}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
