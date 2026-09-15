/**
 * _medir/_transcrever-pdf-imagem.js — transcrição nos PDF-IMAGEM (o caso que importa).
 *
 * ── Onde estamos ─────────────────────────────────────────────────────────────
 * O usuário pediu, desde o início, mandar o documento à IA para ela TRANSCREVER —
 * a IA no lugar do OCR, não no lugar do extrator. Duas medições já feitas:
 *
 *   `_transcrever-vs-extrair.js`      transcrever ≫ extrair (4 erros × 11)
 *   `_transcrever-pagina-por-pagina`  por página empata com o texto NATIVO
 *                                     (2 erros × 2, 40 campos iguais, 0 pior)
 *
 * As duas rodaram em PDFs COM texto nativo, porque ali existe VERDADE para comparar.
 * Mas é justamente onde a transcrição não serve: o texto real já está lá e é melhor.
 *
 * ── O caso que importa ───────────────────────────────────────────────────────
 * 1.037 dos 2.221 PDFs de 03.2026 são IMAGEM. Hoje, com o OCR fora do ar, eles
 * rendem ZERO campo — e mesmo com OCR de pé a medição de 10/09 deu 0 campos em 10
 * documentos. Aqui o critério NÃO é "empatar com o nativo" (não existe nativo), é:
 *
 *     a transcrição + pipeline extrai campos CERTOS, conferidos pelo nome do arquivo?
 *
 * Gabarito: `_julgar-campos.js` (valor/número/data/emitente contra o nome), a mesma
 * régua auditada das outras medições. `ERRO` é o que decide; `vazio` é lacuna.
 *
 * ── As três vias ─────────────────────────────────────────────────────────────
 *   (a) hoje        — o que o pipeline extrai HOJE desses PDFs (texto vazio →
 *                     nada, ou o que a IA inventa do nome do arquivo)
 *   (b) transcrever — transcrição por página + FULL_PROMPT (a proposta do usuário)
 *   (c) visão       — extração direta de campos da imagem (o que EU testei antes,
 *                     para ver se a separação transcrever/extrair ganha aqui também)
 *
 * SOMENTE LEITURA — não grava no banco.
 *
 * Uso: node _medir/_transcrever-pdf-imagem.js [quantos]
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
const QUANTOS = parseInt(process.argv[2], 10) || 16;
const MODELO_TRANS = 'gpt-4.1-mini';
const PRECO_TRANS = [0.40, 1.60];
const MAX_PG = 3;

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

async function nativo(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const r = await pr.getText();
        return { texto: (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' '), paginas: r.total || 1 };
    } catch (e) { return { texto: '', paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

async function umaPagina(b64, i, total) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    const r = await callOpenAI(key, {
        model: MODELO_TRANS, temperature: 0, max_tokens: 8000,
        messages: [
            { role: 'system', content: PROMPT_TRANSCRICAO },
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                { type: 'text', text: `Transcreva o texto desta página (página ${i} de ${total}).` },
            ] },
        ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { texto: body?.choices?.[0]?.message?.content ?? '', uso: body.usage || {} };
}

// Transcrição POR PÁGINA — a variante que empatou com o texto nativo.
async function transcrever(buf, maxPg) {
    let imgs;
    try { imgs = await visao.paginasEmPng(buf, maxPg); }
    catch (e) { return { erro: `rasterização: ${e.message}` }; }
    if (!imgs.length) return { erro: 'nenhuma página rasterizada' };
    const partes = [];
    let i0 = 0, o0 = 0, falhas = 0;
    for (let i = 0; i < imgs.length; i++) {
        const r = await umaPagina(imgs[i], i + 1, imgs.length);
        if (r.uso) { i0 += r.uso.prompt_tokens || 0; o0 += r.uso.completion_tokens || 0; }
        if (r.erro) { falhas++; continue; }
        partes.push(`=== página ${i + 1} ===\n${r.texto}`);
    }
    if (!partes.length) return { erro: 'todas as páginas falharam' };
    return { texto: partes.join('\n\n'), uso: { i: i0, o: o0 }, nPg: imgs.length, falhas };
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
const VIAS = ['hoje', 'transcrito', 'visao'];

(async () => {
    const prompt = promptExtracao();
    console.log(`PDF-IMAGEM: transcrição por página × visão direta × hoje`);
    console.log(`modelo de transcrição: ${MODELO_TRANS}   extração: gpt-4o-mini\n`);

    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 12)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    // PDF-IMAGEM (0 texto) e COM gabarito no nome — sem gabarito não há como
    // julgar quem acertou, e o documento só gastaria chamada.
    const alvos = [];
    const porLayout = {};
    console.error('[imagem] selecionando PDF-imagem com gabarito...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const g = j.gabaritos(nome);
        if (g.valor == null) continue;
        const a = j.assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await nativo(buf);
        if (texto.replace(/\s/g, '').length >= 15) continue;   // tem texto: não é o caso
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ buf, nome, paginas, g });
    }
    console.log(`PDF-imagem selecionados: ${alvos.length}`);
    console.log('gabarito: ' + CAMPOS.map(c => `${c}=${alvos.filter(a => j.temGab(a.g, c)).length}`).join('  ') + '\n');

    const acc = {};
    for (const v of VIAS) { acc[v] = {}; for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 }; }
    const uso = { i: 0, o: 0, nCh: 0 };
    const linhas = [];
    let comCampo = { hoje: 0, transcrito: 0, visao: 0 };

    for (const a of alvos) {
        console.error(`  ${String(a.paginas).padStart(2)}pg  ${a.nome.slice(0, 48)}`);
        const reg = { nome: a.nome, pg: a.paginas, g: a.g, r: {} };

        // (a) HOJE: o pipeline recebe o texto vazio do PDF-imagem.
        const eH = await extrair(prompt, '', a.nome, a.paginas);
        reg.r.hoje = eH.erro ? { erro: eH.erro } : { j: j.julgar(eH.lido, a.g), lido: eH.lido };

        // (b) TRANSCREVER + pipeline (a proposta do usuário)
        const t = await transcrever(a.buf, Math.min(a.paginas || 1, MAX_PG));
        if (t.uso) { uso.i += t.uso.i; uso.o += t.uso.o; uso.nCh += t.nPg || 0; }
        if (t.erro) reg.r.transcrito = { erro: t.erro };
        else {
            reg.nTrans = String(t.texto).replace(/\s/g, '').length;
            const eT = await extrair(prompt, t.texto, a.nome, a.paginas);
            reg.r.transcrito = eT.erro ? { erro: eT.erro } : { j: j.julgar(eT.lido, a.g), lido: eT.lido };
        }

        // (c) VISÃO direta (o que eu tinha testado)
        let vr;
        try { vr = await visao.lerPorVisao(a.buf, a.nome, a.g.valor, 'openai', MODELO_TRANS); }
        catch (e) { vr = { erro: e.message }; }
        if (vr.erro) reg.r.visao = { erro: vr.erro };
        else {
            const lido = {
                emitente: vr.campos['Emitente'],
                numero: vr.campos['Número do documento'],
                data: vr.campos['Data de emissão'],
                valor: j.num(vr.campos['Valor total']) ?? j.num(vr.campos['Valor lido (não confere com o nome)']),
            };
            reg.r.visao = { j: j.julgar(lido, a.g), lido };
        }

        for (const v of VIAS) {
            const r = reg.r[v];
            if (!r || !r.j) { for (const c of CAMPOS) acc[v][c][j.temGab(a.g, c) ? 'vazio' : 'semGab']++; continue; }
            for (const c of CAMPOS) acc[v][c][r.j[c] === 's/gab' ? 'semGab' : r.j[c]]++;
            if (CAMPOS.some(c => r.j[c] === 'ok')) comCampo[v]++;
        }
        linhas.push(reg);
    }

    console.log('┌─ documento a documento ────────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ ${String(l.pg).padStart(2)}pg ${l.nome.slice(0, 54)}`);
        console.log(`│    gabarito: valor=${l.g.valor ?? '—'}  nº=${l.g.numero ?? '—'}  emit="${(l.g.emitente || '—').slice(0, 20)}"` +
            (l.nTrans ? `   transcrito: ${l.nTrans} chars` : ''));
        for (const v of VIAS) {
            const r = l.r[v];
            if (!r) continue;
            if (r.erro) { console.log(`│    ${v.padEnd(11)} ERRO: ${String(r.erro).slice(0, 40)}`); continue; }
            console.log(`│    ${v.padEnd(11)} ` + CAMPOS.map(c => `${c[0]}${j.MARCA[r.j[c]]}`).join(' ') +
                `   valor=${String(r.lido.valor ?? '—').padStart(11)}  "${String(r.lido.emitente || '—').slice(0, 18)}"`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`ÍNDICE EM PDF-IMAGEM (n = ${alvos.length})`);
    for (const c of CAMPOS) {
        console.log(`── ${c.toUpperCase()}`);
        console.log('   via            ok  ERRO  ~parc  ·vazio  s/gab');
        for (const v of VIAS) {
            const x = acc[v][c];
            console.log('   ' + v.padEnd(13) + String(x.ok).padStart(3) + String(x.erro).padStart(6) +
                String(x.parcela).padStart(7) + String(x.vazio).padStart(8) + String(x.semGab).padStart(7));
        }
    }

    console.log('\n── TOTAIS ──────────────────────────────────────────────────');
    for (const v of VIAS) {
        const ok = CAMPOS.map(c => acc[v][c].ok).reduce((s, n) => s + n, 0);
        const er = CAMPOS.map(c => acc[v][c].erro).reduce((s, n) => s + n, 0);
        const pa = CAMPOS.map(c => acc[v][c].parcela).reduce((s, n) => s + n, 0);
        const vz = CAMPOS.map(c => acc[v][c].vazio).reduce((s, n) => s + n, 0);
        console.log(`${v.padEnd(12)} ok=${String(ok).padStart(3)}  ERRO=${String(er).padStart(3)}  parcela=${String(pa).padStart(2)}  vazio=${String(vz).padStart(3)}  documentos com algum campo certo=${comCampo[v]}/${alvos.length}`);
    }

    // As duas metades contra o estado ATUAL — é o que decide, porque hoje é zero.
    console.log('\n── contra HOJE, campo a campo ──────────────────────────────');
    for (const v of ['transcrito', 'visao']) {
        let g = 0, p = 0;
        for (const l of linhas) {
            const A = l.r.hoje, B = l.r[v];
            if (!A || !B || !A.j || !B.j) continue;
            for (const c of CAMPOS) {
                if (B.j[c] === 'ok' && A.j[c] !== 'ok') g++;
                if (A.j[c] === 'ok' && B.j[c] !== 'ok') p++;
            }
        }
        console.log(`${v.padEnd(12)} GANHA ${String(g).padStart(3)}   PERDE ${String(p).padStart(3)}   líquido ${g - p > 0 ? '+' : ''}${g - p}`);
    }

    const custo = (uso.i / 1e6) * PRECO_TRANS[0] + (uso.o / 1e6) * PRECO_TRANS[1];
    const nd = Math.max(1, alvos.length);
    console.log(`\nCUSTO da transcrição: ${uso.nCh} chamadas  US$ ${(custo / nd).toFixed(5)}/doc`);
    console.log(`   → 1.037 PDF-imagem de 03.2026 ≈ US$ ${(custo / nd * 1037).toFixed(2)}`);
    console.log('\nAqui HOJE é praticamente zero: o critério é quanto se GANHA, não empatar.');
    process.exit(0);
})();
