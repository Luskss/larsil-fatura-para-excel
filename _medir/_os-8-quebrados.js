/**
 * _medir/_os-8-quebrados.js — os 8 de razão quebrada são erro de leitura de VALOR?
 *
 * ACHADO (21/09/2026): dos 25 pares silenciados com valor divergente, 17 (68%) são
 * parcelamento (razão inteira 2..11). Sobram 8 de razão quebrada, e 4 deles são do
 * mesmo fornecedor (BOBIG) com um padrão suspeito:
 *
 *     nome do arquivo        lançamento    valor lido no doc
 *     "2203,88 … NF3335"     2.203,88      847,21     ← nome == lançamento
 *     "782,54 … NF 3536"       782,54       82,23     ← nome == lançamento
 *     "435,33 … NF 3838"       435,33       38,01     ← nome == lançamento
 *
 * Quando NOME e PLANILHA concordam e o VALOR LIDO discorda dos dois, quem errou foi
 * a leitura. Isso não é parcela — é o extrator pegando o número errado do papel
 * (item, desconto, frete…).
 *
 * ── Importante: isso NÃO é culpa da variante C ──────────────────────────────
 * O alerta que a variante C calou era de TIPO. Este defeito é de VALOR e existe
 * independentemente — o par se formou assim mesmo (força 3, via número+entidade).
 * Mas vale saber se é um defeito de verdade e quantos são no acervo.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 *   1. o valor no NOME bate com o lançamento? (gabarito do projeto)
 *   2. se bate, o valor LIDO está errado → conta como defeito
 *   3. quantos casos assim existem no ACERVO, não só nesses 8?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();

    // o gabarito do nome: o projeto já tem essa função. usá-la em vez de reinventar
    // ([[data-como-valor-no-gabarito]] mostrou que reinventar lê data como valor)
    const valorDoNome = p.valorDoNome || null;
    console.log(`valorDoNome disponível em _pareamento? ${valorDoNome ? 'SIM' : 'NÃO — vou extrair do fonte'}`);

    let vn = valorDoNome;
    if (!vn) {
        const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_pareamento.js'), 'utf8');
        const m = src.match(/function valorDoNome[\s\S]*?\n\}/);
        if (m) {
            console.log('   (extraí valorDoNome do fonte)');
            vn = new Function('norm', `${m[0]}; return valorDoNome;`)(norm);
        }
    }
    if (!vn) { console.log('   não achei valorDoNome — abortando para não inventar régua'); process.exit(1); }

    // ── varrer TODOS os pares, não só os 8 ─────────────────────────────────
    console.log('\n── varrendo todos os pares do acervo ───────────────────────');
    let pares = 0, nomeBateLanc = 0, lidoErrado = 0;
    const casos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            pares++;
            const vL = Math.abs(Number(x.lancamento.valor) || 0);
            const vD = Math.abs(Number(x.documento.valor) || 0);
            const vNome = Math.abs(Number(vn(x.documento.arquivo)) || 0);
            if (!vL || !vD || !vNome) continue;
            // o nome concorda com o LANÇAMENTO?
            if (Math.abs(vNome - vL) > 0.02) continue;
            nomeBateLanc++;
            // ...e o valor LIDO discorda dos dois?
            if (Math.abs(vD - vL) < 0.02) continue;
            lidoErrado++;
            casos.push({ periodo, arq: x.documento.arquivo, vL, vD, vNome, forca: x.forca });
        }
    }

    console.log(`\n   pares avaliados:                       ${pares}`);
    console.log(`   com valor no nome == lançamento:       ${nomeBateLanc}`);
    console.log(`   desses, valor LIDO discorda dos dois:  ${lidoErrado}  ${pct(lidoErrado, nomeBateLanc)}`);

    console.log('\n── os casos, por fornecedor ────────────────────────────────');
    const porForn = new Map();
    for (const k of casos) {
        const m = k.arq.match(/\d{4}\.\d{2}\.\d{2}\.?\s*([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{2,24})/);
        const f = m ? norm(m[1]).trim() : '(?)';
        if (!porForn.has(f)) porForn.set(f, []);
        porForn.get(f).push(k);
    }
    for (const [f, arr] of [...porForn].sort((a, b) => b[1].length - a[1].length).slice(0, 14))
        console.log(`   ${f.slice(0, 24).padEnd(26)} ${String(arr.length).padStart(3)}`);

    console.log('\n── os 14 maiores em diferença ──────────────────────────────');
    for (const k of casos.sort((a, b) => Math.abs(b.vL - b.vD) - Math.abs(a.vL - a.vD)).slice(0, 14)) {
        console.log(`\n   ${k.periodo}  força ${k.forca}`);
        console.log(`      nome=${brl(k.vNome).padStart(14)}  lanç=${brl(k.vL).padStart(14)}  LIDO=${brl(k.vD).padStart(14)}`);
        console.log(`      ${k.arq.slice(0, 64)}`);
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(74));
    console.log(`\n   ${lidoErrado} pares onde nome e planilha concordam e o valor LIDO discorda.`);
    console.log('   Esses são candidatos a defeito de EXTRAÇÃO de valor — independente');
    console.log('   do conserto de tipo. Dimensionar antes de propor qualquer coisa.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
