/**
 * _medir/_o-que-vai-para-ia.js — que arquivos SAEM daqui para a IA?
 *
 * Pergunta do usuário (11/09/2026): os documentos enviados para a IA são apenas os
 * DOCs? Ou vão CPV e os 000.pdf também?
 *
 * A pergunta é de PRIVACIDADE, não de custo: o que vai para a OpenAI/Anthropic sai
 * da rede da empresa. Comprovante de pagamento (CPV) e extrato bancário do dia
 * (000.pdf) contêm dado que a nota fiscal não contém — saldo de conta, histórico de
 * movimentação, CPF de funcionário em folha e pensão.
 *
 * O filtro está em `ehAnexoIgnoravel` (process-folder.js): exclui `NNN.CPV` e
 * `000.*`. Mas ele NÃO é "só DOC passa" — de propósito, e a medição de 09/09/2026
 * explica: dos 86 arquivos "outros", 6,7% SÃO fiscais (um "021.ODC" com as letras
 * trocadas, três NFS-e da SASCAR sem prefixo). Filtrar por `^NNN.DOC` descartaria
 * notas de verdade.
 *
 * Então o conjunto enviado é: TUDO menos CPV e extrato-do-dia. Este script mede o
 * que isso significa na prática, e procura o que pode estar passando sem ser nota:
 *
 *   1. quantos arquivos entram, por classe de nome (DOC / outros / CPV / 000)
 *   2. quais dos "outros" existem de fato, um por um — é aí que mora a surpresa
 *   3. quantos dos que ENTRAM chegam de fato à IA (só PDF-IMAGEM aciona
 *      transcrição/visão; PDF com texto nativo vai como TEXTO, que é outro risco)
 *   4. busca por indício de dado pessoal nos nomes que entram: CPF, folha,
 *      pensão, rescisão, salário, exame, atestado
 *
 * SOMENTE LEITURA. Não chama IA nenhuma.
 *
 * Uso: node _medir/_o-que-vai-para-ia.js [subpasta]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const SUB = process.argv[2] || '';   // vazio = acervo inteiro

// As MESMAS regex de process-folder.js, lidas do fonte para não divergirem.
function filtrosDaRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const mC = src.match(/const RE_CPV\s*=\s*(\/.*?\/[a-z]*)/);
    const mE = src.match(/const RE_EXTRATO_DIA\s*=\s*(\/.*?\/[a-z]*)/);
    if (!mC || !mE) throw new Error('não achei RE_CPV/RE_EXTRATO_DIA — fonte mudou?');
    return { cpv: eval(mC[1]), extrato: eval(mE[1]) };
}

// Indícios de DADO PESSOAL no nome do arquivo. Não é prova do conteúdo, é sinal
// para conferência humana — o nome é digitado pela equipe e costuma descrever.
const PESSOAL = [
    [/\bCPF\b/i, 'CPF no nome'],
    [/\bFOLHA\b|\bADTO SALARIAL\b|\bADIANTAMENTO\b|\bSALARI/i, 'folha/salário'],
    [/\bPENSAO\b|\bPENSÃO\b|\bALIMENT/i, 'pensão alimentícia'],
    [/\bRESCIS/i, 'rescisão'],
    [/\bFGTS\b|\bINSS\b|\bGPS\b/i, 'encargo trabalhista'],
    [/\bEXAME\b|\bATESTADO\b|\bASO\b/i, 'saúde'],
    [/\bVA\b|\bVT\b|\bVALE\b/i, 'vale/benefício'],
    [/\bRG\b|\bCNH\b|\bCARTEIRA\b/i, 'documento de identidade'],
];

async function ehImagem(abs) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getText();
        const t = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        return t.replace(/\s/g, '').length < 15;
    } catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

(async () => {
    const F = filtrosDaRota();
    const raiz = SUB ? path.join(RAIZ_ARQ, SUB) : RAIZ_ARQ;
    console.log(`raiz: ${raiz}\n`);

    const todos = [];
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) {
            const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q);
            else if (/\.pdf$/i.test(x.name)) todos.push({ nome: x.name, abs: q });
        }
    })(raiz);

    const classe = n => {
        if (F.cpv.test(n)) return 'CPV (excluído)';
        if (F.extrato.test(n)) return '000/extrato (excluído)';
        if (/^\s*\d{1,4}\s*[.\-]\s*DOC/i.test(n)) return 'DOC (entra)';
        return 'OUTROS (entra)';
    };

    const porClasse = {};
    const entram = [], outros = [];
    for (const f of todos) {
        const c = classe(f.nome);
        porClasse[c] = (porClasse[c] || 0) + 1;
        if (c.includes('entra')) entram.push(f);
        if (c.startsWith('OUTROS')) outros.push(f);
    }

    console.log(`1) O QUE ENTRA NO PIPELINE (total ${todos.length} PDFs)`);
    for (const [c, n] of Object.entries(porClasse).sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(n).padStart(6)}  ${(n / todos.length * 100).toFixed(1).padStart(5)}%  ${c}`);
    console.log(`\n   → ${entram.length} arquivos ENTRAM (${(entram.length / todos.length * 100).toFixed(1)}%)`);
    console.log(`   → ${todos.length - entram.length} são barrados por ehAnexoIgnoravel`);

    console.log(`\n2) OS "OUTROS" QUE ENTRAM (${outros.length}) — não têm prefixo DOC`);
    const amostraOutros = outros.slice(0, 40);
    for (const f of amostraOutros) console.log(`      ${f.nome.slice(0, 68)}`);
    if (outros.length > amostraOutros.length) console.log(`      ... e mais ${outros.length - amostraOutros.length}`);

    console.log(`\n3) INDÍCIO DE DADO PESSOAL NOS NOMES QUE ENTRAM`);
    const achados = {};
    for (const f of entram) {
        for (const [re, rot] of PESSOAL) {
            if (re.test(f.nome)) {
                (achados[rot] = achados[rot] || []).push(f.nome);
                break;
            }
        }
    }
    if (!Object.keys(achados).length) console.log('   (nenhum indício nos nomes)');
    for (const [rot, lista] of Object.entries(achados).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`   ${String(lista.length).padStart(5)}  ${rot}`);
        for (const n of lista.slice(0, 4)) console.log(`            ${n.slice(0, 62)}`);
    }

    // 4) dos que entram, quantos são IMAGEM (vão como PNG para a IA)?
    // Amostra, porque abrir todo PDF do acervo é caro.
    const AMOSTRA = Math.min(entram.length, 400);
    const passo = Math.max(1, Math.floor(entram.length / AMOSTRA));
    let img = 0, txt = 0, erro = 0, n = 0;
    const imgPessoal = [];
    console.error(`\n[amostra] conferindo imagem × texto em ${AMOSTRA} arquivos...`);
    for (let i = 0; i < entram.length && n < AMOSTRA; i += passo) {
        const f = entram[i];
        const r = await ehImagem(f.abs);
        n++;
        if (r === null) { erro++; continue; }
        if (r) {
            img++;
            for (const [re, rot] of PESSOAL) if (re.test(f.nome)) { imgPessoal.push(`${rot}: ${f.nome}`); break; }
        } else txt++;
    }
    console.log(`\n4) COMO O CONTEÚDO VAI PARA A IA (amostra de ${n} dos que entram)`);
    console.log(`   PDF-IMAGEM  ${String(img).padStart(4)}  ${(img / Math.max(1, img + txt) * 100).toFixed(1)}%  → a PÁGINA vira PNG e é enviada (transcrição/visão)`);
    console.log(`   com TEXTO   ${String(txt).padStart(4)}  ${(txt / Math.max(1, img + txt) * 100).toFixed(1)}%  → o TEXTO é enviado (FULL_PROMPT)`);
    if (erro) console.log(`   erro ao ler ${erro}`);
    if (imgPessoal.length) {
        console.log(`\n   PDF-imagem COM indício de dado pessoal (vão como imagem para a IA):`);
        for (const s of imgPessoal.slice(0, 12)) console.log(`      ${s.slice(0, 70)}`);
    }

    console.log('\n─────────────────────────────────────────────────────────────');
    console.log('CPV e 000/extrato NÃO são enviados. Mas "entra" não é só DOC:');
    console.log('todo PDF que não seja CPV nem extrato entra, e isso é deliberado');
    console.log('(6,7% dos "outros" são notas fiscais sem prefixo).');
    process.exit(0);
})();
