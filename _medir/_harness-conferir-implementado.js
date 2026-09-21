/**
 * _medir/_harness-conferir-implementado.js — o `ocr.js` editado faz o que medi?
 *
 * As variantes foram medidas com funções de simulação DENTRO dos scripts. Agora o
 * `_medir/ocr.js` foi editado de verdade. Este script chama o `indexar()` REAL e
 * confere contra o índice antigo (`.cache/ocr.json.antigo`, preservado de
 * propósito).
 *
 * Previsto para H: CURA 15, ESTRAGA 1, valorOK +15, força3 −1.
 *
 * Se não bater, o que implementei não é o que medi — foi exatamente assim que a
 * investigação de ontem descarrilou ([[trava-do-boleto-maior-barra-a-ld]]).
 *
 * SOMENTE LEITURA (só regenera o cache do índice).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const antigoPath = path.join(h.CACHE, 'ocr.json.antigo');
    if (!fs.existsSync(antigoPath)) {
        console.log('⚠ não achei .cache/ocr.json.antigo — sem referência para comparar.');
        process.exit(1);
    }
    const idxAntigo = JSON.parse(fs.readFileSync(antigoPath, 'utf8'));
    const idxNovo = await indexar();          // o REAL, recém-implementado

    console.log('═'.repeat(76));
    console.log('O ÍNDICE IMPLEMENTADO × O ANTIGO');
    console.log('═'.repeat(76));
    console.log(`\n   arquivos no índice antigo: ${Object.keys(idxAntigo).length}`);
    console.log(`   arquivos no índice novo:   ${Object.keys(idxNovo).length}`);

    const mudou = { numero: 0, cnpj: 0, emitente: 0, valor: 0, dtEmissao: 0 };
    for (const k of Object.keys(idxNovo)) {
        const a = idxAntigo[k] || {}, b = idxNovo[k] || {};
        for (const campo of Object.keys(mudou))
            if (String(a[campo] == null ? '' : a[campo]) !== String(b[campo] == null ? '' : b[campo])) mudou[campo]++;
    }
    console.log('\n   campos que mudaram:');
    for (const [c2, n] of Object.entries(mudou))
        console.log(`      ${c2.padEnd(12)} ${String(n).padStart(4)}  ${pct(n, Object.keys(idxNovo).length)}`);

    // ── A/B contra o valor lançado ─────────────────────────────────────────
    const c = h.carregar();
    function medir(idx) {
        const forca = { 1: 0, 2: 0, 3: 0 };
        const porLanc = new Map();
        let ok = 0, errado = 0, semValor = 0;
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
                const o = p.lancamentoDaPlanilha(l); o._id = `${periodo}#${i}`; return o;
            });
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                const f = x.forca || 0;
                if (forca[f] != null) forca[f]++;
                const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
                const e = idx[semPN(x.documento.arquivo)];
                const vIdx = e && e.valor != null ? e.valor : null;
                let estado;
                if (vIdx == null) { semValor++; estado = 'sem'; }
                else if (Math.abs(vIdx - vLanc) < 0.02) { ok++; estado = 'ok'; }
                else { errado++; estado = 'erro'; }
                porLanc.set(x.lancamento._id, { arq: x.documento.arquivo, forca: f, vLanc, vIdx, estado });
            }
        }
        return { forca, ok, errado, semValor, porLanc };
    }

    const A = medir(idxAntigo), N = medir(idxNovo);
    let cura = 0, estraga = 0;
    const exCura = [], exEstraga = [];
    for (const [id, a] of A.porLanc) {
        const n = N.porLanc.get(id); if (!n) continue;
        if (a.estado !== 'ok' && n.estado === 'ok') { cura++; if (exCura.length < 10) exCura.push({ a, n }); }
        if (a.estado === 'ok' && n.estado !== 'ok') { estraga++; exEstraga.push({ a, n }); }
    }

    console.log(`\n${'═'.repeat(76)}`);
    console.log('A/B CONTRA O VALOR LANÇADO');
    console.log('═'.repeat(76));
    const sinal = n => (n >= 0 ? '+' : '') + n;
    console.log(`\n   CURA:    ${cura}`);
    console.log(`   ESTRAGA: ${estraga}`);
    console.log(`   valorOK  ${sinal(N.ok - A.ok)}   errados ${sinal(N.errado - A.errado)}   semValor ${sinal(N.semValor - A.semValor)}`);
    console.log(`   força3 ${sinal(N.forca[3] - A.forca[3])}   força2 ${sinal(N.forca[2] - A.forca[2])}   força1 ${sinal(N.forca[1] - A.forca[1])}`);

    const bate = cura === 15 && estraga === 1 && (N.ok - A.ok) === 15;
    console.log(`\n   previsto (H): CURA 15, ESTRAGA 1, valorOK +15`);
    console.log(`   ${bate ? '✓ BATE com o medido' : '⚠ NÃO bate — investigar'}`);

    console.log('\n── os curados ──────────────────────────────────────────────');
    for (const e of exCura)
        console.log(`   ${brl(e.a.vLanc).padStart(15)}  ${e.a.vIdx == null ? '(sem)' : brl(e.a.vIdx)} → ${brl(e.n.vIdx)}   ${e.n.arq.slice(0, 40)}`);
    if (exEstraga.length) {
        console.log('\n── o(s) estragado(s) ───────────────────────────────────────');
        for (const e of exEstraga)
            console.log(`   ${brl(e.a.vLanc).padStart(15)}  ${brl(e.a.vIdx)} → ${e.n.vIdx == null ? '(sem)' : brl(e.n.vIdx)}   ${e.n.arq.slice(0, 40)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
