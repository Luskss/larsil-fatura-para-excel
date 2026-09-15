/**
 * _medir/_prompt-texto-variantes.js — consertar o PROMPT, não trocar a via.
 *
 * ── O que este script testa ──────────────────────────────────────────────────
 * [[visao-nao-substitui-texto-nativo]] reprovou a imagem e deixou 4 erros na
 * produção, todos concentrados em `poluida` (contrato de financiamento) e `multi`
 * (pacote com boleto). Duas hipóteses, as opções (2) e (3) da conversa:
 *
 *   (2) EMITENTE — o prompt de texto proíbe "o PAGADOR" em abstrato mas NUNCA
 *       nomeia LARSIL. O prompt de VISÃO nomeia ("LARSIL ... é sempre o TOMADOR,
 *       nunca o emitente") e acerta os 2 casos em que o texto devolveu LARSIL.
 *       A correção é uma linha, e é copiar o que já funciona na outra via.
 *
 *   (3) VALOR em contrato — a regra atual é "valor total do documento", que num
 *       leasing é LITERALMENTE o "Valor Total dos Bens e/ou Serviços" (241.817,40
 *       onde o lançamento é 7.064,44). O prompt de visão tem a regra de parcela
 *       ("NUNCA use saldo devedor, valor do contrato ou total financiado"); o de
 *       texto não tem. Mesma correção: trazer para cá o que lá já existe.
 *
 * ── Por que 4 variantes e não 2 ──────────────────────────────────────────────
 * [[modelo-visao-medido-nao-suposto]] registra que prompt melhor NÃO é
 * universalmente melhor: o v2 que tirou 2 erros do `mini` ADICIONOU 2 no `nano`.
 * Então cada conserto é medido ISOLADO e depois JUNTO, para saber se um estraga o
 * outro:
 *
 *   v0  = FULL_PROMPT como está hoje (o controle)
 *   v1  = v0 + regra LARSIL                     (só a opção 2)
 *   v2  = v0 + regra de parcela em contrato      (só a opção 3)
 *   v12 = v0 + as duas                           (a candidata)
 *
 * ── A trava contra auto-engano ───────────────────────────────────────────────
 * [[gabarito-frouxo-inventa-erro]]: um gabarito frouxo INVERTE resultado. Este
 * script usa os MESMOS julgadores auditados de `_multicampo-texto-vs-imagem.js`,
 * importados, não recopiados — se eu ajustar a régua lá, ela muda aqui também.
 *
 * E mede as DUAS metades: o consertoConsertou, mas também o que ele QUEBROU. Um
 * prompt mais específico pode passar a recusar emitente legítimo.
 *
 * Uso: node _medir/_prompt-texto-variantes.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 28;
const MODELO = 'gpt-4o-mini';          // o da produção; trocar modelo é outra medição
const PRECO = [0.15, 0.60];

// ── Os dois remendos ─────────────────────────────────────────────────────────
// Texto CURTO e no lugar certo do prompt, não um parágrafo novo no fim: o
// FULL_PROMPT é organizado por seções numeradas e a instrução precisa estar na
// seção do campo, senão o modelo a lê como observação geral.

// (2) Nomear LARSIL. Copiado do prompt de _nf-visao.js, que já acerta esses casos.
const REMENDO_LARSIL = `• ⛔ LARSIL (qualquer variação: LARSIL FLORESTAL, LARSIL SERVICOS FLORESTAIS,
     LARSIL SERV FLORESTAIS) é SEMPRE o TOMADOR/PAGADOR — NUNCA o emitente. Se o
     único nome que você encontrar for LARSIL, devolva "" em emitente.
     Num PDF que junta CONTRATO + nota anexa, o emitente é a contraparte do
     contrato (o banco/arrendadora), não o fabricante da nota do bem.`;

// (3) Parcela em contrato de financiamento/leasing. A regra de valor do prompt de
// visão, adaptada: lá fala de extrato, aqui de contrato.
const REMENDO_PARCELA = `• ⛔ CONTRATO de financiamento, leasing, arrendamento, empréstimo ou consórcio:
     valorTotal é o valor DESTA PARCELA / DESTE pagamento, NUNCA o valor da
     operação inteira. NÃO use: "Valor Total dos Bens e/ou Serviços", "Valor
     Principal do Crédito", "Valor Operação", "Valor Total Estimado do
     Arrendamento", "Valor Total Devido no Ato da Contratação", "saldo devedor",
     "total financiado". Se a página só traz o total da operação e nenhuma
     parcela, devolva 0 — melhor vazio que o número errado.`;

function montarVariantes() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    const m = src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/);
    if (!m) throw new Error('não achei FULL_PROMPT — fonte mudou?');
    const v0 = m[1];

    // Âncoras: as linhas EXATAS do prompt de hoje, depois das quais o remendo entra.
    // Se o prompt mudar, o script falha alto em vez de medir o v0 quatro vezes —
    // que foi o modo de falha de [[cache-esconde-mudanca-de-extracao]].
    const ancoraEmit = '• ⛔ NUNCA confunda com o DESTINATÁRIO/TOMADOR/PAGADOR (o cliente que paga).';
    const ancoraValor = '                  Em boleto, é o valor a pagar; em NF, o "VALOR TOTAL DA NOTA".';
    for (const [rot, a] of [['emitente', ancoraEmit], ['valor', ancoraValor]])
        if (!v0.includes(a)) throw new Error(`âncora de ${rot} não achada no FULL_PROMPT — ajuste o script`);

    const comLarsil  = s => s.replace(ancoraEmit,  ancoraEmit  + '\n' + REMENDO_LARSIL);
    const comParcela = s => s.replace(ancoraValor, ancoraValor + '\n' + REMENDO_PARCELA);

    return {
        v0,
        v1:  comLarsil(v0),
        v2:  comParcela(v0),
        v12: comParcela(comLarsil(v0)),
    };
}

function listar(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}
const ehAnexo = n => /^\s*\d+\s*[.\-]\s*CPV\b/i.test(n) || /^0+\s*[.\-]/.test(n);

async function lerPdf(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { const r = await pr.getText(); return { texto: r.text || '', paginas: r.total || 0 }; }
    catch (e) { return { texto: '', paginas: 0 }; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

async function pedir(prompt, texto, nome, paginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    let t = String(texto || '');
    if (!t.replace(/\s/g, '').length) return { erro: 'PDF sem texto nativo' };
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: MODELO, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: prompt },
                   { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let d = null;
    try { d = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { d = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return d ? { dados: d, uso: body.usage || {} } : { erro: 'JSON inválido', uso: body.usage || {} };
}

const CAMPOS = j.CAMPOS;
const VARIANTES = ['v0', 'v1', 'v2', 'v12'];
const ROTULO = { v0: 'v0 (hoje)', v1: 'v1 +larsil', v2: 'v2 +parcela', v12: 'v12 ambos' };

(async () => {
    const P = montarVariantes();
    console.log(`modelo: ${MODELO}   variantes: ${VARIANTES.length}`);
    console.log(`tamanho do prompt: v0=${P.v0.length}  v12=${P.v12.length} chars\n`);

    // Amostra dirigida: os casos difíceis é que decidem. Cota maior em `poluida`
    // (onde estão os erros de valor) e `multi` — mas `normal` tem que entrar para
    // detectar REGRESSÃO: o remendo pode estragar o que já funcionava.
    const COTA = { poluida: 10, multi: 8, normal: 6, semvalor: 4 };
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 20)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    const porDif = {}, porLayout = {};
    console.error('[prompt] montando amostra...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const a = j.assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await lerPdf(buf);
        if (texto.replace(/\s/g, '').length < 15) continue;   // imagem não é desta medição
        const dif = j.dificuldade(nome, texto, true);
        if ((porDif[dif] || 0) >= (COTA[dif] || 0)) continue;
        porDif[dif] = (porDif[dif] || 0) + 1;
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ nome, texto, paginas, dif, g: j.gabaritos(nome) });
    }
    console.log(`amostra: ${alvos.length}   ` + Object.entries(porDif).map(([k, v]) => `${k}=${v}`).join('  '));
    console.log('gabarito: ' + CAMPOS.map(c => `${c}=${alvos.filter(a => j.temGab(a.g, c)).length}`).join('  ') + '\n');

    const acc = {}, uso = {};
    for (const v of VARIANTES) {
        acc[v] = {}; uso[v] = { tokIn: 0, tokOut: 0, falhas: 0 };
        for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    }
    const linhas = [];

    for (const a of alvos) {
        console.error(`  [${a.dif}] ${a.nome.slice(0, 44)}`);
        const reg = { nome: a.nome, dif: a.dif, g: a.g, r: {} };
        for (const v of VARIANTES) {
            const r = await pedir(P[v], a.texto, a.nome, a.paginas);
            if (r.uso) { uso[v].tokIn += r.uso.prompt_tokens || 0; uso[v].tokOut += r.uso.completion_tokens || 0; }
            if (r.erro) {
                uso[v].falhas++;
                for (const c of CAMPOS) acc[v][c][j.temGab(a.g, c) ? 'vazio' : 'semGab']++;
                reg.r[v] = { erro: r.erro };
                continue;
            }
            const lido = j.normaliza(r.dados);
            const ver = j.julgar(lido, a.g);
            for (const c of CAMPOS) acc[v][c][ver[c] === 's/gab' ? 'semGab' : ver[c]]++;
            reg.r[v] = { j: ver, lido };
        }
        linhas.push(reg);
    }

    // ── o que MUDOU do v0 para cada variante ────────────────────────────────
    console.log('┌─ mudanças em relação ao v0 ────────────────────────────────');
    let nMud = 0;
    for (const l of linhas) {
        const A = l.r.v0;
        if (!A || !A.j) continue;
        const mudou = VARIANTES.slice(1).some(v => l.r[v] && l.r[v].j && CAMPOS.some(c => l.r[v].j[c] !== A.j[c]));
        if (!mudou) continue;
        nMud++;
        console.log(`│ [${l.dif}] ${l.nome.slice(0, 52)}`);
        console.log(`│   gabarito: valor=${l.g.valor ?? '—'}  emit="${(l.g.emitente || '—').slice(0, 24)}"`);
        for (const v of VARIANTES) {
            const r = l.r[v];
            if (!r) continue;
            if (r.erro) { console.log(`│   ${ROTULO[v].padEnd(13)} ERRO: ${String(r.erro).slice(0, 36)}`); continue; }
            const marcas = CAMPOS.map(c => {
                const mudou2 = v !== 'v0' && A.j && r.j[c] !== A.j[c];
                return `${c[0]}${j.MARCA[r.j[c]]}${mudou2 ? '!' : ' '}`;
            }).join(' ');
            console.log(`│   ${ROTULO[v].padEnd(13)} ${marcas}  valor=${String(r.lido.valor ?? '—').padStart(10)}  "${String(r.lido.emitente || '—').slice(0, 20)}"`);
        }
    }
    if (!nMud) console.log('│ (nenhuma mudança — os remendos não alteraram nada)');
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`ÍNDICE por variante (n = ${alvos.length})`);
    console.log('variante       ERROS  (valor  num  data  emit)   parc  vazio  US$/1.000');
    for (const v of VARIANTES) {
        const por = CAMPOS.map(c => acc[v][c].erro);
        const errs = por.reduce((s, n) => s + n, 0);
        const parc = CAMPOS.map(c => acc[v][c].parcela).reduce((s, n) => s + n, 0);
        const vaz  = CAMPOS.map(c => acc[v][c].vazio).reduce((s, n) => s + n, 0);
        const custo = (((uso[v].tokIn / alvos.length) / 1e6) * PRECO[0] + ((uso[v].tokOut / alvos.length) / 1e6) * PRECO[1]) * 1000;
        console.log(ROTULO[v].padEnd(14) + String(errs).padStart(5) + '   (' +
            por.map(n => String(n).padStart(5)).join('') + ')' +
            String(parc).padStart(7) + String(vaz).padStart(7) + ('  US$' + custo.toFixed(2)).padStart(12));
    }

    // ── as duas metades: consertou E quebrou ────────────────────────────────
    console.log('\n── contra o v0: CONSERTOU × QUEBROU ─────────────────────────');
    for (const v of VARIANTES.slice(1)) {
        let g = 0, p = 0; const det = [];
        for (const l of linhas) {
            const A = l.r.v0, B = l.r[v];
            if (!A || !B || !A.j || !B.j) continue;
            for (const c of CAMPOS) {
                const bomA = A.j[c] === 'ok', bomB = B.j[c] === 'ok';
                if (bomB && !bomA) { g++; det.push(`   + ${c.padEnd(9)} ${l.nome.slice(0, 42)}  (v0: ${A.j[c]} → ok)`); }
                if (bomA && !bomB) { p++; det.push(`   − ${c.padEnd(9)} ${l.nome.slice(0, 42)}  (ok → ${B.j[c]})`); }
            }
        }
        console.log(`${ROTULO[v].padEnd(13)} CONSERTOU ${String(g).padStart(2)}   QUEBROU ${String(p).padStart(2)}   líquido ${g - p > 0 ? '+' : ''}${g - p}`);
        for (const d of det) console.log(d);
    }

    console.log('\nO líquido decide. Prompt mais específico pode recusar dado legítimo:');
    console.log('a coluna QUEBROU é a que reprova (ver [[inspecao-anima-medicao-decide]]).');
    process.exit(0);
})();
