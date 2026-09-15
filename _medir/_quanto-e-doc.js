/**
 * _medir/_quanto-e-doc.js — quanto do acervo é "NNN.DOC" (o documento em si) e
 * quanto é CPV/extrato/anexo, que o comparador já ignora.
 *
 * A pergunta que isto responde: o scan lê TUDO (collectPdfs não filtra), mas o
 * comparador só olha "NNN.DOC-" (RE_DOC em comparar-notas.js). Então parte do
 * custo de processamento é gasto em arquivos que nunca serão comparados. Quanto?
 *
 * Uso: node _medir/_quanto-e-doc.js [raiz]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

// a MESMA regra de comparar-notas.js
const RE_DOC = /^\s*\d+\s*\.\s*DOC\b/i;
const ehDoc = nome => RE_DOC.test(String(nome || ''));

function varrer(dir, saida, prof = 0) {
    if (prof > 8) return;
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ent) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) varrer(p, saida, prof + 1);
        else if (/\.pdf$/i.test(e.name)) saida.push({ p, nome: e.name });
    }
}

// como o arquivo NÃO-DOC se chama: CPV, extrato do dia (000.pdf), outros
function categoria(nome) {
    const n = nome.toUpperCase();
    if (/^\s*\d+\s*\.\s*CPV\b/.test(n)) return 'CPV (comprovante de pagamento)';
    if (/^0+\s*\.?\s*PDF$/.test(n) || /^0+\./.test(n)) return 'extrato do dia (000.*)';
    if (/EXTRATO/.test(n)) return 'extrato (nome)';
    if (/^\s*\d+\s*\.\s*DOC\b/.test(n)) return 'DOC';
    return 'outro';
}

(async () => {
    const raiz = process.argv[2] || process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    console.log(`raiz: ${raiz}\n`);
    const todos = [];
    varrer(raiz, todos);

    const porCat = new Map();
    let docs = 0;
    for (const { nome } of todos) {
        const c = categoria(nome);
        porCat.set(c, (porCat.get(c) || 0) + 1);
        if (ehDoc(nome)) docs++;
    }

    const pct = n => `${(100 * n / todos.length).toFixed(1)}%`;
    console.log(`${todos.length} PDFs no total\n`);
    console.log('categoria                              PDFs      %');
    for (const [c, n] of [...porCat.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`  ${c.padEnd(36)} ${String(n).padStart(5)}  ${pct(n).padStart(6)}`);

    console.log(`\n→ passam no filtro do comparador (NNN.DOC): ${docs}  ${pct(docs)}`);
    console.log(`→ seriam PULADOS se collectPdfs filtrasse : ${todos.length - docs}  ${pct(todos.length - docs)}`);

    // amostra dos não-DOC, para conferir que a regra não descarta nota de verdade
    const naoDoc = todos.filter(t => !ehDoc(t.nome)).slice(0, 15);
    console.log('\n── amostra dos que NÃO são DOC (conferir se algum é nota) ──');
    for (const { nome } of naoDoc) console.log(`  ${nome.slice(0, 88)}`);
})();
