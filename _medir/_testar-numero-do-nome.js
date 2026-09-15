/**
 * _medir/_testar-numero-do-nome.js — a regex do número do nome está certa?
 *
 * `numeroDoNomeArquivo` é a entrada da âncora: se ela extrair o número errado, a
 * âncora procura a coisa errada no texto. Compara com `numeroDoNome` do
 * `_pareamento.js` (que o acervo já usa há meses) sobre os nomes REAIS do banco.
 *
 * Divergir não é necessariamente erro — as duas têm propósitos diferentes — mas cada
 * divergência precisa ser explicável.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const pare = require('../routes/_pareamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

// A função não é exportada — extrai do fonte, como o harness faz com a rota.
const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
const m = src.match(/const RE_NUM_NOME =[\s\S]*?\n\}/);
if (!m) { console.log('não achei numeroDoNomeArquivo no fonte'); process.exit(1); }
const numeroDoNomeArquivo = new Function(`${m[0]}; return numeroDoNomeArquivo;`)();

const CASOS = [
    ['070.DOC- 72,57 - 2026.03.10. DALIANI CRISTINI. NFS 886 + AUT.pdf', '886'],
    ['075.DOC- 125,00-2026.01.12.BIOS NET . FT 242502.pdf', '242502'],
    ['058.DOC- 75,00 - 2026.02.10. BIOSNET. FT 245612.pdf', '245612'],
    ['010.DOC- 689,80-2026.05.04.TESTEFER . NF 11283+ AUT.pdf', '11283'],
    ['045.DOC- 2500,00 - 2026.03.15. SAVANA. NFS 37594 + B.pdf', '37594'],
    ['024.DOC- 21508,13-2026.01.16.THR . FT825432+ AUT.pdf', '825432'],
    ['013.DOC- 14570,60 - 2026.05.06. DUDRONE. NFS 77 + AU.pdf', '77'],
    ['003.DOC- 453,49 - 2026.07.01. ELEKTRO. FAT 508.pdf', '508'],
    // sem número de documento no nome
    ['161.DOC- 505251,46 pgto FOLHA - LARSIL.pdf', null],
    ['004.DOC- 13998,04 pgto PRESTADORES SERVIÇO - MEI - LARSIL.pdf', null],
];

let ok = 0, falhou = 0;
console.log('CASOS CONHECIDOS\n');
for (const [nome, esperado] of CASOS) {
    const real = numeroDoNomeArquivo(nome);
    const bate = real === esperado;
    if (bate) ok++; else falhou++;
    console.log(`   ${bate ? '✓' : '✗'}  ${String(real).padStart(9)}  (esperado ${String(esperado).padStart(9)})  ${nome.slice(0, 46)}`);
}
console.log(`\n   ${ok} passaram, ${falhou} falharam`);

(async () => {
    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    const nomes = new Set();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO))
            nomes.add(path.basename(String(x.arquivo).replace(/#p\d+$/, '')));

    let iguais = 0, soNovo = 0, soAntigo = 0, difs = 0, nenhum = 0;
    const exDif = [], exSoNovo = [];
    for (const n of nomes) {
        const novo = numeroDoNomeArquivo(n);
        const antigo = pare.numeroDoNome(n);
        const a = antigo == null ? null : String(antigo).replace(/\D/g, '');
        if (novo == null && a == null) { nenhum++; continue; }
        if (novo != null && a != null) {
            if (novo === a || novo.includes(a) || a.includes(novo)) iguais++;
            else { difs++; if (exDif.length < 10) exDif.push({ n, novo, a }); }
        } else if (novo != null) { soNovo++; if (exSoNovo.length < 8) exSoNovo.push({ n, novo }); }
        else soAntigo++;
    }
    console.log(`\nSOBRE OS ${nomes.size} NOMES DO ACERVO`);
    console.log(`   concordam:              ${iguais}`);
    console.log(`   só o NOVO acha:         ${soNovo}`);
    console.log(`   só o ANTIGO acha:       ${soAntigo}`);
    console.log(`   DIVERGEM:               ${difs}`);
    console.log(`   nenhum acha:            ${nenhum}`);

    if (exDif.length) {
        console.log('\n   divergências (novo × pareamento):');
        for (const e of exDif)
            console.log(`      ${String(e.novo).padStart(9)} × ${String(e.a).padStart(9)}  ${e.n.slice(0, 44)}`);
    }
    if (exSoNovo.length) {
        console.log('\n   só o novo acha:');
        for (const e of exSoNovo)
            console.log(`      ${String(e.novo).padStart(9)}  ${e.n.slice(0, 50)}`);
    }
    process.exit(falhou ? 1 : 0);
})();
