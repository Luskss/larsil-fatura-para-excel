/**
 * _medir/_por-que-sem-itens.js — por que `extrairItens` devolve vazio nesta nota?
 *
 * Caso da NFS 886 (DALIANI): PDF clicável, 9 páginas, 7.794 caracteres de texto
 * nativo, e a linha do banco não tem `Itens` nem `Qtd. de itens`.
 *
 * `process-folder.js:724` roda `extrairNotaFiscal` em TODO documento, então o
 * extrator foi chamado — e voltou sem item. Este script chama as peças uma a uma
 * sobre o texto real para achar ONDE a extração para:
 *   - acha a âncora da tabela de itens?
 *   - acha NCM / CFOP / unidade, que é o que o extrator usa para reconhecer linha?
 *
 * Uso: node _medir/_por-que-sem-itens.js "trecho do nome"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');
const itens = require('../routes/_nf-itens');

const TRECHO = process.argv[2] || 'DALIANI';
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

(async () => {
    let abs = null;
    (function anda(d) {
        if (abs) return;
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { if (abs) return; const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (x.name.includes(TRECHO)) abs = q; }
    })(RAIZ_ARQ);
    if (!abs) { console.log('não achei:', TRECHO); process.exit(1); }
    console.log('arquivo:', path.basename(abs), '\n');

    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
    const res = await parser.getText();
    try { await parser.destroy(); } catch (_) {}
    const text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');

    // ── O que o extrator inteiro devolve ────────────────────────────────────
    const nf = itens.extrairNotaFiscal(text);
    console.log('extrairNotaFiscal:');
    console.log(`   emitente=${JSON.stringify(nf.nome)}`);
    console.log(`   cnpj=${JSON.stringify(nf.cnpj)}`);
    console.log(`   valorTotal=${nf.valorTotal}  (origem=${nf.origemTotal})`);
    console.log(`   chaveAcesso=${JSON.stringify(nf.chaveAcesso)}`);
    console.log(`   cfop=${JSON.stringify(nf.cfop)}`);
    console.log(`   itens=${nf.itens.length}`);
    if (nf.itens.length) console.log(JSON.stringify(nf.itens, null, 2));

    // ── Os sinais que o extrator procura para reconhecer uma linha de item ──
    console.log('\nSINAIS NO TEXTO:');
    const ncm = text.match(itens.RE_NCM) || [];
    const cfop = text.match(itens.RE_CFOP) || [];
    console.log(`   NCM encontrados:  ${ncm.length}  ${JSON.stringify(ncm.slice(0, 8))}`);
    console.log(`   CFOP encontrados: ${cfop.length}  ${JSON.stringify(cfop.slice(0, 8))}`);
    const uni = new RegExp('\\b(' + itens.UNIDADES.join('|') + ')\\b', 'gi');
    const us = text.match(uni) || [];
    console.log(`   unidades:         ${us.length}  ${JSON.stringify([...new Set(us)].slice(0, 10))}`);

    // ── As âncoras de tabela que os layouts usam ────────────────────────────
    const ANCORAS = [
        'DADOS DOS PRODUTOS', 'DADOS DO PRODUTO', 'PRODUTOS/SERVI',
        'DISCRIMINA', 'DESCRI', 'SERVI', 'ITENS', 'VALOR UNIT', 'QUANT',
        'Informações Sobre o Serviço', 'Serviço Prestado',
    ];
    console.log('\nÂNCORAS DE TABELA presentes no texto:');
    const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const T = semAcento(text);
    for (const a of ANCORAS) {
        const i = T.indexOf(semAcento(a));
        console.log(`   ${i >= 0 ? '✓' : '·'} ${a.padEnd(30)} ${i >= 0 ? 'pos ' + i : ''}`);
    }

    // ── O trecho onde o serviço é descrito ──────────────────────────────────
    const i = T.indexOf(semAcento('Informações Sobre o Serviço'));
    if (i >= 0) {
        console.log('\nTRECHO DO SERVIÇO (700 chars a partir da âncora):');
        console.log(text.slice(i, i + 700));
    }
    process.exit(0);
})();
