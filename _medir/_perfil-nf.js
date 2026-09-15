/**
 * _medir/_perfil-nf.js — a cobertura baixa de chave/itens é falha do extrator,
 * ou a amostra tem documentos que legitimamente não têm esses campos?
 *
 * `classify` marca como 'NF' tudo que traz "DANFE" ou "NATUREZA DA OPERACAO" —
 * o que inclui NFS-e (serviço: sem NCM, sem chave de 44 díg) e contratos com
 * DANFE citada. Cobrar chave de acesso de uma nota de serviço é cobrar um campo
 * que não existe. Este script separa a amostra por SUBTIPO e mede cada um contra
 * o que aquele subtipo de fato carrega.
 *
 * Uso: node _medir/_perfil-nf.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('../node_modules/pdf-parse');
const { classify, norm } = require('../routes/_nf-parsers');
const { extrairNotaFiscal } = require('../routes/_nf-itens');

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

// Subtipo pelo que o documento realmente é — não pelo rótulo grosso do classify.
function subtipo(t) {
    if (/\bDANFE\b|DOCUMENTO AUXILIAR DA NOTA FISCAL/.test(t)) return 'DANFE (produto)';
    if (/NFS-?E|NOTA FISCAL DE SERVICO|DANFSE|TOMADOR DO SERVICO/.test(t)) return 'NFS-e (serviço)';
    if (/\bCONTRATO\b|CEDULA DE CREDITO|ARRENDAMENTO/.test(t)) return 'contrato/financeiro';
    return 'outro (NATUREZA DA OPERACAO solta)';
}

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');

(async () => {
    const limite = Number(process.argv[2] || 120);
    const todos = [];
    varrer(RAIZ, todos);
    const grupos = new Map();
    let lidos = 0;

    for (const p of todos) {
        if (lidos >= limite) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        const base = path.basename(p);
        if (classify(text, base).tipo !== 'NF') continue;
        lidos++;
        const t = norm(text);
        const st = subtipo(t);
        if (!grupos.has(st)) grupos.set(st, { n: 0, chave: 0, itens: 0, total: 0, cfop: 0, nome: 0, social: 0, cnpj: 0, temNcm: 0, temChaveNoTexto: 0 });
        const g = grupos.get(st);
        g.n++;
        const nf = extrairNotaFiscal(text);
        if (nf.chaveAcesso) g.chave++;
        if (nf.itens.length) g.itens++;
        if (nf.valorTotal != null) g.total++;
        if (nf.cfop) g.cfop++;
        if (nf.nome) g.nome++;
        if (nf.nomeSocial) g.social++;
        if (nf.cnpj) g.cnpj++;
        // o campo EXISTE fisicamente no documento?
        if (/(?<![\d.,])\d{8}(?![\d.,])/.test(text)) g.temNcm++;
        if (/(?:\d[\s]*){44}/.test(text)) g.temChaveNoTexto++;
    }

    console.log(`${lidos} documentos classificados como 'NF'.\n`);
    for (const [st, g] of [...grupos.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`\n══ ${st} — ${g.n} documentos (${pct(g.n, lidos)} da amostra) ══`);
        console.log(`   nome              ${pct(g.nome, g.n).padStart(6)}      CNPJ    ${pct(g.cnpj, g.n).padStart(6)}`);
        console.log(`   nome social       ${pct(g.social, g.n).padStart(6)}      CFOP    ${pct(g.cfop, g.n).padStart(6)}`);
        console.log(`   valor total       ${pct(g.total, g.n).padStart(6)}`);
        console.log(`   chave extraída    ${pct(g.chave, g.n).padStart(6)}   de ${pct(g.temChaveNoTexto, g.n)} que têm 44 díg no texto`);
        console.log(`   itens extraídos   ${pct(g.itens, g.n).padStart(6)}   de ${pct(g.temNcm, g.n)} que têm algum campo de 8 díg`);
    }
})();
