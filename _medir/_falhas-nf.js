/**
 * _medir/_falhas-nf.js — mostra o TEXTO CRU em volta dos campos que falharam,
 * para a regex ser escrita a partir do que o PDF realmente traz, e não do que a
 * gente imagina que ele traz.
 *
 * Uso: node _medir/_falhas-nf.js [campo] [quantosCasos]
 *      campo = total | chave | cfop | nome | unidade
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

// mostra as linhas do texto que contêm o padrão, com contexto
function trechos(text, re, quantos = 4) {
    const linhas = text.split('\n');
    const out = [];
    for (let i = 0; i < linhas.length && out.length < quantos; i++) {
        if (re.test(norm(linhas[i]))) {
            out.push(linhas.slice(Math.max(0, i - 1), i + 2)
                .map(l => '      | ' + l.replace(/\s+/g, ' ').trim().slice(0, 110)).join('\n'));
        }
    }
    return out;
}

const CAMPOS = {
    total:   { falhou: nf => nf.valorTotal == null, sonda: /TOTAL/ },
    chave:   { falhou: nf => !nf.chaveAcesso,       sonda: /CHAVE|ACESSO/ },
    cfop:    { falhou: nf => !nf.cfop,              sonda: /CFOP|NATUREZA/ },
    nome:    { falhou: nf => !nf.nome,              sonda: /EMITENTE|RECEBEMOS|RAZAO/ },
    itens:   { falhou: nf => !nf.itens.length,      sonda: /PRODUTO|NCM|DESCRICAO/ },
};

(async () => {
    const campo = process.argv[2] || 'total';
    const quantos = Number(process.argv[3] || 5);
    const spec = CAMPOS[campo];
    if (!spec) { console.log('campos: ' + Object.keys(CAMPOS).join(', ')); process.exit(1); }

    const todos = [];
    varrer(RAIZ, todos);
    let vistos = 0, achados = 0;

    for (const p of todos) {
        if (achados >= quantos || vistos >= 400) break;
        let text = '';
        try { text = (await new PDFParse({ data: fs.readFileSync(p) }).getText()).text || ''; }
        catch (_) { continue; }
        if (classify(text, path.basename(p)).tipo !== 'NF') continue;
        vistos++;
        const nf = extrairNotaFiscal(text);
        if (!spec.falhou(nf)) continue;
        achados++;
        console.log(`\n${'─'.repeat(100)}\n${path.basename(p)}   [${campo} vazio]`);
        const t = trechos(text, spec.sonda);
        if (!t.length) console.log('      (nenhuma linha com a sonda — o PDF não traz o rótulo)');
        else console.log(t.join('\n      ---\n'));
    }
    console.log(`\n\n${achados} falhas mostradas de ${vistos} DANFEs lidos.`);
})();
