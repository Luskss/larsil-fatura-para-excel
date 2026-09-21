/**
 * _medir/_localiza-valor-do-item.js — o LOCALIZA lê item em vez de total?
 *
 * ACHADO (21/09/2026): 58 pares têm nome==lançamento e valor LIDO diferente dos
 * dois. **18 são LOCALIZA** (31%), e são os de maior valor:
 *
 *     nome/lançamento     valor lido
 *     91.288,49            5.368,68
 *     61.116,99            3.674,71
 *     60.141,75            3.807,56
 *     33.914,39              307,67
 *
 * Sempre MENOR, nunca maior. Hipótese: fatura de locação de frota lista dezenas de
 * veículos; o extrator pega o valor de UM item em vez do total.
 *
 * ── Mas cuidado ─────────────────────────────────────────────────────────────
 * [[total-lixo-veta-boleto-certo]] e [[sobrescrita-do-valor-na-630]] já mostraram
 * que eu superestimo defeito de valor a partir de amostra que eu mesmo produzo. E
 * [[repetir-o-ganho-antes-de-somar]]: 3 medições prometeram 150, 3 e 2 — sobraram
 * 1, 0 e 1.
 *
 * Então aqui eu NÃO proponho conserto. Só dimensiono:
 *   1. o padrão "lido < lançado" é consistente em LOCALIZA? em que proporção?
 *   2. esses pares JÁ ESTÃO CERTOS no painel? (se o par se formou por número+
 *      entidade com força 3, o valor errado não impediu nada)
 *   3. qual o GANHO POSSÍVEL: quantos pares o valor errado faz o painel PERDER?
 *      ([[dimensionar-o-pool-antes-de-medir]])
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
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    // `valorDoNome` É exportado (_pareamento.js:918) — usar o export, não uma fatia
    // do fonte. A fatia perde `RE_DATA_PREFIXO` (linha 156) e quebra; pior, se por
    // acaso rodasse, mediria uma cópia mutilada ([[a-api-parecida-nao-e-a-mesma]]).
    const vn = p.valorDoNome;
    if (typeof vn !== 'function') throw new Error('valorDoNome não exportado — fonte mudou?');

    const casos = [];
    let pares = 0;
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
            if (Math.abs(vNome - vL) > 0.02) continue;
            if (Math.abs(vD - vL) < 0.02) continue;
            casos.push({ periodo, arq: x.documento.arquivo, vL, vD, vNome,
                         forca: x.forca, ehLocaliza: /LOCALIZA/i.test(x.documento.arquivo) });
        }
    }

    const loc = casos.filter(k => k.ehLocaliza);
    const outros = casos.filter(k => !k.ehLocaliza);

    console.log('═'.repeat(74));
    console.log(`DEFEITO DE VALOR: ${casos.length} pares (de ${pares})`);
    console.log('═'.repeat(74));

    const analisar = (nome, arr) => {
        const menor = arr.filter(k => k.vD < k.vL).length;
        const maior = arr.filter(k => k.vD > k.vL).length;
        console.log(`\n── ${nome}: ${arr.length} casos ──`);
        console.log(`   valor lido MENOR que o lançado: ${String(menor).padStart(3)}  ${pct(menor, arr.length)}`);
        console.log(`   valor lido MAIOR:               ${String(maior).padStart(3)}  ${pct(maior, arr.length)}`);
        const porForca = new Map();
        for (const k of arr) porForca.set(k.forca, (porForca.get(k.forca) || 0) + 1);
        console.log('   força do par (o valor errado impediu o casamento?):');
        for (const [f, n] of [...porForca].sort((a, b) => b[0] - a[0]))
            console.log(`      força ${f}: ${String(n).padStart(3)}  ${pct(n, arr.length)}`);
    };
    analisar('LOCALIZA', loc);
    analisar('demais fornecedores', outros);

    // ── O GANHO POSSÍVEL: esses pares JÁ estão certos? ─────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('GANHO POSSÍVEL (dimensionar antes de consertar)');
    console.log('═'.repeat(74));
    const forca3 = casos.filter(k => k.forca === 3).length;
    const forca12 = casos.filter(k => k.forca < 3).length;
    console.log(`\n   Os ${casos.length} pares JÁ ESTÃO FORMADOS. O valor errado não impediu`);
    console.log(`   o casamento — eles casaram por número+entidade.`);
    console.log(`\n     força 3 (número+entidade+data): ${forca3}  ← já no máximo`);
    console.log(`     força 1 ou 2:                    ${forca12}  ← poderiam subir`);
    console.log(`\n   Ganho possível em PARES NOVOS: 0 — todos já estão pareados.`);
    console.log(`   Ganho possível em FORÇA: até ${forca12} pares subiriam de força.`);
    console.log('\n   O custo real é OUTRO: o painel MOSTRA o valor errado ao usuário.');
    console.log('   Quem confere vê "R$ 5.368,68" num documento de R$ 91.288,49.');

    console.log('\n── os LOCALIZA, todos ──────────────────────────────────────');
    for (const k of loc.sort((a, b) => b.vL - a.vL))
        console.log(`   ${k.periodo}  lanç=${brl(k.vL).padStart(14)}  LIDO=${brl(k.vD).padStart(13)}  f${k.forca}  ${k.arq.slice(0, 40)}`);

    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
