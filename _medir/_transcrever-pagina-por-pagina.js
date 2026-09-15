/**
 * _medir/_transcrever-pagina-por-pagina.js — uma chamada por PÁGINA conserta o recall?
 *
 * ── De onde vem esta pergunta ────────────────────────────────────────────────
 * `_transcrever-vs-extrair.js` mediu a IA como TRANSCRITOR (o que o usuário pediu
 * desde o início) e o resultado foi bom onde importa — o pipeline extraiu o VALOR
 * igual ao texto nativo (11ok/1e nos dois) e os casos que reprovaram a extração por
 * imagem (consórcio, Daycoval) voltaram a acertar, porque quem escolhe o campo
 * voltou a ser o FULL_PROMPT.
 *
 * O defeito ficou no RECALL: 70,6% dos tokens numéricos. E o padrão é claro —
 * documento longo é RESUMIDO:
 *
 *   PRUDENTIAL   32.007 chars nativos → 5.756 transcritos → recall 18%
 *   UNIDAS        7.490 → 6.060 → 77%
 *   consórcio     6.903 → 6.799 → 94%   (curto: vai bem)
 *
 * Hipótese: 3 páginas numa chamada com `max_tokens: 8000` não cabem, então a IA
 * trunca ou resume — apesar de o prompt proibir. Uma chamada POR PÁGINA remove o
 * aperto de espaço e o incentivo a resumir.
 *
 * ── O que se mede ────────────────────────────────────────────────────────────
 *   (a) lote    — N páginas numa chamada (a versão anterior, controle)
 *   (b) por-pg  — uma chamada por página, textos concatenados na ordem
 *
 * Mesma amostra, mesmo prompt, mesmo modelo. Mede recall de tokens contra o texto
 * NATIVO (a verdade) e depois roda o pipeline de extração sobre os dois.
 *
 * Reporta também CUSTO e nº de chamadas: por-página multiplica as chamadas, e se o
 * ganho de recall for pequeno o lote continua melhor.
 *
 * Uso: node _medir/_transcrever-pagina-por-pagina.js [quantos]
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
const QUANTOS = parseInt(process.argv[2], 10) || 12;
const MODELO = 'gpt-4.1-mini';
const PRECO = [0.40, 1.60];
const MAX_PG = 4;   // teto de páginas por documento, para o custo não explodir

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

async function pedirTranscricao(imagensB64, rotulo) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    const content = imagensB64.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }));
    content.push({ type: 'text', text: `Transcreva o texto ${rotulo}.` });
    const r = await callOpenAI(key, {
        model: MODELO, temperature: 0, max_tokens: 8000,
        messages: [{ role: 'system', content: PROMPT_TRANSCRICAO }, { role: 'user', content }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { texto: body?.choices?.[0]?.message?.content ?? '', uso: body.usage || {} };
}

// (a) LOTE — todas as páginas numa chamada (o controle)
async function transLote(imgs) {
    const r = await pedirTranscricao(imgs, 'desta(s) página(s)');
    return r.erro ? r : { texto: r.texto, uso: r.uso, chamadas: 1 };
}

// (b) POR PÁGINA — uma chamada por página, concatenadas na ORDEM.
// O separador "=== página N ===" é deliberado: o FULL_PROMPT recebe o texto de um
// documento só, e sem marca de página um valor da pág. 2 pode ser lido como
// continuação de um rótulo da pág. 1. A marca também deixa a perda visível.
async function transPorPagina(imgs) {
    const partes = [];
    let tokIn = 0, tokOut = 0;
    for (let i = 0; i < imgs.length; i++) {
        const r = await pedirTranscricao([imgs[i]], `desta página (página ${i + 1} de ${imgs.length})`);
        if (r.uso) { tokIn += r.uso.prompt_tokens || 0; tokOut += r.uso.completion_tokens || 0; }
        if (r.erro) { partes.push(`=== página ${i + 1}: ERRO (${r.erro}) ===`); continue; }
        partes.push(`=== página ${i + 1} ===\n${r.texto}`);
    }
    return { texto: partes.join('\n\n'), uso: { prompt_tokens: tokIn, completion_tokens: tokOut }, chamadas: imgs.length };
}

const TOK_NUM = /\d{1,3}(?:\.\d{3})*,\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{5,}/g;
const tokensDe = s => new Set((String(s).match(TOK_NUM) || []));
const palavrasDe = s => new Set(String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length >= 5));
function recall(ref, got) {
    if (!ref.size) return null;
    let n = 0; for (const t of ref) if (got.has(t)) n++;
    return n / ref.size;
}

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
    return d ? { lido: j.normaliza(d) } : { erro: 'JSON inválido' };
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
    console.log(`LOTE × POR PÁGINA — transcrição com ${MODELO}, teto ${MAX_PG} páginas\n`);

    // Amostra com viés PROPOSITAL para documento LONGO e multi-página: é onde o
    // lote falhou (PRUDENTIAL, 32k chars, recall 18%). Medir só documento curto
    // esconderia o efeito — seria a amostra favorável à hipótese que já passa.
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 25)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    const porLayout = {};
    let curtos = 0;
    console.error('[por-pg] montando amostra (viés para documento LONGO)...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const a = j.assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await textoNativo(buf);
        const nch = texto.replace(/\s/g, '').length;
        if (nch < 200) continue;
        // No máximo 4 documentos "curtos" (1 página): a pergunta é sobre os longos.
        const curto = paginas <= 1;
        if (curto && curtos >= 4) continue;
        if (curto) curtos++;
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ buf, nome, texto, paginas, nch, g: j.gabaritos(nome) });
    }
    alvos.sort((x, y) => y.nch - x.nch);
    console.log(`amostra: ${alvos.length} documentos (${alvos.filter(a => a.paginas > 1).length} com mais de 1 página)\n`);

    const acc = { nativo: {}, lote: {}, porPg: {} };
    for (const v of Object.keys(acc)) for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    const uso = { lote: { i: 0, o: 0, ch: 0 }, porPg: { i: 0, o: 0, ch: 0 } };
    let somaL = 0, somaP = 0, n = 0;
    const linhas = [];

    for (const a of alvos) {
        console.error(`  ${String(a.paginas).padStart(2)}pg ${String(a.nch).padStart(6)}ch  ${a.nome.slice(0, 42)}`);
        let imgs;
        try { imgs = await visao.paginasEmPng(a.buf, Math.min(a.paginas, MAX_PG)); }
        catch (e) { console.error(`      rasterização falhou: ${e.message}`); continue; }
        if (!imgs.length) continue;

        const L = await transLote(imgs);
        const P = await transPorPagina(imgs);
        if (L.uso) { uso.lote.i += L.uso.prompt_tokens || 0; uso.lote.o += L.uso.completion_tokens || 0; uso.lote.ch += L.chamadas || 0; }
        if (P.uso) { uso.porPg.i += P.uso.prompt_tokens || 0; uso.porPg.o += P.uso.completion_tokens || 0; uso.porPg.ch += P.chamadas || 0; }
        if (L.erro && P.erro) { console.error('      as duas falharam'); continue; }

        const ref = tokensDe(a.texto), refP = palavrasDe(a.texto);
        const rL = L.erro ? null : recall(ref, tokensDe(L.texto));
        const rP = P.erro ? null : recall(ref, tokensDe(P.texto));
        if (rL != null && rP != null) { somaL += rL; somaP += rP; n++; }

        const eN = await extrair(prompt, a.texto, a.nome, a.paginas);
        const eL = L.erro ? { erro: L.erro } : await extrair(prompt, L.texto, a.nome, a.paginas);
        const eP = P.erro ? { erro: P.erro } : await extrair(prompt, P.texto, a.nome, a.paginas);
        const jN = eN.lido ? j.julgar(eN.lido, a.g) : null;
        const jL = eL.lido ? j.julgar(eL.lido, a.g) : null;
        const jP = eP.lido ? j.julgar(eP.lido, a.g) : null;
        if (jN) for (const c of CAMPOS) acc.nativo[c][jN[c] === 's/gab' ? 'semGab' : jN[c]]++;
        if (jL) for (const c of CAMPOS) acc.lote[c][jL[c] === 's/gab' ? 'semGab' : jL[c]]++;
        if (jP) for (const c of CAMPOS) acc.porPg[c][jP[c] === 's/gab' ? 'semGab' : jP[c]]++;

        linhas.push({
            nome: a.nome, pg: a.paginas, nch: a.nch,
            nL: L.erro ? 0 : String(L.texto).replace(/\s/g, '').length,
            nP: P.erro ? 0 : String(P.texto).replace(/\s/g, '').length,
            rL, rP, jN, jL, jP,
            vN: eN.lido && eN.lido.valor, vL: eL.lido && eL.lido.valor, vP: eP.lido && eP.lido.valor,
        });
    }

    console.log('┌─ documento a documento (ordenado por tamanho) ─────────────');
    for (const l of linhas) {
        console.log(`│ ${String(l.pg).padStart(2)}pg ${String(l.nch).padStart(6)}ch  ${l.nome.slice(0, 46)}`);
        console.log(`│   recall números:  lote=${l.rL == null ? ' —' : (l.rL * 100).toFixed(0).padStart(3) + '%'}` +
            `   por-página=${l.rP == null ? ' —' : (l.rP * 100).toFixed(0).padStart(3) + '%'}` +
            `   ${l.rP != null && l.rL != null ? (l.rP > l.rL + 0.02 ? '← MELHOROU' : l.rP < l.rL - 0.02 ? '← piorou' : '') : ''}`);
        console.log(`│   chars: nativo=${String(l.nch).padStart(6)} lote=${String(l.nL).padStart(6)} por-pg=${String(l.nP).padStart(6)}`);
        if (l.jN && l.jP) {
            console.log(`│   nativo  ` + CAMPOS.map(c => `${c[0]}${j.MARCA[l.jN[c]]}`).join(' ') + `  valor=${String(l.vN ?? '—').padStart(10)}`);
            if (l.jL) console.log(`│   lote    ` + CAMPOS.map(c => `${c[0]}${j.MARCA[l.jL[c]]}`).join(' ') + `  valor=${String(l.vL ?? '—').padStart(10)}`);
            console.log(`│   por-pg  ` + CAMPOS.map(c => `${c[0]}${j.MARCA[l.jP[c]]}`).join(' ') + `  valor=${String(l.vP ?? '—').padStart(10)}`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`1) RECALL DE NÚMEROS (n=${n})`);
    console.log(`   lote:        ${n ? (somaL / n * 100).toFixed(1) + '%' : '—'}`);
    console.log(`   por página:  ${n ? (somaP / n * 100).toFixed(1) + '%' : '—'}`);
    if (n) console.log(`   ganho:       ${((somaP - somaL) / n * 100).toFixed(1)} pontos`);

    console.log('\n2) EXTRAÇÃO PELO PIPELINE (ok/erro por campo)');
    console.log('   via          ' + CAMPOS.map(c => c.padStart(10)).join('') + '     ERROS');
    for (const v of ['nativo', 'lote', 'porPg']) {
        const cels = CAMPOS.map(c => `${acc[v][c].ok}ok/${acc[v][c].erro}e`.padStart(10));
        const errs = CAMPOS.map(c => acc[v][c].erro).reduce((s, x) => s + x, 0);
        console.log('   ' + v.padEnd(12) + cels.join('') + String(errs).padStart(10));
    }

    const conta = (key) => {
        let ig = 0, me = 0, pi = 0;
        for (const l of linhas) {
            if (!l.jN || !l[key]) continue;
            for (const c of CAMPOS) {
                const a = l.jN[c] === 'ok', b = l[key][c] === 'ok';
                if (a === b) ig++; else if (b) me++; else pi++;
            }
        }
        return { ig, me, pi };
    };
    const cL = conta('jL'), cP = conta('jP');
    console.log(`\n   contra o NATIVO:`);
    console.log(`     lote:       ${cL.ig} iguais, ${cL.me} melhor, ${cL.pi} PIOR`);
    console.log(`     por página: ${cP.ig} iguais, ${cP.me} melhor, ${cP.pi} PIOR`);

    const custo = u => ((u.i / 1e6) * PRECO[0] + (u.o / 1e6) * PRECO[1]);
    const nd = Math.max(1, linhas.length);
    console.log(`\n3) CUSTO (amostra de ${linhas.length} documentos)`);
    for (const [rot, u] of [['lote', uso.lote], ['por página', uso.porPg]]) {
        const c = custo(u);
        console.log(`   ${rot.padEnd(12)} ${String(u.ch).padStart(3)} chamadas   US$ ${(c / nd).toFixed(5)}/doc   →  1.037 docs ≈ US$ ${(c / nd * 1037).toFixed(2)}`);
    }

    console.log('\nPor página só vence se o ganho de recall virar ganho de CAMPO.');
    console.log('Mais chamadas por documento é custo real; recall sozinho não paga.');
    process.exit(0);
})();
