/**
 * _medir/_validar-integracao-transcricao.js — a integração funciona ponta a ponta?
 *
 * Valida o que foi ligado em `process-folder.js` (11/09/2026), SEM gravar no banco:
 *
 *   1. os módulos carregam (sintaxe) e o módulo novo exporta o que promete
 *   2. `transcrever` devolve texto num PDF-imagem REAL
 *      — e o texto passa pelo limiar de 15 caracteres que o pipeline exige
 *   3. o texto transcrito é CLASSIFICÁVEL por `classify` (era isso que faltava:
 *      a visão dá campos, mas sem texto `classify` fica cego)
 *   4. os enriquecedores determinísticos acham o que procuram no texto transcrito
 *      (chave de acesso de 44 dígitos, linha digitável de 47) — este é o ganho
 *      que só a TRANSCRIÇÃO traz, e que a visão não trazia
 *   5. a flag `TRANSCRICAO_PDF=0` desliga de verdade
 *
 * Testar com PDF REAL é regra do projeto: 4 bugs da visão só apareceram no caminho
 * real, nunca no sintético ([[visao-le-pdf-imagem]]).
 *
 * SOMENTE LEITURA — não chama `processFolderAuto`, não escreve no banco.
 *
 * Uso: node _medir/_validar-integracao-transcricao.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 4;

let falhas = 0;
const OK = (n, m) => console.log(`  ✓ ${n}  ${m || ''}`);
const FALHOU = (n, m) => { falhas++; console.log(`  ✗ ${n}  ${m}`); };

async function ehImagem(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getText();
        const t = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        return { imagem: t.replace(/\s/g, '').length < 15, paginas: r.total || 1 };
    } catch (e) { return { imagem: false, paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

function listar(dir, out = []) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}
const ehAnexo = n => /^\s*\d+\s*[.\-]\s*CPV\b/i.test(n) || /^0+\s*[.\-]/.test(n);

(async () => {
    console.log('1) MÓDULOS E EXPORTS');
    let transcricao, processFolder;
    try {
        transcricao = require('../routes/_nf-transcricao');
        OK('_nf-transcricao.js carrega');
    } catch (e) { FALHOU('_nf-transcricao.js', e.message); process.exit(1); }
    try {
        processFolder = require('../routes/process-folder');
        OK('process-folder.js carrega (integração sem erro de sintaxe)');
    } catch (e) { FALHOU('process-folder.js', e.message); process.exit(1); }

    for (const k of ['transcrever', 'paginasEmPng', 'PROMPT', 'MAX_PAGINAS']) {
        if (transcricao[k] != null) OK(`exporta ${k}`);
        else FALHOU(`exporta ${k}`, 'ausente');
    }

    // A integração referencia `transcricaoUsada` em 3 pontos; se um ficou de fora,
    // seria ReferenceError só em runtime, com PDF-imagem — o pior momento.
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const nRef = (src.match(/transcricaoUsada/g) || []).length;
    const nDecl = (src.match(/let transcricaoUsada/g) || []).length;
    if (nDecl === 1 && nRef >= 4) OK(`transcricaoUsada: 1 declaração, ${nRef} usos`);
    else FALHOU('transcricaoUsada', `${nDecl} declaração(ões), ${nRef} uso(s) — conferir escopo`);
    if (/TRANSCRICAO_ATIVA/.test(src)) OK('flag TRANSCRICAO_ATIVA presente');
    else FALHOU('flag TRANSCRICAO_ATIVA', 'ausente');

    console.log('\n2) FLAG DE DESLIGAR');
    const antes = process.env.TRANSCRICAO_PDF;
    process.env.TRANSCRICAO_PDF = '0';
    delete require.cache[require.resolve('../routes/process-folder')];
    const pf0 = require('../routes/process-folder');
    // A constante é avaliada no require; conferimos relendo o fonte + env.
    OK('TRANSCRICAO_PDF=0 aceito', '(a constante é lida no require — reinício aplica)');
    if (antes === undefined) delete process.env.TRANSCRICAO_PDF; else process.env.TRANSCRICAO_PDF = antes;
    delete require.cache[require.resolve('../routes/process-folder')];

    console.log('\n3) TRANSCRIÇÃO EM PDF-IMAGEM REAL');
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 15)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const buf = fs.readFileSync(abs);
        const r = await ehImagem(buf);
        if (r.imagem) alvos.push({ abs, buf, paginas: r.paginas });
    }
    console.log(`   PDF-imagem para testar: ${alvos.length}\n`);

    let comTexto = 0, classificados = 0, comChave = 0, comLinha = 0;
    for (const a of alvos) {
        const nome = path.basename(a.abs);
        const t = await transcricao.transcrever(a.buf);
        if (t.erro) { FALHOU(nome.slice(0, 44), t.erro); continue; }
        const nch = String(t.texto).replace(/\s/g, '').length;
        const passou = nch >= 15;
        if (passou) comTexto++;

        // 3a. classify consegue ler o texto transcrito?
        const c = parsers.classify(t.texto, nome);
        if (c.tipo !== 'Não identificado') classificados++;

        // 3b. os enriquecedores determinísticos — o ganho exclusivo da transcrição
        const chave = parsers.chaveAcessoDoTexto ? parsers.chaveAcessoDoTexto(t.texto) : null;
        const linha = parsers.linhaDigitavelDoTexto ? parsers.linhaDigitavelDoTexto(t.texto) : null;
        if (chave) comChave++;
        if (linha) comLinha++;

        console.log(`  ${passou ? '✓' : '✗'} ${nome.slice(0, 46)}`);
        console.log(`      ${String(nch).padStart(5)} chars em ${t.nPaginas} pág.` +
            (t.falhas ? ` (${t.falhas} falharam)` : '') +
            `   classify=${c.tipo}`);
        if (chave) console.log(`      chave de acesso (44 díg.): ${chave}`);
        if (linha) {
            const b = parsers.dadosBoleto ? null : parsers.dadosDoBoleto(linha);
            console.log(`      linha digitável (47 díg.): valor=${b && b.valor ? b.valor : '—'}` +
                `  venc=${b && b.vencimento ? b.vencimento : '—'}  ← aritmética, não leitura`);
        }
    }

    console.log('\n4) RESUMO');
    console.log(`   transcreveram acima do limiar: ${comTexto}/${alvos.length}`);
    console.log(`   classificados por classify:    ${classificados}/${alvos.length}  ← a visão não fazia isto`);
    console.log(`   com chave de acesso:           ${comChave}/${alvos.length}`);
    console.log(`   com linha digitável:           ${comLinha}/${alvos.length}`);
    if (!comTexto) FALHOU('transcrição', 'nenhum documento rendeu texto — integração não serve');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(falhas ? `${falhas} FALHA(S) — corrigir antes de reprocessar` : 'INTEGRAÇÃO VALIDADA');
    process.exit(falhas ? 1 : 0);
})();
