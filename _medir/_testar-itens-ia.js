/**
 * _medir/_testar-itens-ia.js — a IA acha os itens que o extrator local não acha?
 *
 * Diagnóstico do caso NFS 886 (DALIANI): `extrairItens` exige NCM em duas travas
 * (`_nf-itens.js:489` e `:513`). NCM é código de MERCADORIA; NFS-e é de SERVIÇO e
 * não traz NCM. Medido em 542 NFS com texto nativo: o extrator local gravou itens em
 * **0**, e as 67 que têm vieram todas da IA — a maioria com NCM vazio.
 *
 * Falta a prova positiva: a IA, neste documento, LÊ os itens? Se não ler, reprocessar
 * com `forceAI` não resolve e a recomendação seria outra.
 *
 * Não grava nada — só chama a leitura por IA e mostra o que ela devolve.
 *
 * Uso: node _medir/_testar-itens-ia.js "trecho do nome"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');
const full = require('../routes/_nf-ai-full');

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
    const nome = path.basename(abs);
    console.log('arquivo:', nome, '\n');

    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
    const res = await parser.getText();
    try { await parser.destroy(); } catch (_) {}
    const text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
    const nPag = res.total || 1;

    // Assinatura por OBJETO nomeado, não posicional: `extrairNotaAI({ text, filename, pages })`.
    const r = await full.extrairNotaAI({ text, filename: nome, pages: nPag });
    if (r.error) console.log('ERRO:', r.error);
    console.log('\nRESPOSTA DA IA:');
    console.log(`   tipo=${JSON.stringify(r?.tipo)}  numero=${JSON.stringify(r?.numero)}`);
    console.log(`   emitente=${JSON.stringify(r?.emitente)}`);
    console.log(`   valorTotal=${JSON.stringify(r?.valorTotal)}`);
    console.log(`   dataEmissao=${JSON.stringify(r?.dataEmissao)}`);
    console.log(`   itens: ${r?.itens?.length || 0}`);
    for (const it of (r?.itens || []))
        console.log(`      ${JSON.stringify(it)}`);
    process.exit(0);
})();
