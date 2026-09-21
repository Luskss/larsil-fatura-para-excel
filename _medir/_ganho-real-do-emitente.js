/**
 * _medir/_ganho-real-do-emitente.js — dos 117 candidatos, quantos PARES aparecem?
 *
 * `_vale-reescanear.js` mostrou 117 documentos que mudam de emitente e hoje NÃO
 * pareiam. Isso é TETO, não ganho ([[dimensionar-o-pool-antes-de-medir]]): um
 * documento pode não parear por falta de lançamento correspondente, por valor que
 * não bate, por mês fora da janela — o emitente sujo pode não ser a causa.
 *
 * ── Como medir sem reescanear ───────────────────────────────────────────────
 * `_pareamento.js` NÃO chama `extrairEmitente`: o emitente chega pelo índice de
 * OCR, que lê o que está GRAVADO no banco. Então dá para simular a releitura
 * injetando o emitente NOVO no índice e rodando o motor real — exatamente a
 * técnica de [[o-script-de-efeito-mentia]], mas com o cuidado de comparar
 * listas de pares, não contagens.
 *
 * ⚠️ Cuidado que já me custou uma rodada hoje: comparar CONTAGEM esconde troca.
 * Aqui comparo os CONJUNTOS de pares (chave lançamento→documento) e reporto
 * ganhos e perdas separadamente.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const LIXO = /^[\d\-.,\/\s]{2,}/;

function extrairDe(src) {
    const corte = src.indexOf('module.exports');
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    return new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return extrairEmitente;
    `)(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

(async () => {
    const A = extrairDe(execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const D = extrairDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8'));

    const c = h.carregar();
    const idxOcr = await indexar();

    // índice com o emitente NOVO onde o conserto muda. Só mexe no campo `emitente`,
    // que é o que a releitura mudaria — o resto da linha fica igual.
    const idxNovo = {};
    let injetados = 0;
    for (const [arq, info] of Object.entries(idxOcr)) idxNovo[arq] = { ...info };
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {})) {
        for (const a of arqs) {
            const va = A(a.nome), vd = D(a.nome);
            if (va === vd || !(va && LIXO.test(va))) continue;
            // o process-folder grava `Emitente` = nome do arquivo limpo; o índice lê
            // esse campo. Injetamos o valor novo.
            idxNovo[a.nome] = { ...(idxNovo[a.nome] || {}), emitente: vd || undefined };
            injetados++;
        }
    }
    console.log(`emitentes injetados no índice simulado: ${injetados}\n`);

    const rodar = (idx) => {
        const pares = new Map();     // "lanc" → arquivo
        let total = 0;
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
                const o = p.lancamentoDaPlanilha(l);
                o._k = `${periodo}|${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
                return o;
            });
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                total++;
                pares.set(x.lancamento._k, x.documento.arquivo);
            }
        }
        return { pares, total };
    };

    const antes = rodar(idxOcr);
    const depois = rodar(idxNovo);

    // conjuntos, não contagens
    let ganhos = 0, perdas = 0, trocas = 0;
    const exG = [], exP = [], exT = [];
    for (const [k, arq] of depois.pares) {
        if (!antes.pares.has(k)) { ganhos++; if (exG.length < 12) exG.push([k, arq]); }
        else if (antes.pares.get(k) !== arq) { trocas++; if (exT.length < 8) exT.push([k, antes.pares.get(k), arq]); }
    }
    for (const [k, arq] of antes.pares)
        if (!depois.pares.has(k)) { perdas++; if (exP.length < 12) exP.push([k, arq]); }

    console.log('── o motor real, com o emitente corrigido ───────────────────');
    console.log(`  pares ANTES:  ${antes.total}`);
    console.log(`  pares DEPOIS: ${depois.total}`);
    console.log(`\n  GANHOS (lançamento que não tinha par): ${ganhos}`);
    console.log(`  PERDAS (tinha par e perdeu):           ${perdas}`);
    console.log(`  trocas (mesmo lançamento, outro doc):  ${trocas}`);
    console.log(`\n  LÍQUIDO: ${ganhos - perdas >= 0 ? '+' : ''}${ganhos - perdas}`);

    if (exG.length) {
        console.log('\n  os ganhos:');
        for (const [k, arq] of exG) console.log(`    ${k.slice(0, 52)}\n       → ${arq.slice(0, 56)}`);
    }
    if (exP.length) {
        console.log('\n  ⚠ as PERDAS:');
        for (const [k, arq] of exP) console.log(`    ${k.slice(0, 52)}\n       perdeu ${arq.slice(0, 52)}`);
    }
    if (exT.length) {
        console.log('\n  as trocas:');
        for (const [k, a, d] of exT) console.log(`    ${k.slice(0, 46)}\n       ${String(a).slice(0, 44)}\n    →  ${String(d).slice(0, 44)}`);
    }

    console.log('\nLEITURA: este é o ganho que o reescaneamento entregaria NO PAREAMENTO.');
    console.log('Se for ~0, o conserto do emitente vale pela TELA e pelos documentos');
    console.log('futuros, não por pares novos — e reescanear 4.541 PDFs não se paga.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
