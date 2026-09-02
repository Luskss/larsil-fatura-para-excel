/**
 * _medir/comparar.js — roda as variantes lado a lado contra o baseline.
 *
 * Regra da medição: cobertura sozinha não decide nada. Uma variante só é melhor
 * se subir a cobertura SEM piorar a confirmação por 2º campo, e sem aumentar os
 * pares contraditos pelo CNPJ.
 */
'use strict';
const h = require('./harness');
const ocr = require('./ocr');
const v = require('./variantes');

const VARIANTES = [
    ['baseline (produção)',            { ocr: false }],
    ['+ OCR (em produção hoje)',       { ocr: true }],
    ['+ OCR, número ≥2 dígitos',       { ocr: true, minDigitosNum: 2 }],
    ['+ OCR, número ≥1 dígito',        { ocr: true, minDigitosNum: 1 }],
    ['+ OCR, nº≥1, vizinhança larga',  { ocr: true, minDigitosNum: 1, vizinhanca: [-3, -2, -1, 1, 2, 3, 4] }],
];

(async () => {
    const c = h.carregar();
    const idx = await ocr.indexar();

    const linhaCnpj = (c.planilha['03.2026'] || { itens: [] }).itens.filter(i => i.cnpj).length;
    const totCnpj = (c.planilha['03.2026'] || { itens: [] }).itens.length;
    console.log(`CNPJ na planilha (03.2026): ${linhaCnpj}/${totCnpj} lançamentos\n`);

    const resultados = [];
    for (const [nome, opt] of VARIANTES) {
        const t0 = Date.now();
        const linhas = v.rodar(c, idx, opt);
        const s = v.resumir(linhas);
        const q = v.qualidade(linhas);
        resultados.push({ nome, opt, s, q, linhas, ms: Date.now() - t0 });
    }

    const base = resultados[0];
    console.log('variante                             confer   cob%   semDoc  2ºcampo  contrad  fracos');
    for (const r of resultados) {
        const d = r.s.conferidos - base.s.conferidos;
        const marca = r === base ? '' : (d > 0 ? ` (+${d})` : ` (${d})`);
        console.log(
            `${r.nome.padEnd(36)} ${String(r.s.conferidos).padStart(5)}` +
            ` ${(r.s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(r.s.semDocumento).padStart(7)}` +
            ` ${(r.q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(r.q.contraditos).padStart(7)}` +
            ` ${String(r.s.fracos).padStart(6)}` + marca);
    }

    console.log('\n── por via de casamento ──');
    for (const r of resultados) {
        const vias = Object.entries(r.s.porVia).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${k}=${n}`).join('  ');
        console.log(`${r.nome}\n   ${vias}`);
    }

    console.log('\n── 02.2026 (o mês da tela) ──');
    for (const r of resultados) {
        const l = r.linhas.find(x => x.periodo === '02.2026');
        console.log(`${r.nome.padEnd(36)} conferidos=${String(l.conferidos).padStart(3)}` +
            `  semDoc=${String(l.semDocumento).padStart(3)}` +
            `  docsSemLanc=${String(l.docsSemLancamento).padStart(3)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
