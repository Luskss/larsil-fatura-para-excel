/**
 * _medir/_parser-multicampo.js — o PARSER determinístico acerta os 4 campos?
 *
 * ── Por que este script existe (e por que o anterior estava errado) ──────────
 * Em `_visao-em-pdf-texto.js` eu reportei que "o parser devolveu valor em 0 de 24".
 * Isso está ERRADO, e o erro é meu: procurei as chaves `valor_total`/`valorTotal`,
 * que são o schema da IA. O parser usa rótulos EM PORTUGUÊS, com acento e símbolo:
 *
 *      'Valor total'   'Nº da NFS-e'   'Nº da NF-e'   'Nº do CT-e'
 *      'Data de emissão'   'CNPJ emitente'   'Número do documento'
 *
 * Lendo a chave errada, o parser marcaria 0 mesmo se acertasse tudo. A pergunta do
 * usuário — "o parser consegue extrair os novos campos bem?" — nunca foi respondida.
 * Este script responde, com a MESMA régua auditada das outras medições
 * (`_julgar-campos.js`), para os números serem comparáveis.
 *
 * ── O que se mede ────────────────────────────────────────────────────────────
 * O parser é encadeado como em `process-folder.js:584`:
 *     classify → parser do tipo → enriquecerComChaveAcesso → enriquecerComBoleto
 * e depois cada campo é lido pelos rótulos QUE ELE USA, com fallback entre
 * variantes (o número muda de nome conforme o tipo do documento).
 *
 * Comparado contra a IA de texto (a produção) nos mesmos documentos.
 *
 * ── O que o parser NÃO tem ───────────────────────────────────────────────────
 * `emitente` — de propósito. `extrairEmitente` lê o NOME DO ARQUIVO, não o PDF
 * (ver [[emitente-nao-vem-do-extrator]]), então conferir contra o nome seria
 * conferir o gabarito com ele mesmo: daria 100% e não significaria nada. Fica
 * marcado 's/parser' na tabela, que é honesto; os outros 3 campos valem.
 *
 * Uso: node _medir/_parser-multicampo.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const parsers = require('../routes/_nf-parsers');
const { PDFParse } = require('pdf-parse');
const { callOpenAI } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 30;
const MODELO = 'gpt-4o-mini';

// ── Os rótulos do parser, por campo ──────────────────────────────────────────
// Ordem = precedência. O número tem um rótulo por tipo de documento, e um
// documento só preenche o seu; por isso a lista e não uma chave fixa.
// A lista saiu de um grep no fonte, não da memória: minha 1ª versão esqueceu
// 'Valor total da nota' — o rótulo do DANFE, que é o tipo mais comum do acervo — e
// teria contado 'vazio' em toda NF. É o mesmo modo de falha que já me fez reportar
// "parser devolveu 0 de 24" lendo `valorTotal` (schema da IA) num parser que
// escreve em português. Conferir a chave no fonte, sempre.
//
// Ordem = precedência: o mais ESPECÍFICO primeiro. 'Valor líquido' fica por último
// porque numa nota com retenção ele é menor que o bruto de propósito, e
// 'Total trib. federais' NÃO entra — é soma de imposto, não valor do documento.
const ROTULOS = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
};

// O parser usa '—' como "não achei" (é `grab` devolvendo o traço), então string
// vazia e traço são a MESMA coisa: ausência. Tratar '—' como valor lido faria
// `jValor` receber lixo e contar 'erro' onde o certo é 'vazio'.
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
function primeiro(dados, chaves) {
    for (const k of chaves) if (dados && !VAZIO(dados[k])) return dados[k];
    return null;
}

function lerPorParser(texto, nome) {
    const c = parsers.classify(texto, nome);
    const d = parsers.enriquecerComBoleto(
        parsers.enriquecerComChaveAcesso(c.parser ? c.parser(texto) : null, texto), texto) || {};
    return {
        tipo: c.tipo,
        dados: d,
        lido: {
            valor:    j.num(primeiro(d, ROTULOS.valor)),
            numero:   primeiro(d, ROTULOS.numero),
            data:     primeiro(d, ROTULOS.data),
            emitente: null,   // não é papel do parser — ver cabeçalho
        },
        nPreenchidos: Object.values(d).filter(v => !VAZIO(v)).length,
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

async function viaIA(texto, nome, paginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'sem OPENAI_API_KEY' };
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    const m = src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/);
    if (!m) throw new Error('não achei FULL_PROMPT');
    let t = String(texto || '');
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: MODELO, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: m[1] },
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

// Só os 3 campos que o parser tenta. `emitente` sai da comparação porque o parser
// não o lê do PDF — incluí-lo puniria o parser por algo que não é função dele.
const CAMPOS = ['valor', 'numero', 'data'];

(async () => {
    const COTA = { normal: 8, poluida: 8, multi: 8, semvalor: 6 };
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 20)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    const porDif = {}, porLayout = {};
    console.error('[parser] montando amostra...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const nome = path.basename(abs);
        const a = j.assinatura(nome);
        if ((porLayout[a] || 0) >= 2) continue;
        const buf = fs.readFileSync(abs);
        const { texto, paginas } = await lerPdf(buf);
        if (texto.replace(/\s/g, '').length < 15) continue;
        const dif = j.dificuldade(nome, texto, true);
        if ((porDif[dif] || 0) >= (COTA[dif] || 0)) continue;
        porDif[dif] = (porDif[dif] || 0) + 1;
        porLayout[a] = (porLayout[a] || 0) + 1;
        alvos.push({ nome, texto, paginas, dif, g: j.gabaritos(nome) });
    }
    console.log(`amostra: ${alvos.length}   ` + Object.entries(porDif).map(([k, v]) => `${k}=${v}`).join('  '));
    console.log('gabarito: ' + CAMPOS.map(c => `${c}=${alvos.filter(a => j.temGab(a.g, c)).length}`).join('  ') + '\n');

    const VIAS = ['parser', 'ia-texto'];
    const acc = {};
    for (const v of VIAS) { acc[v] = {}; for (const c of CAMPOS) acc[v][c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 }; }
    const linhas = [];
    let somaPreenchidos = 0, tiposOk = 0;

    for (const a of alvos) {
        console.error(`  [${a.dif}] ${a.nome.slice(0, 44)}`);
        const p = lerPorParser(a.texto, a.nome);
        somaPreenchidos += p.nPreenchidos;
        if (p.tipo !== 'Não identificado') tiposOk++;
        const ia = await viaIA(a.texto, a.nome, a.paginas);

        const reg = { nome: a.nome, dif: a.dif, g: a.g, tipo: p.tipo, nPre: p.nPreenchidos, r: {} };
        for (const [via, res] of [['parser', p], ['ia-texto', ia]]) {
            if (res.erro) { for (const c of CAMPOS) acc[via][c][j.temGab(a.g, c) ? 'vazio' : 'semGab']++; reg.r[via] = { erro: res.erro }; continue; }
            const ver = j.julgar(res.lido, a.g);
            for (const c of CAMPOS) acc[via][c][ver[c] === 's/gab' ? 'semGab' : ver[c]]++;
            reg.r[via] = { j: ver, lido: res.lido };
        }
        linhas.push(reg);
    }

    // ── documento a documento, onde as duas vias DIVERGEM ───────────────────
    console.log('┌─ onde parser e IA discordam ───────────────────────────────');
    for (const l of linhas) {
        const A = l.r.parser, B = l.r['ia-texto'];
        if (!A || !B || !A.j || !B.j) continue;
        if (!CAMPOS.some(c => A.j[c] !== B.j[c])) continue;
        console.log(`│ [${l.dif}] ${l.nome.slice(0, 50)}   tipo=${l.tipo}`);
        console.log(`│   gabarito: valor=${l.g.valor ?? '—'}  nº=${l.g.numero ?? '—'}`);
        for (const [via, r] of [['parser', A], ['ia-texto', B]]) {
            console.log(`│   ${via.padEnd(9)} ` + CAMPOS.map(c => `${c[0]}${j.MARCA[r.j[c]]}`).join(' ') +
                `   valor=${String(r.lido.valor ?? '—').padStart(11)}  nº=${String(r.lido.numero ?? '—').slice(0, 12)}`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`ÍNDICE — PARSER × IA DE TEXTO (n = ${alvos.length})`);
    for (const c of CAMPOS) {
        console.log(`── ${c.toUpperCase()}`);
        console.log('   via          ok  ERRO  ~parc  ·vazio  s/gab   taxa de acerto*');
        for (const v of VIAS) {
            const x = acc[v][c];
            const julgados = x.ok + x.erro + x.parcela + x.vazio;
            const taxa = julgados ? (x.ok / julgados * 100).toFixed(0) + '%' : '—';
            console.log('   ' + v.padEnd(12) + String(x.ok).padStart(3) + String(x.erro).padStart(6) +
                String(x.parcela).padStart(7) + String(x.vazio).padStart(8) + String(x.semGab).padStart(7) +
                taxa.padStart(16));
        }
    }
    console.log('\n* entre os que TINHAM gabarito (ok / ok+erro+parcela+vazio)');

    console.log('\n── TOTAIS ───────────────────────────────────────────────────');
    for (const v of VIAS) {
        const e = CAMPOS.map(c => acc[v][c].erro).reduce((s, n) => s + n, 0);
        const o = CAMPOS.map(c => acc[v][c].ok).reduce((s, n) => s + n, 0);
        const z = CAMPOS.map(c => acc[v][c].vazio).reduce((s, n) => s + n, 0);
        const p = CAMPOS.map(c => acc[v][c].parcela).reduce((s, n) => s + n, 0);
        console.log(`${v.padEnd(10)} ok=${String(o).padStart(3)}  ERRO=${String(e).padStart(2)}  parcela=${String(p).padStart(2)}  vazio=${String(z).padStart(3)}`);
    }
    console.log(`\nparser: classificou o tipo em ${tiposOk}/${alvos.length}; ` +
                `${(somaPreenchidos / alvos.length).toFixed(1)} campos preenchidos por documento (média)`);

    // Onde o parser é a MELHOR via e onde é a pior — as duas metades.
    let pg = 0, pp = 0; const det = [];
    for (const l of linhas) {
        const A = l.r.parser, B = l.r['ia-texto'];
        if (!A || !B || !A.j || !B.j) continue;
        for (const c of CAMPOS) {
            if (A.j[c] === 'ok' && B.j[c] !== 'ok') { pg++; det.push(`   + ${c.padEnd(7)} ${l.nome.slice(0, 44)} (IA: ${B.j[c]})`); }
            if (B.j[c] === 'ok' && A.j[c] !== 'ok') { pp++; det.push(`   − ${c.padEnd(7)} ${l.nome.slice(0, 44)} (parser: ${A.j[c]})`); }
        }
    }
    console.log(`\n── parser contra a IA: GANHA ${pg}   PERDE ${pp}   líquido ${pg - pp > 0 ? '+' : ''}${pg - pp}`);
    for (const d of det) console.log(d);

    console.log('\nO parser é GRATUITO e determinístico: onde ele acerta, a chamada de IA');
    console.log('é gasto sem retorno. Onde ele deixa vazio, a IA é a única fonte.');
    process.exit(0);
})();
