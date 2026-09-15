/**
 * _medir/_alt-quebra-de-linha.js — e se NÃO colapsarmos as quebras de linha?
 *
 * Todas as leituras até aqui rodam sobre `norm()`, que faz `\s+ → ' '` e transforma
 * o documento numa fita única. É ISSO que cria a colisão de coluna: `ISSQN 179,43`
 * e `COFINS 179,43` viram vizinhos indistinguíveis, e uma regex atravessa de um
 * campo para o outro sem obstáculo.
 *
 * `getTable` (geometria) foi testado e REPROVADO — §15.6: não vê layout sem bordas.
 * Mas há uma alternativa mais simples que ninguém testou: o texto do PDF JÁ TEM
 * quebras de linha, e `norm` as destrói. Preservá-las como fronteira dá parte do
 * layout de volta SEM biblioteca nova, sem geometria e sem custo.
 *
 * Hipótese: casar rótulo→valor DENTRO da linha, e nunca atravessando linhas, acha
 * o mesmo ou mais, e erra menos.
 *
 * Compara três leituras sobre as mesmas NFS-e:
 *   (a) fita         — `norm` atual, `\s+ → ' '`
 *   (b) por linha    — quebras preservadas, regex não cruza a fronteira
 *   (c) as duas      — (b) primeiro, (a) como reserva
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = process.argv[2] || '2026.03.EXTRATOS CONTABILIDADE';

function internasRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname',
        `${src.slice(0, corte)} return { retencaoDoParser };`);
    return f(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(p, out);
        else if (/\.pdf$/i.test(e.name)) out.push(p);
    }
    return out;
}

async function texto(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { return ((await pr.getText()).text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' '); }
    catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

/**
 * Reagrupa RÓTULO + VALOR que o PDF emite em linhas ALTERNADAS.
 *
 * Inspecionando a GENUSCLIN (`scratchpad/ver-linhas.js`), o texto vem assim:
 *
 *     107: [ISSQN]     108: [179,43]
 *     109: [ISSRF]     110: [0,00]
 *     111: [IR]        112: [89,72]
 *     117: [COFINS]    118: [179,43]
 *
 * Ou seja: o PDF JÁ ENTREGA o pareamento correto, e `norm()` (que faz `\s+ → ' '`)
 * o destrói ao concatenar tudo numa fita — é aí que `ISSQN 179,43` passa a poder
 * ser confundido com `COFINS 179,43`.
 *
 * Isolar as linhas (a primeira ideia) seria PIOR: separaria o rótulo do seu valor.
 * O certo é o oposto — COLAR cada rótulo ao valor da linha seguinte, e separar
 * esses pares entre si. Assim o par fica explícito e nenhuma regex atravessa para
 * o campo vizinho.
 */
const SO_VALOR = /^R?\$?\s*[\d.]{0,12}\d,\d{2}$/;
const SO_ROTULO = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\/()%-]{1,44}:?$/;

function porLinha(t) {
    const L = String(t || '').split(/\r?\n/).map(l => l.replace(/[ \t]+/g, ' ').trim());
    const out = [];
    for (let i = 0; i < L.length; i++) {
        const a = L[i];
        if (!a) continue;
        const b = L[i + 1];
        // Rótulo sozinho seguido de valor sozinho: junta os dois e consome ambos.
        if (b && SO_ROTULO.test(a) && SO_VALOR.test(b)) {
            out.push(`${a.replace(/:$/, '')} ${b}`);
            i++;
            continue;
        }
        out.push(a);
    }
    // " ; " entre pares: barreira que as regex do parser (que usam `[:\s]*`) não
    // cruzam, já que `;` não é espaço.
    return out.join(' ; ');
}

(async () => {
    const { retencaoDoParser } = internasRota();
    const pdfs = listarPdfs(path.join(RAIZ_ARQ, PASTA));
    console.error(`[alt] ${pdfs.length} PDFs...`);

    let nfse = 0, ambas = 0, soFita = 0, soLinha = 0, nenhuma = 0, divergem = 0;
    const ganhos = [], perdas = [], conflitos = [];
    let i = 0;

    for (const abs of pdfs) {
        if (++i % 400 === 0) console.error(`  ${i}/${pdfs.length}`);
        const nome = path.basename(abs);
        const t = await texto(fs.readFileSync(abs));
        if (!t || t.replace(/\s/g, '').length < 15) continue;
        let cls; try { cls = parsers.classify(t, nome); } catch (e) { continue; }
        if (cls.tipo !== 'NFS' || !cls.parser) continue;
        nfse++;

        let rA = null, rB = null;
        try { rA = retencaoDoParser(cls.parser(t)); } catch (e) {}
        try { rB = retencaoDoParser(cls.parser(porLinha(t))); } catch (e) {}

        if (rA && rB) {
            ambas++;
            if (Math.abs(rA.retido - rB.retido) > 0.02) {
                divergem++;
                if (conflitos.length < 12) conflitos.push({ nome, fita: rA, linha: rB });
            }
        } else if (rA && !rB) { perdas.push({ nome, r: rA }); }
        else if (!rA && rB) { ganhos.push({ nome, r: rB }); }
        else nenhuma++;
    }

    soFita = perdas.length; soLinha = ganhos.length;
    console.log(`\nNFS-e analisadas: ${nfse}\n`);
    console.log(`  as duas acham:        ${ambas}` + (divergem ? `   (${divergem} DIVERGEM no valor)` : '   (todas concordam)'));
    console.log(`  só a FITA acha:       ${soFita}   ← por linha perderia`);
    console.log(`  só POR LINHA acha:    ${soLinha}   ← ganho`);
    console.log(`  nenhuma:              ${nenhuma}\n`);
    console.log(`  total hoje (fita):    ${ambas + soFita}`);
    console.log(`  total por linha:      ${ambas + soLinha}`);
    console.log(`  total com as duas:    ${ambas + soFita + soLinha}`);

    if (ganhos.length) {
        console.log('\nGANHOS (por linha acha, fita não):');
        for (const g of ganhos.slice(0, 15))
            console.log(`  bruto ${g.r.bruto.toFixed(2).padStart(10)} retido ${g.r.retido.toFixed(2).padStart(9)} ` +
                `líq ${g.r.liquido.toFixed(2).padStart(10)}  ${g.nome.slice(0, 50)}`);
    }
    if (perdas.length) {
        console.log('\nPERDAS (fita acha, por linha não):');
        for (const p of perdas.slice(0, 15))
            console.log(`  bruto ${p.r.bruto.toFixed(2).padStart(10)} retido ${p.r.retido.toFixed(2).padStart(9)} ` +
                `líq ${p.r.liquido.toFixed(2).padStart(10)}  ${p.nome.slice(0, 50)}`);
    }
    if (conflitos.length) {
        // O caso mais informativo: as duas acham, com valores DIFERENTES. Uma está
        // errada, e saber qual diz se a fronteira de linha ajuda ou atrapalha.
        console.log('\n*** DIVERGÊNCIAS (as duas acham valores diferentes):');
        for (const c of conflitos)
            console.log(`  ${c.nome.slice(0, 52)}\n     fita:  ${JSON.stringify(c.fita)}\n     linha: ${JSON.stringify(c.linha)}`);
    }
    process.exit(0);
})();
