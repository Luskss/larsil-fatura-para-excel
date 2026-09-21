/**
 * _medir/_confirmar-injecao.js — o +0 é real ou eu medi o vazio?
 *
 * `_ganho-real-do-emitente.js` deu +0 ganhos, +0 perdas, +0 trocas. Zero absoluto
 * nos três é o padrão de quem mediu NADA — [[armadilha-medir-sem-ocr]] e
 * [[chave-do-parser-e-em-portugues]] são exatamente isso: ler a chave errada dá
 * zero, e zero parece resultado.
 *
 * Três verificações antes de acreditar:
 *   1. o campo que injetei (`emitente`) é mesmo o que `enriquecerComOcr` lê?
 *   2. o emitente chega aos TOKENS do documento (que é o que `casa()` compara)?
 *   3. um teste de CONTROLE: injetar lixo proposital derruba pares? Se nem o lixo
 *      move o número, o experimento não está tocando o motor.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    // ── 1) que campo enriquecerComOcr lê? ──────────────────────────────────
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_pareamento.js'), 'utf8');
    const m = src.match(/function enriquecerComOcr[\s\S]*?\n\}/);
    console.log('── (1) enriquecerComOcr, no fonte ───────────────────────────');
    console.log(m ? m[0].split(/\r?\n/).filter(l => /ocr\./.test(l)).map(l => '   ' + l.trim()).join('\n') : '(não achei)');

    // ── 2) o emitente injetado chega aos tokens? ───────────────────────────
    const c = h.carregar();
    const idxOcr = await indexar();
    const alvo = '031.DOC- 1320000,00-2026.01-19- MACPONTA.pdf';
    let achado = null;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) if (a.nome === alvo) achado = { mes, ...a };

    console.log('\n── (2) um documento concreto ────────────────────────────────');
    if (!achado) { console.log('   (não achei o arquivo de teste)'); }
    else {
        const semOcr = p.documentoDoArquivo(achado.nome, achado.rel);
        console.log(`   tokens SEM ocr:  ${[...semOcr.tokens].slice(0, 8).join(', ')}`);

        const comVelho = p.enriquecerComOcr(p.documentoDoArquivo(achado.nome, achado.rel), idxOcr[achado.nome]);
        console.log(`   tokens COM ocr (banco): ${[...comVelho.tokens].slice(0, 10).join(', ')}`);
        console.log(`   emitente no índice: "${(idxOcr[achado.nome] || {}).emitente || '(nenhum)'}"`);

        const comNovo = p.enriquecerComOcr(p.documentoDoArquivo(achado.nome, achado.rel),
            { ...(idxOcr[achado.nome] || {}), emitente: 'MACPONTA' });
        console.log(`   tokens COM emitente injetado: ${[...comNovo.tokens].slice(0, 10).join(', ')}`);
        const mudou = [...comNovo.tokens].join('|') !== [...comVelho.tokens].join('|');
        console.log(`   → a injeção MUDA os tokens? ${mudou ? 'SIM' : 'NÃO — e aí o +0 é artefato'}`);
    }

    // ── 3) controle: injetar lixo derruba pares? ───────────────────────────
    console.log('\n── (3) CONTROLE: injetar lixo proposital ────────────────────');
    const rodar = (transformar) => {
        let total = 0;
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo2 = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo2] = (c.pasta.arquivosPorMes[alvo2] || []).map(a => {
                    const info = transformar(a.nome, idxOcr[a.nome]);
                    return p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), info);
                });
            }
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            total += r.pares.length + r.paresVizinhos.length;
        }
        return total;
    };

    const normal = rodar((n, i) => i);
    const comLixo = rodar((n, i) => i ? { ...i, emitente: 'ZZZZ LIXO PROPOSITAL ' + n.slice(0, 4) } : i);
    const semEmit = rodar((n, i) => { if (!i) return i; const o = { ...i }; delete o.emitente; return o; });

    console.log(`   pares com índice normal:        ${normal}`);
    console.log(`   pares com emitente = LIXO:      ${comLixo}   (${comLixo - normal >= 0 ? '+' : ''}${comLixo - normal})`);
    console.log(`   pares SEM emitente nenhum:      ${semEmit}   (${semEmit - normal >= 0 ? '+' : ''}${semEmit - normal})`);

    console.log('\n── VEREDITO ─────────────────────────────────────────────────');
    if (comLixo === normal && semEmit === normal) {
        console.log('   Nem o lixo nem a ausência mudam o número: o campo `emitente` do');
        console.log('   índice NÃO influencia o pareamento neste acervo. O +0 é REAL,');
        console.log('   mas pelo motivo mais forte — o emitente do OCR não é o que casa.');
    } else {
        console.log('   O lixo/ausência MOVE o número, então o motor está sensível ao campo.');
        console.log('   Logo o +0 do conserto é resultado legítimo: os emitentes corrigidos');
        console.log('   não eram a causa da falta de par.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
