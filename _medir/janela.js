/**
 * _medir/janela.js — até onde vale ampliar a vizinhança de pastas?
 *
 * A auditoria de 03/2026 (auditar-marco.js) achou 4 documentos da MAQNELSON
 * arquivados em JUNHO para lançamento de março (+3) e 3 em agosto (+5) — fora da
 * janela [-1,+1,+2] que a produção usa.
 *
 * Critério de aceitação (o mesmo de §10, §12 e §13): a variante só passa se a
 * cobertura subir SEM derrubar a confirmação por 2º campo. Cobertura comprada com
 * par errado é rejeitada.
 */
'use strict';
const h = require('./harness');
const ocr = require('./ocr');
const v = require('./variantes');

const VARIANTES = [
    ['produção  [-1,+1,+2]',        [-1, 1, 2]],
    ['+3        [-1,+1..+3]',       [-1, 1, 2, 3]],
    ['+4        [-1,+1..+4]',       [-1, 1, 2, 3, 4]],
    ['+5        [-1,+1..+5]',       [-1, 1, 2, 3, 4, 5]],
    ['+6        [-1,+1..+6]',       [-1, 1, 2, 3, 4, 5, 6]],
    ['-2,+3     [-2,-1,+1..+3]',    [-2, -1, 1, 2, 3]],
];

(async () => {
    const c = h.carregar();
    const idx = await ocr.indexar();

    const resultados = [];
    for (const [nome, vizinhanca] of VARIANTES) {
        const linhas = v.rodar(c, idx, { ocr: true, minDigitosNum: 2, vizinhanca });
        resultados.push({ nome, vizinhanca, s: v.resumir(linhas), q: v.qualidade(linhas), linhas });
    }

    const base = resultados[0];
    console.log('Critério: cobertura sobe E 2º campo não cai.\n');
    console.log('variante                       confer   cob%   semDoc  2ºcampo  contrad  fracos   Δ');
    for (const r of resultados) {
        const d = r.s.conferidos - base.s.conferidos;
        const dq = (r.q.pcConfirmado - base.q.pcConfirmado) * 100;
        console.log(
            `${r.nome.padEnd(30)} ${String(r.s.conferidos).padStart(5)}` +
            ` ${(r.s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(r.s.semDocumento).padStart(7)}` +
            ` ${(r.q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(r.q.contraditos).padStart(7)}` +
            ` ${String(r.s.fracos).padStart(6)}` +
            `  ${d >= 0 ? '+' : ''}${d} pares, 2ºcampo ${dq >= 0 ? '+' : ''}${dq.toFixed(1)}pp`);
    }

    // Ganho marginal de cada offset — onde o retorno morre.
    console.log('\n── ganho marginal por offset adicional ──');
    for (let i = 1; i < 5; i++) {
        const d = resultados[i].s.conferidos - resultados[i - 1].s.conferidos;
        const dq = (resultados[i].q.pcConfirmado - resultados[i - 1].q.pcConfirmado) * 100;
        console.log(`  +${i + 2}: ${d >= 0 ? '+' : ''}${d} pares, 2º campo ${dq >= 0 ? '+' : ''}${dq.toFixed(2)}pp`);
    }

    console.log('\n── por período (conferidos / semDoc) ──');
    console.log('período   ' + resultados.map(r => r.nome.split(' ')[0].padStart(12)).join(''));
    for (const p of h.PERIODOS) {
        const cels = resultados.map(r => {
            const l = r.linhas.find(x => x.periodo === p);
            return `${l.conferidos}/${l.semDocumento}`.padStart(12);
        });
        console.log(`${p}  ${cels.join('')}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
