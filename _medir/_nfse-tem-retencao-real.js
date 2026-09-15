/**
 * _medir/_nfse-tem-retencao-real.js — quantas das "não fechadas" têm imposto > 0?
 *
 * `_nfse-layouts.js` mostrou a amostra e a leitura foi: a maioria dessas notas
 * NÃO tem retenção — imprime os rótulos com valor 0,00 (EDSON SOUZA, CLINVIDA,
 * AGRO AIR: "TRIBUTOS FEDERAIS PIS 0,00 INSS 0,00 CSLL 0,00 IRRF 0,00"), ou nem é
 * NFS-e (SAVANA e FIDELITY são boletos, só têm VALOR DO DOCUMENTO).
 *
 * Amostra não é medição. Este script conta: em quantas existe ALGUM tributo com
 * valor MAIOR QUE ZERO no papel? Só essas podem ser retenção que o parser perde;
 * o resto é nota sem retenção, e o parser está certo em não achar nada.
 *
 * A distinção decide se vale escrever mais regex ou se o trabalho acabou.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA_MES = process.argv[2] || '2026.03.EXTRATOS CONTABILIDADE';

function internasRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname',
        `${src.slice(0, corte)} return { retencaoDoParser };`);
    return f(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

const norm = s => String(s || '').toUpperCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

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

// Qualquer tributo de retenção seguido de valor, com o valor capturado.
// Aceita os rótulos vistos na amostra, incluindo variações por município.
const TRIBUTOS = ['ISSRF', 'ISS RETIDO', 'VALOR ISS RETIDO', 'IRRF', 'IR',
                  'INSS', 'CSLL', 'COFINS', 'PIS', 'PIS/PASEP',
                  'OUTRAS RETENCOES', 'TOTAL TRIB\\.? FEDERAIS'];
const N = '([\\d.]{0,12}\\d,\\d{2})';
const val = s => { const n = Number(String(s).replace(/\./g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

(async () => {
    const { retencaoDoParser } = internasRota();
    const pdfs = listarPdfs(path.join(RAIZ_ARQ, PASTA_MES));

    let nfse = 0, fechadas = 0, semTributoPositivo = 0, comTributoPositivo = 0;
    const suspeitas = [];

    for (const abs of pdfs) {
        const nome = path.basename(abs);
        const tx = await texto(abs);
        if (!tx || tx.replace(/\s/g, '').length < 15) continue;
        let cls; try { cls = parsers.classify(tx, nome); } catch (e) { continue; }
        if (cls.tipo !== 'NFS' || !cls.parser) continue;
        nfse++;
        let campos; try { campos = cls.parser(tx); } catch (e) { continue; }
        if (retencaoDoParser(campos)) { fechadas++; continue; }

        const t = norm(tx);
        // Todos os valores de tributo que o papel mostra, em qualquer rótulo.
        const achados = {};
        for (const trib of TRIBUTOS) {
            const re = new RegExp(`\\b${trib}\\b[:\\s]*R?\\$?\\s*${N}`, 'g');
            let m;
            while ((m = re.exec(t)) !== null) {
                const v = val(m[1]);
                if (v > 0) achados[trib.replace('\\\\.?', '.')] = v;
            }
        }
        if (!Object.keys(achados).length) { semTributoPositivo++; continue; }
        comTributoPositivo++;
        if (suspeitas.length < 20) suspeitas.push({ nome, achados });
    }

    console.log(`NFS-e em ${PASTA_MES}: ${nfse}`);
    console.log(`  retenção conferida (conta fecha):        ${fechadas}`);
    console.log(`  sem NENHUM tributo > 0 no papel:         ${semTributoPositivo}  ← não tem retenção, parser correto`);
    console.log(`  COM algum tributo > 0 mas não fecha:     ${comTributoPositivo}  ← só estas podem ser perda real\n`);

    if (suspeitas.length) {
        console.log('AS QUE TÊM TRIBUTO > 0 E NÃO FECHAM:');
        for (const s of suspeitas)
            console.log(`  ${s.nome.slice(0, 60).padEnd(60)} ${JSON.stringify(s.achados)}`);
    } else {
        console.log('NENHUMA nota com tributo > 0 ficou de fora — o parser cobre o que existe.');
    }
    process.exit(0);
})();
