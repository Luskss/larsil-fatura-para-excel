/**
 * _medir/_previa-releitura-03.js — o que a releitura de 03.2026 vai mudar.
 *
 * Roda ANTES de gravar. Para cada PDF da pasta de março, compara o que está HOJE
 * no banco com o que os parsers atuais produziriam — em particular os campos de
 * retenção que `parseNfse` passou a extrair (§15 do PROGRESSO).
 *
 * Não grava nada. Serve para o número de "vai mudar N linhas" ser conhecido antes
 * de tocar o banco, e para conferir depois se a gravação fez o que prometeu.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA_MES = '2026.03.EXTRATOS CONTABILIDADE';

// As internas da rota, para usar a MESMA `retencaoDoParser` que a conferência usa.
function internasRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname',
        `${src.slice(0, corte)} return { retencaoDoParser };`);
    return f(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

async function texto(abs) {
    let pr;
    try {
        pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
        const r = await pr.getText();
        return (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    } catch (e) { return null; }
    finally { try { if (pr) await pr.destroy(); } catch (_) {} }
}

function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(p, out);
        else if (/\.pdf$/i.test(e.name)) out.push(p);
    }
    return out;
}

(async () => {
    const { retencaoDoParser } = internasRota();
    const raizMes = path.join(RAIZ_ARQ, PASTA_MES);
    if (!fs.existsSync(raizMes)) { console.error('pasta não encontrada:', raizMes); process.exit(1); }

    const pdfs = listarPdfs(raizMes);
    console.log(`PDFs em ${PASTA_MES}: ${pdfs.length}\n`);

    let lidos = 0, imagem = 0, falhou = 0;
    const porTipo = {};
    let nfse = 0, comRetencao = 0;
    const exemplos = [];

    for (const abs of pdfs) {
        const nome = path.basename(abs);
        const tx = await texto(abs);
        if (tx == null) { falhou++; continue; }
        if (tx.replace(/\s/g, '').length < 15) { imagem++; continue; }
        lidos++;

        let cls;
        try { cls = parsers.classify(tx, nome); } catch (e) { continue; }
        porTipo[cls.tipo] = (porTipo[cls.tipo] || 0) + 1;
        if (cls.tipo !== 'NFS') continue;
        nfse++;

        let campos;
        try { campos = cls.parser ? cls.parser(tx) : null; } catch (e) { continue; }
        if (!campos) continue;
        const r = retencaoDoParser(campos);
        if (r) {
            comRetencao++;
            if (exemplos.length < 25) exemplos.push({ nome, ...r });
        }
    }

    console.log(`texto lido: ${lidos}   imagem (só OCR): ${imagem}   falhou: ${falhou}\n`);
    console.log('por tipo classificado:');
    for (const [t, n] of Object.entries(porTipo).sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(n).padStart(5)}  ${t}`);

    console.log(`\nNFS-e: ${nfse}`);
    console.log(`com RETENÇÃO conferida (bruto − impostos = líquido): ${comRetencao}`);
    console.log(`  → são estas as linhas que a releitura vai enriquecer.\n`);

    if (exemplos.length) {
        console.log('EXEMPLOS:');
        for (const e of exemplos)
            console.log(`  bruto ${e.bruto.toFixed(2).padStart(10)}  retido ${e.retido.toFixed(2).padStart(9)}  ` +
                `líquido ${e.liquido.toFixed(2).padStart(10)}   ${e.nome.slice(0, 62)}`);
    }
    process.exit(0);
})();
