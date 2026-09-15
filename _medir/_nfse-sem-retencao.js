/**
 * _medir/_nfse-sem-retencao.js — as 88 NFS-e que NÃO fecham a conta são o quê?
 *
 * A prévia de 03.2026 achou 98 NFS-e e só 10 com retenção conferida. Duas leituras
 * possíveis, e elas pedem ações opostas:
 *
 *   (a) a nota não TEM retenção (o serviço não é tributado na fonte, ou o
 *       município não exige) — então 10 está certo e não há nada a fazer;
 *   (b) a nota TEM retenção mas o parser não leu — e aí a regra está deixando
 *       divergência falsa na tela, que é o problema que ela existe para resolver.
 *
 * Distinguir importa: em (b) o usuário continua vendo nota certa marcada como erro.
 *
 * Classifica cada NFS-e sem retenção conferida pelo que o TEXTO mostra, sem
 * adivinhar: tem vocabulário de retenção? leu bruto? leu líquido? bruto == líquido
 * (nota sem retenção nenhuma, que é resposta legítima)?
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA_MES = '2026.03.EXTRATOS CONTABILIDADE';

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
const num = s => {
    if (s == null || s === '—') return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
};

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

// Vocabulário que indica retenção DECLARADA no papel.
const RE_DECLARA = /ISS\s*RETIDO|ISSRF|RETENCAO NA FONTE|RETIDO NA FONTE|TRIBUTADA INTEGRALMENTE COM RETENCAO|IRRF|RETENCOES|VALOR LIQUIDO/;
// "ISS retido: NÃO" / "Retido na fonte: Não" — a nota diz explicitamente que NÃO há.
const RE_NEGA = /ISS\s*RETIDO[:\s]*NAO|RETIDO NA FONTE[:\s]*NAO|SEM RETENCAO|NAO RETIDO/;

(async () => {
    const { retencaoDoParser } = internasRota();
    const raizMes = path.join(RAIZ_ARQ, PASTA_MES);
    const pdfs = listarPdfs(raizMes);

    const classe = {};
    const exemplos = { suspeitos: [], semBruto: [], semLiquido: [], iguais: [] };
    let nfse = 0, comRetencao = 0;

    for (const abs of pdfs) {
        const nome = path.basename(abs);
        const tx = await texto(abs);
        if (!tx || tx.replace(/\s/g, '').length < 15) continue;
        let cls;
        try { cls = parsers.classify(tx, nome); } catch (e) { continue; }
        if (cls.tipo !== 'NFS' || !cls.parser) continue;
        nfse++;

        let campos;
        try { campos = cls.parser(tx); } catch (e) { continue; }
        if (retencaoDoParser(campos)) { comRetencao++; continue; }

        const t = norm(tx);
        const bruto = num(campos['Valor do serviço']);
        const liq = num(campos['Valor líquido']);
        const retidos = ['ISS retido', 'IRRF retido', 'INSS retido', 'CSLL retido', 'COFINS retido', 'PIS retido']
            .map(k => num(campos[k])).filter(v => v != null);
        const declara = RE_DECLARA.test(t);
        const nega = RE_NEGA.test(t);

        let rot;
        if (bruto != null && liq != null && Math.abs(bruto - liq) <= 0.02) {
            rot = 'bruto == líquido (nota SEM retenção) — correto';
            if (exemplos.iguais.length < 5) exemplos.iguais.push({ nome, bruto, liq });
        } else if (nega) {
            rot = 'papel diz NÃO retido — correto';
        } else if (!declara) {
            rot = 'sem vocabulário de retenção — provavelmente não tem';
        } else if (bruto == null && liq == null) {
            rot = 'declara retenção mas NÃO leu bruto nem líquido';
            if (exemplos.suspeitos.length < 12) exemplos.suspeitos.push({ nome, retidos });
        } else if (bruto == null) {
            rot = 'declara, leu líquido, FALTA o bruto';
            if (exemplos.semBruto.length < 12) exemplos.semBruto.push({ nome, liq, retidos });
        } else if (liq == null) {
            rot = 'declara, leu bruto, FALTA o líquido';
            if (exemplos.semLiquido.length < 12) exemplos.semLiquido.push({ nome, bruto, retidos });
        } else {
            rot = 'leu os dois mas a conta NÃO fecha';
            if (exemplos.suspeitos.length < 12) exemplos.suspeitos.push({ nome, bruto, liq, retidos });
        }
        classe[rot] = (classe[rot] || 0) + 1;
    }

    console.log(`NFS-e em ${PASTA_MES}: ${nfse}`);
    console.log(`com retenção conferida: ${comRetencao}`);
    console.log(`sem retenção conferida: ${nfse - comRetencao}\n`);
    console.log('POR QUE não fecharam:');
    for (const [k, n] of Object.entries(classe).sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(n).padStart(4)}  ${k}`);

    const most = (t, arr, f) => { if (!arr.length) return; console.log(`\n${t}`); for (const e of arr) console.log('  ' + f(e)); };
    most('leu os dois mas não fecha / não leu nada:', exemplos.suspeitos,
        e => `${String(e.nome).slice(0, 62).padEnd(62)} bruto=${e.bruto ?? '—'} liq=${e.liq ?? '—'} ret=[${e.retidos}]`);
    most('declara, tem líquido, falta bruto:', exemplos.semBruto,
        e => `${String(e.nome).slice(0, 62).padEnd(62)} liq=${e.liq} ret=[${e.retidos}]`);
    most('declara, tem bruto, falta líquido:', exemplos.semLiquido,
        e => `${String(e.nome).slice(0, 62).padEnd(62)} bruto=${e.bruto} ret=[${e.retidos}]`);
    most('bruto == líquido (sem retenção, correto):', exemplos.iguais,
        e => `${String(e.nome).slice(0, 62).padEnd(62)} ${e.bruto}`);
    process.exit(0);
})();
