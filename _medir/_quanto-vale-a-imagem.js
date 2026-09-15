/**
 * _medir/_quanto-vale-a-imagem.js — quanto está preso nos PDFs que são imagem?
 *
 * Um terço de 03.2026 (1.037 de 2.221) não tem texto selecionável: nenhum parser
 * alcança. Antes de propor OCR melhor ou visão por IA — que custam —, é preciso
 * responder o que se ganharia, e a resposta não é "1.037 documentos": é quanto
 * DINHEIRO e quantos LANÇAMENTOS dependem deles.
 *
 * Mede três coisas, da mais barata à mais cara de obter:
 *
 *   1. quantos PDFs-imagem existem e quantos são DOCUMENTO (não CPV/extrato);
 *   2. quantos deles participam de um PAR com a planilha — e por qual via;
 *   3. quanto valem esses lançamentos, e quantos hoje aparecem como DIVERGENTES
 *      ou SEM DOCUMENTO por não termos como ler o papel.
 *
 * O item 3 é o que decide: um PDF-imagem que já casa por nome de arquivo não
 * precisa de OCR nenhum. O que importa é onde a falta de texto CUSTA.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PERIODO = process.argv[2] || '03.2026';
const PASTA = process.argv[3] || '2026.03.EXTRATOS CONTABILIDADE';

// Mesmo corte de `ehAnexoIgnoravel` (process-folder.js): CPV é comprovante de
// pagamento e `000.*` é extrato do dia — nenhum é documento fiscal, e contá-los
// inflaria o problema com arquivos que ninguém quer ler.
const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXTRATO = /^0+\s*[.\-]/;
const ehAnexo = n => RE_CPV.test(n) || RE_EXTRATO.test(n);

async function ehImagem(abs) {
    const pr = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
    try {
        const t = ((await pr.getText()).text || '');
        return t.replace(/\s/g, '').length < 15;
    } catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}

const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
    // ── 1. quais arquivos da pasta são imagem ──
    const pdfs = listarPdfs(path.join(RAIZ_ARQ, PASTA));
    console.error(`[img] verificando ${pdfs.length} PDFs...`);
    const imagem = new Set();      // nome do arquivo
    let docs = 0, anexos = 0, i = 0;
    for (const abs of pdfs) {
        const nome = path.basename(abs);
        if (++i % 400 === 0) console.error(`  ${i}/${pdfs.length}`);
        if (ehAnexo(nome)) { anexos++; continue; }
        docs++;
        const img = await ehImagem(abs);
        if (img) imagem.add(nome);
    }

    console.log(`\n══ ${PASTA} ══`);
    console.log(`PDFs na pasta:        ${pdfs.length}`);
    console.log(`  CPV/extrato:        ${anexos}  (ignorados pelo scan)`);
    console.log(`  documentos:         ${docs}`);
    console.log(`  destes, IMAGEM:     ${imagem.size}  (${(imagem.size / docs * 100).toFixed(1)}% dos documentos)\n`);

    // ── 2 e 3. o que esses arquivos representam no pareamento ──
    const { pasta, planilha } = h.carregar();
    const ocr = await indexar();

    const docsPorMes = {};
    for (const off of [0, ...p.VIZINHANCA]) {
        const alvo = p.deslocarPeriodo(PERIODO, off);
        docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
            p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
    }
    const lancs = ((planilha[PERIODO] || {}).itens || []).map(p.lancamentoDaPlanilha);
    const r = p.conferirPeriodo(lancs, docsPorMes, PERIODO);
    const pares = [...r.pares, ...r.paresVizinhos];

    let paresImg = 0, valorPares = 0;
    const porVia = {};
    let semValorNoPapel = 0, divergentes = 0, valorDiv = 0;
    const exemplos = [];

    for (const par of pares) {
        const nome = par.documento.arquivo;
        if (!imagem.has(nome)) continue;
        paresImg++;
        valorPares += Math.abs(par.lancamento.valor || 0);
        porVia[par.via] = (porVia[par.via] || 0) + 1;

        // O papel tem valor legível? Sem texto, o valor só pode vir do NOME.
        const d = par.documento;
        const temValor = (d.valor != null && d.valor > 0) || (d.valorAlt != null && d.valorAlt > 0);
        if (!temValor) semValorNoPapel++;
        else {
            const v = [d.valor, d.valorAlt].filter(x => x != null && x > 0)
                .reduce((a, b) => Math.abs(par.lancamento.valor - a) <= Math.abs(par.lancamento.valor - b) ? a : b);
            const dif = v - par.lancamento.valor;
            if (Math.abs(dif) >= 0.005) {
                divergentes++; valorDiv += Math.abs(dif);
                if (exemplos.length < 12)
                    exemplos.push({ ent: par.lancamento.entidade, nf: par.lancamento.nf,
                                    pl: par.lancamento.valor, doc: v, dif, arq: nome });
            }
        }
    }

    console.log(`── o que os PDFs-imagem representam em ${PERIODO} ──`);
    console.log(`pares em que o documento é imagem:  ${paresImg} de ${pares.length} pares`);
    console.log(`  valor lançado nesses pares:       ${brl(valorPares)}`);
    console.log(`  via de casamento:                 ${JSON.stringify(porVia)}`);
    console.log(`  SEM valor legível no papel:       ${semValorNoPapel}  ← o valor veio só do nome`);
    console.log(`  aparecem como DIVERGENTES:        ${divergentes}   ${brl(valorDiv)} de diferença\n`);

    // Os que ninguém casou: podem ser documento órfão por não termos o texto.
    const nomesPar = new Set(pares.map(x => x.documento.arquivo));
    const imgSemPar = [...imagem].filter(n => !nomesPar.has(n));
    console.log(`PDFs-imagem que NÃO casaram com lançamento nenhum: ${imgSemPar.length}`);
    console.log('  (candidatos a "documento sem lançamento" causados por falta de leitura)\n');

    if (exemplos.length) {
        console.log('DIVERGÊNCIAS em documento-imagem (o papel não pôde ser lido):');
        for (const e of exemplos)
            console.log(`  ${String(e.ent).slice(0, 26).padEnd(26)} NF ${String(e.nf).padEnd(8)} ` +
                `pl ${e.pl.toFixed(2).padStart(10)} doc ${e.doc.toFixed(2).padStart(10)} ` +
                `dif ${e.dif.toFixed(2).padStart(10)}`);
    }
    if (imgSemPar.length) {
        console.log('\nAMOSTRA dos imagem sem par:');
        for (const n of imgSemPar.slice(0, 12)) console.log('  ' + n.slice(0, 74));
    }
    process.exit(0);
})();
