/**
 * _medir/_transcrever-vs-extrair.js — a IA como TRANSCRITOR (o que o usuário pediu).
 *
 * ── O teste que eu errei ─────────────────────────────────────────────────────
 * O usuário pediu para mandar o documento à IA e ela **TRANSCREVER**. Eu testei
 * outra coisa: mandei a página e pedi o JSON de campos direto
 * (`_visao-em-pdf-texto.js`, `_multicampo-texto-vs-imagem.js`). São coisas
 * diferentes, e a diferença é exatamente onde meus testes falharam:
 *
 *   EXTRAIR (o que eu testei):  imagem → JSON de campos
 *       A IA decide QUAL número é o valor do documento. Foi aí que ela leu
 *       "Valor Crédito" 42.015,60 em vez da parcela de 696,33, "SALDO DEVEDOR"
 *       em vez do valor pago, "Valor Total dos Bens" em vez de 7.064,44.
 *       O erro era de ESCOLHA DE CAMPO, não de leitura.
 *
 *   TRANSCREVER (o que o usuário pediu):  imagem → TEXTO corrido
 *       A IA só converte pixels em caracteres. Quem decide qual número é o valor
 *       continua sendo o `FULL_PROMPT` + os parsers — que têm 14.000 caracteres de
 *       regra, precedência de pacote multi-documento e a aritmética do boleto.
 *       A IA vira substituta do OCR, não do extrator.
 *
 * Essa separação é o que pode salvar a abordagem: nos 4 casos que reprovaram a
 * visão, o texto nativo ACERTOU com o mesmo prompt. Se a transcrição produzir
 * texto de qualidade parecida com o nativo, o pipeline que já funciona passa a
 * alcançar os 1.037 PDF-imagem de março.
 *
 * ── O que se mede ────────────────────────────────────────────────────────────
 * Em PDFs que TÊM texto nativo (o único caso com gabarito de texto disponível):
 *
 *   (a) nativo      — `pdf-parse`, o texto que o emissor gravou = VERDADE
 *   (b) transcrito  — a MESMA página rasterizada, transcrita pela IA
 *   (c) ocr         — o servidor PaddleOCR, se estiver de pé (referência)
 *
 * e depois roda o MESMO pipeline de extração sobre (a) e (b), comparando os campos
 * pelo gabarito do nome do arquivo (régua de `_julgar-campos.js`).
 *
 * Duas perguntas, nesta ordem:
 *   1. a transcrição RECUPERA o texto? (similaridade com o nativo)
 *   2. o pipeline extrai os mesmos campos do texto transcrito?
 *
 * A (1) é o teste honesto da transcrição; a (2) é o que decide se serve.
 *
 * Uso: node _medir/_transcrever-vs-extrair.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const visao = require('../routes/_nf-visao');
const { PDFParse } = require('pdf-parse');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 14;
const MODELO = 'gpt-4.1-mini';
const PRECO = [0.40, 1.60];
const OCR_URL = 'http://127.0.0.1:5001/ocr';

// ── O prompt de TRANSCRIÇÃO ──────────────────────────────────────────────────
// Diferente em espírito do de extração: nenhuma decisão, nenhum julgamento de qual
// campo importa. Só "copie o que está escrito". As instruções todas existem para
// impedir a IA de RESUMIR ou INTERPRETAR — que é o que ela tende a fazer, e que
// destruiria justamente os números que os parsers procuram.
const PROMPT_TRANSCRICAO = `Você é um OCR. Transcreva LITERALMENTE todo o texto visível nesta página.

REGRAS ABSOLUTAS:
· Copie cada caractere como está impresso. NÃO resuma, NÃO interprete, NÃO reordene.
· NÃO explique, NÃO comente, NÃO adicione cabeçalhos seus. Só o texto do papel.
· Preserve NÚMEROS exatamente: "17.904,40" se transcreve "17.904,40" — não
  17904.40, não 17,90. O ponto de milhar e a vírgula decimal ficam como estão.
· Preserve a ORDEM de leitura e a separação em linhas. Em tabela, mantenha cada
  linha da tabela numa linha do texto, com os campos separados por espaços.
· Preserve RÓTULOS junto de seus valores ("Valor Total da Nota  R$ 1.234,56").
  O rótulo é o que permite identificar o campo depois — nunca o omita.
· Transcreva TODOS os números da página, inclusive os que parecem irrelevantes.
· Códigos de barras / linha digitável: copie a sequência de dígitos como impressa.
· Se algo estiver ilegível, escreva [ilegível] naquele ponto e siga.

Devolva APENAS o texto transcrito, em texto puro, sem markdown e sem JSON.`;

async function textoNativo(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getText();
        return { texto: (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' '), paginas: r.total || 1 };
    } catch (e) { return { texto: '', paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

async function transcrever(buf, maxPg) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let imgs;
    try { imgs = await visao.paginasEmPng(buf, maxPg); }
    catch (e) { return { erro: `rasterização: ${e.message}` }; }
    if (!imgs.length) return { erro: 'nenhuma página rasterizada' };
    const content = imgs.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }));
    content.push({ type: 'text', text: 'Transcreva o texto desta(s) página(s).' });
    const r = await callOpenAI(key, {
        model: MODELO, temperature: 0, max_tokens: 8000,
        messages: [{ role: 'system', content: PROMPT_TRANSCRICAO }, { role: 'user', content }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { texto: body?.choices?.[0]?.message?.content ?? '', uso: body.usage || {}, nPg: imgs.length };
}

async function viaOcr(buf) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/pdf' }), 'x.pdf');
    try {
        const r = await fetch(OCR_URL, { method: 'POST', body: fd, signal: AbortSignal.timeout(120_000) });
        if (!r.ok) return { erro: `HTTP ${r.status}` };
        const jj = await r.json();
        return jj.error ? { erro: jj.error } : { texto: jj.text || '' };
    } catch (e) { return { erro: e.message }; }
}

// ── Similaridade: quanto do texto nativo a transcrição recuperou? ────────────
// Não uso distância de edição: o que importa não é a prosa, são os TOKENS que os
// parsers procuram — números, CNPJ, datas, rótulos. Mede-se recall de tokens
// significativos, que é o que decide se a extração vai funcionar.
const TOK_NUM = /\d{1,3}(?:\.\d{3})*,\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{5,}/g;
const tokensDe = s => new Set((String(s).match(TOK_NUM) || []));
const palavrasDe = s => new Set(String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length >= 5));

function recall(refSet, gotSet) {
    if (!refSet.size) return null;
    let n = 0;
    for (const t of refSet) if (gotSet.has(t)) n++;
    return n / refSet.size;
}

// ── Extração: roda o pipeline real sobre um texto qualquer ───────────────────
function promptExtracao() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    const m = src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/);
    if (!m) throw new Error('não achei FULL_PROMPT');
    return m[1];
}

async function extrair(prompt, texto, nome, paginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    let t = String(texto || '');
    if (!t.replace(/\s/g, '').length) return { erro: 'texto vazio' };
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: prompt },
                   { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode}` };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let d = null;
    try { d = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { d = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return d ? { lido: j.normaliza(d), uso: body.usage || {} } : { erro: 'JSON inválido' };
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
const CAMPOS = j.CAMPOS;

(async () => {
    const prompt = promptExtracao();
    console.log(`TRANSCRIÇÃO (${MODELO}) × TEXTO NATIVO — extração pelo MESMO pipeline\n`);

    // Só PDFs COM texto nativo: é o único caso em que existe VERDADE contra a qual
    // medir a transcrição. Em PDF-imagem não há como saber o que a IA errou.
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 20)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const COTA = { poluida: 5, multi: 5, normal: 4 };
    const alvos = [];
    const porDif = {}, porLayout = {};
    console.error('[transcrever] montando amostra (PDFs COM texto, p/ haver verdade)...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const a = j.assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await textoNativo(buf);
        if (texto.replace(/\s/g, '').length < 200) continue;   // precisa de texto p/ comparar
        const dif = j.dificuldade(nome, texto, true);
        if ((porDif[dif] || 0) >= (COTA[dif] || 0)) continue;
        porDif[dif] = (porDif[dif] || 0) + 1;
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ buf, nome, texto, paginas, dif, g: j.gabaritos(nome) });
    }
    console.log(`amostra: ${alvos.length}   ` + Object.entries(porDif).map(([k, v]) => `${k}=${v}`).join('  ') + '\n');

    const ocrVivo = !(await viaOcr(Buffer.from('%PDF-1.4')).then(r => r.erro && /fetch failed|ECONN/.test(String(r.erro))));
    console.log(`servidor de OCR: ${ocrVivo ? 'de pé (entra como referência)' : 'fora do ar (só nativo × transcrito)'}\n`);

    const acc = { nativo: {}, transcrito: {} };
    for (const v of Object.keys(acc)) for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    let somaRecallNum = 0, somaRecallPal = 0, nRec = 0, tokIn = 0, tokOut = 0, falhas = 0;
    const linhas = [];

    for (const a of alvos) {
        console.error(`  [${a.dif}] ${a.nome.slice(0, 46)}`);
        const t = await transcrever(a.buf, Math.min(a.paginas, 3));
        if (t.uso) { tokIn += t.uso.prompt_tokens || 0; tokOut += t.uso.completion_tokens || 0; }
        if (t.erro) { falhas++; console.error(`      transcrição falhou: ${t.erro}`); continue; }

        // 1) a transcrição recuperou os tokens que os parsers procuram?
        const refNum = tokensDe(a.texto), gotNum = tokensDe(t.texto);
        const refPal = palavrasDe(a.texto), gotPal = palavrasDe(t.texto);
        const rNum = recall(refNum, gotNum), rPal = recall(refPal, gotPal);
        if (rNum != null) { somaRecallNum += rNum; nRec++; }
        if (rPal != null) somaRecallPal += rPal;

        // 2) o pipeline extrai os mesmos campos dos dois textos?
        const eA = await extrair(prompt, a.texto, a.nome, a.paginas);
        const eB = await extrair(prompt, t.texto, a.nome, a.paginas);
        const jA = eA.lido ? j.julgar(eA.lido, a.g) : null;
        const jB = eB.lido ? j.julgar(eB.lido, a.g) : null;
        if (jA) for (const c of CAMPOS) acc.nativo[c][jA[c] === 's/gab' ? 'semGab' : jA[c]]++;
        if (jB) for (const c of CAMPOS) acc.transcrito[c][jB[c] === 's/gab' ? 'semGab' : jB[c]]++;

        linhas.push({
            nome: a.nome, dif: a.dif, g: a.g,
            nNativo: a.texto.replace(/\s/g, '').length,
            nTrans: String(t.texto).replace(/\s/g, '').length,
            rNum, rPal, jA, jB, lidoA: eA.lido, lidoB: eB.lido,
            faltaram: [...refNum].filter(x => !gotNum.has(x)).slice(0, 6),
        });
    }

    console.log('┌─ documento a documento ────────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ [${l.dif}] ${l.nome.slice(0, 50)}`);
        console.log(`│   chars: nativo=${String(l.nNativo).padStart(6)}  transcrito=${String(l.nTrans).padStart(6)}` +
            `   recall números=${l.rNum == null ? '—' : (l.rNum * 100).toFixed(0) + '%'}` +
            `  palavras=${l.rPal == null ? '—' : (l.rPal * 100).toFixed(0) + '%'}`);
        if (l.jA && l.jB) {
            console.log(`│   nativo     ` + CAMPOS.map(c => `${c[0]}${j.MARCA[l.jA[c]]}`).join(' ') +
                `   valor=${String(l.lidoA.valor ?? '—').padStart(10)}`);
            console.log(`│   transcrito ` + CAMPOS.map(c => `${c[0]}${j.MARCA[l.jB[c]]}`).join(' ') +
                `   valor=${String(l.lidoB.valor ?? '—').padStart(10)}`);
        }
        if (l.faltaram.length) console.log(`│   números PERDIDOS na transcrição: ${l.faltaram.join('  ')}`);
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`1) A TRANSCRIÇÃO RECUPERA O TEXTO? (n=${nRec})`);
    console.log(`   recall médio de NÚMEROS/datas/CNPJ: ${nRec ? (somaRecallNum / nRec * 100).toFixed(1) + '%' : '—'}`);
    console.log(`   recall médio de PALAVRAS (5+ letras): ${nRec ? (somaRecallPal / nRec * 100).toFixed(1) + '%' : '—'}`);
    console.log('   (100% = a transcrição contém todos os tokens do texto nativo)');

    console.log(`\n2) O PIPELINE EXTRAI OS MESMOS CAMPOS?`);
    console.log('   via          ' + CAMPOS.map(c => c.padStart(9)).join('') + '     ERROS');
    for (const v of ['nativo', 'transcrito']) {
        const cels = CAMPOS.map(c => {
            const x = acc[v][c];
            return `${x.ok}ok/${x.erro}e`.padStart(9);
        });
        const errs = CAMPOS.map(c => acc[v][c].erro).reduce((s, n) => s + n, 0);
        console.log('   ' + v.padEnd(12) + cels.join('') + String(errs).padStart(10));
    }

    const conc = linhas.filter(l => l.jA && l.jB);
    let iguais = 0, melhor = 0, pior = 0;
    for (const l of conc) for (const c of CAMPOS) {
        const a = l.jA[c] === 'ok', b = l.jB[c] === 'ok';
        if (a === b) iguais++; else if (b) melhor++; else pior++;
    }
    console.log(`\n   campos idênticos ao nativo: ${iguais}   transcrito melhor: ${melhor}   PIOR: ${pior}`);

    const custo = (((tokIn / Math.max(1, nRec)) / 1e6) * PRECO[0] + ((tokOut / Math.max(1, nRec)) / 1e6) * PRECO[1]);
    console.log(`\ncusto da transcrição: US$ ${custo.toFixed(5)}/doc  →  1.037 PDF-imagem ≈ US$ ${(custo * 1037).toFixed(2)}`);
    if (falhas) console.log(`falhas de transcrição: ${falhas}`);

    console.log('\nA transcrição serve se o recall de NÚMEROS for alto E a extração não piorar.');
    console.log('Número perdido na transcrição é valor que o parser nunca vai achar.');
    process.exit(0);
})();
