/**
 * _medir/_limiar-imagem.js — onde está o vale entre "é imagem" e "tem texto"?
 *
 * `_origem-vazia.js` achou 252 linhas do banco que caíram numa FENDA do pipeline:
 * PDFs com 16 a 32 caracteres de texto. O limiar de `process-folder.js:234` é
 *
 *     const isImage = text.replace(/\s/g, '').length < 15;
 *
 * então 16 caracteres significa "tem texto": a visão não é acionada, nenhum parser
 * acha nada, e a linha é gravada com tipo "Não identificado" e origem "—". 252
 * documentos (4% do banco), 225 deles com valor no nome — dinheiro conferível que
 * o sistema não lê.
 *
 * Mas NÃO se troca um limiar por palpite. A pergunta é empírica: como os PDFs do
 * acervo se distribuem por quantidade de texto? Se houver duas populações com um
 * vale vazio entre elas, o limiar vai no vale — foi assim que
 * `DIAS_DISCORDANCIA_GROSSA = 60` foi escolhido em `_pareamento.js`, e é o mesmo
 * método aqui.
 *
 * O RISCO do limiar alto: PDF com pouco texto MAS legítimo (um recibo de duas
 * linhas) passaria a ser tratado como imagem e gastaria chamada de visão sem
 * precisar. Por isso o script conta também quantos documentos MUDARIAM de lado a
 * cada limiar candidato, e mostra exemplos de cada faixa para conferência humana.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_limiar-imagem.js [pasta]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const SUB = process.argv[2] || '2026.03.EXTRATOS CONTABILIDADE';
const LIMIAR_HOJE = 15;

function listar(dir, out = []) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}

async function medir(abs) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getText();
        // MESMA normalização de `extractText`: remove o marcador de página do
        // pdf-parse 2.x antes de contar, senão "-- 1 of 2 --" infla a contagem e
        // um PDF-imagem de 2 páginas parece ter 14 caracteres de conteúdo.
        const txt = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        return { n: txt.replace(/\s/g, '').length, txt, paginas: r.total || 1 };
    } catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

const FAIXAS = [0, 1, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000, 5000, Infinity];
const CANDIDATOS = [15, 20, 25, 30, 40, 50, 75, 100];

(async () => {
    const dir = path.join(RAIZ_ARQ, SUB);
    const todos = listar(dir);
    console.log(`pasta: ${SUB}`);
    console.log(`PDFs: ${todos.length}\n`);

    const hist = new Map();
    const porFaixa = {};
    const amostras = {};
    let lidos = 0, falhas = 0;

    for (const abs of todos) {
        const m = await medir(abs);
        if (!m) { falhas++; continue; }
        lidos++;
        hist.set(m.n, (hist.get(m.n) || 0) + 1);
        for (let i = 0; i < FAIXAS.length - 1; i++) {
            if (m.n >= FAIXAS[i] && m.n < FAIXAS[i + 1]) {
                const k = `${FAIXAS[i]}-${FAIXAS[i + 1] === Infinity ? '∞' : FAIXAS[i + 1] - 1}`;
                porFaixa[k] = (porFaixa[k] || 0) + 1;
                if (!amostras[k]) amostras[k] = [];
                if (amostras[k].length < 3) {
                    // O tipo que o classify daria: é o que decide se a linha vira
                    // "Não identificado" no banco.
                    const c = parsers.classify(m.txt, path.basename(abs));
                    amostras[k].push({ nome: path.basename(abs), n: m.n, tipo: c.tipo, pg: m.paginas });
                }
                break;
            }
        }
        if (lidos % 200 === 0) console.error(`  ... ${lidos}/${todos.length}`);
    }

    console.log(`lidos: ${lidos}   falhas: ${falhas}\n`);

    console.log('DISTRIBUIÇÃO por caracteres de texto (sem espaços)');
    console.log('faixa            docs    ');
    for (let i = 0; i < FAIXAS.length - 1; i++) {
        const k = `${FAIXAS[i]}-${FAIXAS[i + 1] === Infinity ? '∞' : FAIXAS[i + 1] - 1}`;
        const v = porFaixa[k] || 0;
        const barra = '█'.repeat(Math.min(50, Math.round(v / Math.max(1, lidos) * 200)));
        const marca = (FAIXAS[i] < LIMIAR_HOJE && FAIXAS[i + 1] > LIMIAR_HOJE) ? '  ← limiar de hoje (15)' : '';
        console.log(k.padEnd(14) + String(v).padStart(6) + '  ' + barra + marca);
    }

    // ── o detalhe da zona crítica: 0 a 120, de 5 em 5 ───────────────────────
    console.log('\nZONA CRÍTICA (0-120 caracteres, de 5 em 5)');
    for (let lo = 0; lo < 120; lo += 5) {
        let v = 0;
        for (const [n, c] of hist) if (n >= lo && n < lo + 5) v += c;
        if (!v) { console.log(`${String(lo).padStart(3)}-${String(lo + 4).padStart(3)}        0`); continue; }
        console.log(`${String(lo).padStart(3)}-${String(lo + 4).padStart(3)}  ${String(v).padStart(6)}  ` + '█'.repeat(Math.min(60, v)));
    }

    // ── quanto cada limiar candidato MOVERIA ────────────────────────────────
    console.log('\nQUANTO CADA LIMIAR MOVERIA (docs que passariam a ser tratados como IMAGEM)');
    console.log('limiar   imagem   a mais que hoje   % do acervo');
    const conta = lim => [...hist.entries()].filter(([n]) => n < lim).reduce((s, [, c]) => s + c, 0);
    const hoje = conta(LIMIAR_HOJE);
    for (const lim of CANDIDATOS) {
        const c = conta(lim);
        console.log(String(lim).padStart(6) + String(c).padStart(9) +
            String(c - hoje).padStart(18) + ((c - hoje) / lidos * 100).toFixed(1).padStart(12) + '%');
    }

    console.log('\nAMOSTRAS por faixa (o `tipo` é o que o classify daria hoje)');
    for (const k of Object.keys(amostras).sort((a, b) => parseInt(a) - parseInt(b))) {
        if (parseInt(k) > 300) break;
        console.log(`\n  faixa ${k}:`);
        for (const a of amostras[k])
            console.log(`    ${String(a.n).padStart(5)} chars  ${a.pg}pg  ${String(a.tipo).slice(0, 18).padEnd(19)} ${a.nome.slice(0, 52)}`);
    }

    console.log('\nO limiar deve cair num VALE da distribuição, não num pico —');
    console.log('mesmo método de DIAS_DISCORDANCIA_GROSSA em _pareamento.js.');
    process.exit(0);
})();
