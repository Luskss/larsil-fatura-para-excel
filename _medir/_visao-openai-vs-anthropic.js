/**
 * _medir/_visao-openai-vs-anthropic.js — qual provider lê melhor a IMAGEM?
 *
 * A medição de §15.10 usou Anthropic (Haiku 4.5), mas o provider ATIVO em
 * `config/settings.json` é openai (GPT-4o-mini). Ao testar a rota com um PDF real,
 * o GPT errou o formato numérico — "17.904,40" virou 17,90 — o que a medição
 * anterior não teria mostrado. Rodar a produção com um provider medido em outro é
 * confiar em número que não vale para o caso.
 *
 * Este script roda os DOIS sobre os MESMOS documentos e compara pelo único
 * gabarito disponível: o valor no NOME DO ARQUIVO, digitado à mão pela equipe a
 * partir do papel.
 *
 * O que decide não é "quem preenche mais campos" e sim **quem erra menos o valor**:
 * campo vazio é lacuna visível, valor errado é dano silencioso.
 *
 * Uso: node _medir/_visao-openai-vs-anthropic.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');
const visao = require('../routes/_nf-visao');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 20;

// `lerPorVisao` aceita o provider como 4º argumento. A primeira versão deste
// script tentou monkey-patch de `getActiveAiProvider`, e NÃO funcionaria: o
// _nf-visao desestrutura a função no require, congelando a referência — o teste
// teria rodado openai duas vezes e "provado" que os dois são idênticos.

function valorDoNomeArquivo(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
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

async function ehImagem(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { return ((await pr.getText()).text || '').replace(/\s/g, '').length < 15; }
    catch (e) { return false; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

const val = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
};

(async () => {
    // Amostra espalhada pela pasta (a ordem agrupa por banco; pegar os N primeiros
    // enviesa — no primeiro teste vieram 4 documentos da CAIXA seguidos).
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 8)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    console.error('[cmp] selecionando PDFs-imagem...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const buf = fs.readFileSync(abs);
        if (await ehImagem(buf)) alvos.push({ abs, buf, nome: path.basename(abs) });
    }
    console.log(`PDFs-imagem: ${alvos.length}\n`);

    const acc = {
        openai:    { bate: 0, parcela: 0, diverge: 0, semGab: 0, erro: 0, campos: 0, data: 0, emit: 0 },
        anthropic: { bate: 0, parcela: 0, diverge: 0, semGab: 0, erro: 0, campos: 0, data: 0, emit: 0 },
    };
    const linhas = [];

    for (const { buf, nome } of alvos) {
        const gab = valorDoNomeArquivo(nome);
        console.error(`  ${nome.slice(0, 52)}`);
        const reg = { nome, gab, r: {} };

        for (const prov of ['openai', 'anthropic']) {
            let r;
            try { r = await visao.lerPorVisao(buf, nome, gab, prov); }
            catch (e) { r = { erro: e.message }; }
            const a = acc[prov];
            if (r.erro) { a.erro++; reg.r[prov] = { erro: r.erro }; continue; }

            a.campos += Object.keys(r.campos).length;
            if (r.campos['Data de emissão']) a.data++;
            if (r.campos['Emitente']) a.emit++;
            a[r.veredito === 'bate' ? 'bate' : r.veredito === 'parcela' ? 'parcela'
              : r.veredito === 'diverge' ? 'diverge' : 'semGab']++;

            reg.r[prov] = {
                veredito: r.veredito,
                valor: val(r.campos['Valor total']) ?? val(r.campos['Valor lido (não confere com o nome)']),
                tipo: r.tipo,
                origem: r.campos['Origem do valor (visão)'],
                nCampos: Object.keys(r.campos).length,
            };
        }
        linhas.push(reg);
    }

    console.log('┌─ documento a documento ────────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ ${l.nome.slice(0, 58)}`);
        console.log(`│   gabarito (nome): ${l.gab ?? '—'}`);
        for (const prov of ['openai', 'anthropic']) {
            const r = l.r[prov];
            if (!r) continue;
            if (r.erro) { console.log(`│   ${prov.padEnd(10)} ERRO: ${String(r.erro).slice(0, 44)}`); continue; }
            const marca = r.veredito === 'bate' ? '✓' : r.veredito === 'diverge' ? '✗' : '·';
            console.log(`│   ${prov.padEnd(10)} ${marca} ${String(r.veredito).padEnd(12)} ` +
                        `valor=${String(r.valor ?? '—').padStart(11)}  campos=${r.nCampos}  ${String(r.tipo || '').slice(0, 8)}`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    const linha = (rot, a) =>
        `${rot.padEnd(11)} bate ${String(a.bate).padStart(3)}   parcela ${String(a.parcela).padStart(2)}   ` +
        `DIVERGE ${String(a.diverge).padStart(3)}   sem-gabarito ${String(a.semGab).padStart(2)}   ` +
        `erro ${String(a.erro).padStart(2)}   campos ${String(a.campos).padStart(4)}`;
    console.log('RESUMO (n = ' + alvos.length + ')');
    console.log(linha('openai', acc.openai));
    console.log(linha('anthropic', acc.anthropic));
    console.log(`\nemitente preenchido:  openai ${acc.openai.emit}  ·  anthropic ${acc.anthropic.emit}`);
    console.log(`data plausível:       openai ${acc.openai.data}  ·  anthropic ${acc.anthropic.data}`);

    // O número que decide.
    const conf = a => a.bate + a.parcela;
    console.log(`\nvalores CONFIRMADOS pelo gabarito:  openai ${conf(acc.openai)}  ·  anthropic ${conf(acc.anthropic)}`);
    console.log(`valores DIVERGENTES:                openai ${acc.openai.diverge}  ·  anthropic ${acc.anthropic.diverge}`);
    console.log('\nCampo vazio é lacuna visível; valor errado é dano silencioso.');
    console.log('Entre os dois, o que importa é DIVERGE — não a contagem de campos.');
    process.exit(0);
})();
