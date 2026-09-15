/**
 * _medir/_visao-modelos.js — qual MODELO lê melhor a imagem, por real gasto?
 *
 * §15.12 comparou providers (openai × anthropic) e o gpt-4o-mini perdeu por
 * deformar números. Mas o 4o-mini não é o único openai barato: o catálogo tem
 * `gpt-4.1-mini` (US$ 0,40/1,60 por MTok) e `gpt-4.1-nano` (US$ 0,10/0,40), de
 * geração mais nova — plausível que corrijam o erro de formato. Plausível não é
 * medido, daí este script.
 *
 * Roda N modelos sobre os MESMOS PDFs-imagem e confere pelo mesmo gabarito: o
 * valor no NOME DO ARQUIVO, digitado à mão pela equipe a partir do papel.
 *
 * O que decide continua sendo **DIVERGE**, não campos preenchidos nem preço:
 * campo vazio é lacuna visível, valor errado é dano silencioso. O custo entra
 * como desempate quando a qualidade empata.
 *
 * Uso: node _medir/_visao-modelos.js [quantos]
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

// [rótulo, provider, modelo, US$/MTok entrada, US$/MTok saída]
// Preços consultados em developers.openai.com/api/docs/pricing e na tabela da
// skill claude-api, ambos em 10/09/2026.
const MODELOS = [
    ['gpt-4.1-nano', 'openai',    'gpt-4.1-nano',              0.10, 0.40],
    ['gpt-4.1-mini', 'openai',    'gpt-4.1-mini',              0.40, 1.60],
    ['haiku-4.5',    'anthropic', 'claude-haiku-4-5-20251001', 1.00, 5.00],
];

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
    const todos = listar(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 8)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const alvos = [];
    console.error('[modelos] selecionando PDFs-imagem...');
    for (const abs of ordem) {
        if (alvos.length >= QUANTOS) break;
        const buf = fs.readFileSync(abs);
        if (await ehImagem(buf)) alvos.push({ buf, nome: path.basename(abs) });
    }
    console.log(`PDFs-imagem: ${alvos.length}\n`);

    const acc = {};
    for (const [rot] of MODELOS) acc[rot] = { bate: 0, parcela: 0, diverge: 0, semGab: 0, erro: 0, campos: 0, tokIn: 0, tokOut: 0 };
    const linhas = [];

    for (const { buf, nome } of alvos) {
        const gab = valorDoNomeArquivo(nome);
        console.error(`  ${nome.slice(0, 50)}`);
        const reg = { nome, gab, r: {} };

        for (const [rot, prov, modelo] of MODELOS) {
            let r;
            try { r = await visao.lerPorVisao(buf, nome, gab, prov, modelo); }
            catch (e) { r = { erro: e.message }; }
            const a = acc[rot];
            if (r.uso) {
                a.tokIn  += r.uso.input_tokens  || r.uso.prompt_tokens     || 0;
                a.tokOut += r.uso.output_tokens || r.uso.completion_tokens || 0;
            }
            if (r.erro) { a.erro++; reg.r[rot] = { erro: r.erro }; continue; }
            a.campos += Object.keys(r.campos).length;
            a[r.veredito === 'bate' ? 'bate' : r.veredito === 'parcela' ? 'parcela'
              : r.veredito === 'diverge' ? 'diverge' : 'semGab']++;
            reg.r[rot] = {
                veredito: r.veredito,
                valor: val(r.campos['Valor total']) ?? val(r.campos['Valor lido (não confere com o nome)']),
                nCampos: Object.keys(r.campos).length,
            };
        }
        linhas.push(reg);
    }

    console.log('┌─ documento a documento ────────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ ${l.nome.slice(0, 56)}   gabarito=${l.gab ?? '—'}`);
        for (const [rot] of MODELOS) {
            const r = l.r[rot];
            if (!r) continue;
            if (r.erro) { console.log(`│   ${rot.padEnd(13)} ERRO: ${String(r.erro).slice(0, 40)}`); continue; }
            const marca = r.veredito === 'bate' ? '✓' : r.veredito === 'diverge' ? '✗' : '·';
            console.log(`│   ${rot.padEnd(13)} ${marca} ${String(r.veredito).padEnd(12)} valor=${String(r.valor ?? '—').padStart(11)}  campos=${r.nCampos}`);
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    console.log(`RESUMO (n = ${alvos.length})`);
    console.log('modelo         bate  parc  DIVERGE  s/gab  erro  campos    custo/1.037');
    for (const [rot, , , ci, co] of MODELOS) {
        const a = acc[rot];
        const porDoc = alvos.length
            ? ((a.tokIn / alvos.length) / 1e6) * ci + ((a.tokOut / alvos.length) / 1e6) * co : 0;
        console.log(rot.padEnd(15) + String(a.bate).padStart(4) + String(a.parcela).padStart(6) +
            String(a.diverge).padStart(9) + String(a.semGab).padStart(7) + String(a.erro).padStart(6) +
            String(a.campos).padStart(8) + ('   US$' + (porDoc * 1037).toFixed(2)).padStart(14));
    }
    console.log('\nDIVERGE é o número que decide: valor errado é dano silencioso.');
    console.log('Custo só desempata quando a qualidade empata.');
    process.exit(0);
})();
