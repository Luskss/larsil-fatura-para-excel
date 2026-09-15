/**
 * _medir/_tabela-vs-texto.js — `getTable` extrai mais retenção que `getText`?
 *
 * A inspeção mostrou que a tabela separa em CÉLULAS o que o texto plano funde:
 * na GENUSCLIN, `ISSQN 179,43` e `COFINS 179,43` ficam em células distintas, e a
 * colisão que causou o bug de §15.1 deixa de existir. Amostra não é medição — este
 * script roda os dois caminhos sobre TODAS as NFS-e de um mês e compara.
 *
 * A pergunta é dupla, e as duas metades importam:
 *   1. a tabela acha retenção onde o texto não achava? (ganho)
 *   2. a tabela PERDE alguma que o texto achava?      (regressão)
 *
 * O veredito não é "qual é melhor" e sim se vale trocar, ou somar as duas fontes.
 *
 * Uso: node _medir/_tabela-vs-texto.js [pasta]
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

async function textoPlano(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { return ((await pr.getText()).text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' '); }
    catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

/**
 * Serializa as tabelas do PDF num texto em que cada CÉLULA vira um par
 * "rótulo valor" isolado por separador. O parser existente roda sobre isso sem
 * mudança: a diferença é que rótulos de colunas distintas não ficam mais
 * adjacentes, então uma regex não atravessa de uma coluna para a vizinha.
 */
async function textoDeTabelas(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getTable();
        const paginas = (r && (r.pages || r.tables)) || [];
        const partes = [];
        for (const pg of (Array.isArray(paginas) ? paginas : [paginas])) {
            const tabs = pg.tables || pg || [];
            for (const t of (Array.isArray(tabs) ? tabs : [tabs])) {
                const rows = (t && (t.rows || t.data)) || t;
                if (!Array.isArray(rows)) continue;
                for (const row of rows) {
                    const cels = Array.isArray(row) ? row : (row.cells || row.values || []);
                    for (const c of cels) {
                        const v = (c && typeof c === 'object') ? (c.text ?? c.value ?? '') : c;
                        const s = String(v ?? '').replace(/\s+/g, ' ').trim();
                        // Cada célula fica cercada por " ; " — a fronteira que o
                        // texto plano não tem. Sem isso a serialização recriaria
                        // exatamente o problema que a tabela resolve.
                        if (s) partes.push(s);
                    }
                }
            }
        }
        return partes.length ? partes.join(' ; ') : null;
    } catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

(async () => {
    const { retencaoDoParser } = internasRota();
    const pdfs = listarPdfs(path.join(RAIZ_ARQ, PASTA));
    console.error(`[tabela-vs-texto] ${pdfs.length} PDFs em ${PASTA}...`);

    let nfse = 0;
    let soTexto = 0, soTabela = 0, ambos = 0, nenhum = 0, divergem = 0;
    const ganhos = [], perdas = [], conflitos = [];
    let i = 0;

    for (const abs of pdfs) {
        if (++i % 300 === 0) console.error(`  ${i}/${pdfs.length}`);
        const nome = path.basename(abs);
        const buf = fs.readFileSync(abs);

        const plano = await textoPlano(buf);
        if (!plano || plano.replace(/\s/g, '').length < 15) continue;
        let cls; try { cls = parsers.classify(plano, nome); } catch (e) { continue; }
        if (cls.tipo !== 'NFS' || !cls.parser) continue;
        nfse++;

        let rT = null, rB = null;
        try { rT = retencaoDoParser(cls.parser(plano)); } catch (e) {}
        const tab = await textoDeTabelas(buf);
        if (tab) { try { rB = retencaoDoParser(cls.parser(tab)); } catch (e) {} }

        if (rT && rB) {
            ambos++;
            // Concordam no valor retido? Se não, uma das duas está errada.
            if (Math.abs(rT.retido - rB.retido) > 0.02) {
                divergem++;
                if (conflitos.length < 10) conflitos.push({ nome, texto: rT, tabela: rB });
            }
        } else if (rT && !rB) { perdas.push({ nome, r: rT }); }
        else if (!rT && rB) { ganhos.push({ nome, r: rB }); }
        else nenhum++;
    }

    soTexto = perdas.length; soTabela = ganhos.length;
    console.log(`\nNFS-e analisadas: ${nfse}\n`);
    console.log(`  as DUAS acham retenção:      ${ambos}` + (divergem ? `   (${divergem} com valor DIFERENTE)` : '   (todas concordam)'));
    console.log(`  só o TEXTO acha:             ${soTexto}   ← a tabela perderia`);
    console.log(`  só a TABELA acha:            ${soTabela}   ← ganho da tabela`);
    console.log(`  nenhuma acha:                ${nenhum}\n`);
    console.log(`  total hoje (texto):          ${ambos + soTexto}`);
    console.log(`  total só com tabela:         ${ambos + soTabela}`);
    console.log(`  total SOMANDO as duas:       ${ambos + soTexto + soTabela}  ← usar as duas fontes`);

    if (ganhos.length) {
        console.log('\nGANHOS (a tabela acha, o texto não):');
        for (const g of ganhos.slice(0, 20))
            console.log(`  bruto ${g.r.bruto.toFixed(2).padStart(10)}  retido ${g.r.retido.toFixed(2).padStart(9)}  ` +
                `líq ${g.r.liquido.toFixed(2).padStart(10)}  ${g.nome.slice(0, 52)}`);
    }
    if (perdas.length) {
        console.log('\nPERDAS (o texto acha, a tabela não):');
        for (const p of perdas.slice(0, 20))
            console.log(`  bruto ${p.r.bruto.toFixed(2).padStart(10)}  retido ${p.r.retido.toFixed(2).padStart(9)}  ` +
                `líq ${p.r.liquido.toFixed(2).padStart(10)}  ${p.nome.slice(0, 52)}`);
    }
    if (conflitos.length) {
        console.log('\n*** CONFLITOS (valores diferentes — investigar):');
        for (const c of conflitos)
            console.log(`  ${c.nome.slice(0, 50)}\n     texto: ${JSON.stringify(c.texto)}\n     tabela: ${JSON.stringify(c.tabela)}`);
    }
    process.exit(0);
})();
