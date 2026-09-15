/**
 * _medir/_pipeline-nf.js — simula o que process-folder GRAVARIA em dados_parser
 * com o extrator fiscal ligado, sem tocar no banco.
 *
 * Verifica o que mais importa antes de um reprocessamento em massa: se algum
 * campo que o comparador JÁ usa ('Emitente', 'Nº da NF-e', 'Valor total da nota',
 * 'Chave de acesso') muda de valor. Campo novo é ganho; campo existente que muda
 * é risco, e precisa ser olhado caso a caso.
 *
 * Uso: node _medir/_pipeline-nf.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify, norm, extrairEmitente, extrairCnpj,
        enriquecerComChaveAcesso, enriquecerComBoleto } = require('../routes/_nf-parsers');
const { extrairNotaFiscal, camposParaDadosParser } = require('../routes/_nf-itens');

const env = {};
for (const linha of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
}
const RAIZ = env.ARQUIVO_PATH || env.MONITOR_PATH;

function varrer(dir, saida, prof = 0) {
    if (prof > 4) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push(p);
    }
}

// ANTES: exatamente o que o código fazia sem o extrator fiscal.
function antes(text, nome) {
    let pd = enriquecerComBoleto(enriquecerComChaveAcesso(
        classify(text, nome).parser ? classify(text, nome).parser(text) : null, text), text);
    if (pd && !Object.keys(pd).length) pd = null;
    const e = extrairEmitente(nome);
    if (e) { pd = pd || {}; pd['Emitente'] = e; }
    return pd || {};
}

// DEPOIS: com o extrator fiscal na frente e o emitente do arquivo como recuo.
function depois(text, nome) {
    let pd = enriquecerComBoleto(enriquecerComChaveAcesso(
        classify(text, nome).parser ? classify(text, nome).parser(text) : null, text), text);
    try {
        const novos = camposParaDadosParser(extrairNotaFiscal(text));
        if (Object.keys(novos).length) pd = { ...novos, ...(pd || {}) };
    } catch (_) {}
    if (pd && !Object.keys(pd).length) pd = null;
    const e = extrairEmitente(nome);
    if (e) {
        pd = pd || {};
        const lido = pd['Emitente'];
        if (lido && norm(lido) !== norm(e)) pd['Razão social (nota)'] = lido;
        pd['Emitente'] = e;
    }
    return pd || {};
}

const USADOS_PELO_COMPARADOR = ['Emitente', 'Nº da NF-e', 'Nº da NF-e (chave)',
    'Valor total da nota', 'Valor total', 'Chave de acesso', 'Data de emissão'];

(async () => {
    const quantos = Number(process.argv[2] || 200);
    const todos = [];
    varrer(RAIZ, todos);

    let lidos = 0;
    const novosCampos = new Map();
    const mudados = new Map();
    const exemplosMud = [];

    for (const p of todos) {
        if (lidos >= quantos) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        const base = path.basename(p);
        lidos++;
        const a = antes(text, base), b = depois(text, base);

        for (const k of Object.keys(b)) {
            const va = a[k], vb = b[k];
            const sa = va == null ? '' : JSON.stringify(va);
            const sb = vb == null ? '' : JSON.stringify(vb);
            if (sa === sb) continue;
            if (!sa) { novosCampos.set(k, (novosCampos.get(k) || 0) + 1); continue; }
            mudados.set(k, (mudados.get(k) || 0) + 1);
            if (USADOS_PELO_COMPARADOR.includes(k) && exemplosMud.length < 14) {
                exemplosMud.push({ base, k, de: String(va).slice(0, 44), para: String(vb).slice(0, 44) });
            }
        }
    }

    console.log(`${lidos} PDFs simulados.\n`);
    console.log('── campos NOVOS (antes vazios) ──');
    for (const [k, n] of [...novosCampos.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`  +${String(n).padStart(4)}  ${k}`);

    console.log('\n── campos que MUDARAM de valor ──');
    if (!mudados.size) console.log('  (nenhum)');
    for (const [k, n] of [...mudados.entries()].sort((a, b) => b[1] - a[1])) {
        const risco = USADOS_PELO_COMPARADOR.includes(k) ? '  ← USADO PELO COMPARADOR' : '';
        console.log(`   ${String(n).padStart(4)}  ${k}${risco}`);
    }

    if (exemplosMud.length) {
        console.log('\n── mudanças em campos que o comparador lê ──');
        for (const e of exemplosMud)
            console.log(`  ${e.base.slice(0, 40).padEnd(40)} ${e.k}\n      de:   ${e.de}\n      para: ${e.para}`);
    }
})();
