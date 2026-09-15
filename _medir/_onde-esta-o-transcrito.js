/**
 * _medir/_onde-esta-o-transcrito.js — "fora da pasta" é o quê, exatamente?
 *
 * `_transcricao-por-que-nao-pareia.js` disse que 38 dos 41 documentos transcritos
 * não estão na pasta varrida — e repetir com cache novo deu o MESMO número, então
 * não é cache velho. Antes de concluir qualquer coisa sobre a transcrição, é preciso
 * saber o que "fora da pasta" quer dizer:
 *
 *   (a) o arquivo não existe mais no disco          → linha órfã no relatório
 *   (b) existe, mas `contarNaPasta` o FILTRA        → nunca chega ao pareamento
 *   (c) o nome no relatório difere do nome no disco → casamento por nome falha
 *
 * (b) é o caso interessante: `contarNaPasta` aplica `ehDoc`/`categoriaNaoFiscal`, e
 * documento que não é "DOC" não entra na conferência por decisão de projeto. Se for
 * isso, a taxa de pareamento de 2% não mede a transcrição — mede o filtro.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

function classe(c) {
    c = String(c || '');
    if (/transcri/i.test(c)) return 'transcrição';
    if (/\(OCR\)/i.test(c))  return 'OCR';
    if (/^Imagem\s*$/i.test(c)) return 'imagem NÃO LIDA';
    return 'texto nativo';
}

(async () => {
    const rota = h.internasDaRota();
    const { pasta } = h.carregar();
    const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    const transcritos = [];
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO))
            if (classe(x.conteudo) === 'transcrição')
                transcritos.push({ periodo: reg.PERIODO,
                    nome: path.basename(String(x.arquivo).replace(/#p\d+$/, '')) });
    const unicos = [...new Map(transcritos.map(t => [t.nome, t])).values()];
    console.log(`transcritos (nomes únicos): ${unicos.length}\n`);

    const naPasta = new Set();
    for (const per of Object.keys(pasta.arquivosPorMes))
        for (const a of pasta.arquivosPorMes[per]) naPasta.add(a.nome);
    console.log(`nomes na varredura de contarNaPasta: ${naPasta.size}`);

    // Índice do disco INTEIRO, sem filtro nenhum.
    const noDisco = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!noDisco.has(x.name)) noDisco.set(x.name, q); }
    })(RAIZ_ARQ);
    console.log(`arquivos no disco (sem filtro):     ${noDisco.size}\n`);

    const cont = { naPasta: 0, soNoDisco: 0, sumiu: 0 };
    const exemplos = { soNoDisco: [], sumiu: [] };
    for (const t of unicos) {
        if (naPasta.has(t.nome)) { cont.naPasta++; continue; }
        if (noDisco.has(t.nome)) {
            cont.soNoDisco++;
            if (exemplos.soNoDisco.length < 40)
                exemplos.soNoDisco.push({ ...t, abs: noDisco.get(t.nome) });
        } else {
            cont.sumiu++;
            if (exemplos.sumiu.length < 15) exemplos.sumiu.push(t);
        }
    }
    console.log(`ONDE ESTÃO OS ${unicos.length} TRANSCRITOS`);
    console.log(`   na varredura do pareamento:  ${cont.naPasta}`);
    console.log(`   no disco, mas FILTRADOS:     ${cont.soNoDisco}`);
    console.log(`   não existem mais no disco:   ${cont.sumiu}`);

    if (exemplos.soNoDisco.length) {
        console.log('\nOS FILTRADOS — por que `contarNaPasta` não os conta:');
        for (const e of exemplos.soNoDisco) {
            const rel = path.relative(RAIZ_ARQ, e.abs);
            const cat = rota.categoriaNaoFiscal ? rota.categoriaNaoFiscal(e.nome) : '?';
            const doc = rota.ehDoc ? rota.ehDoc(e.nome) : '?';
            console.log(`   ehDoc=${String(doc).padEnd(5)} naoFiscal=${JSON.stringify(cat).padEnd(24)} ${rel.slice(0, 62)}`);
        }
    }
    if (exemplos.sumiu.length) {
        console.log('\nOS QUE NÃO ESTÃO NO DISCO:');
        for (const e of exemplos.sumiu) console.log(`   [${e.periodo}] ${e.nome.slice(0, 66)}`);
    }
    process.exit(0);
})();
