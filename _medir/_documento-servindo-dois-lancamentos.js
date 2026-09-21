/**
 * _medir/_documento-servindo-dois-lancamentos.js — 114 documentos em 2+ pares
 *
 * ACHADO (`_gemeos-o-mes-nao-e-o-criterio.js`): investigando os "gêmeos" achei
 * outra coisa — **114 de 1.999 documentos pareados aparecem em mais de um par**.
 * Só 4 deles são gêmeos, então o reuso NÃO é fenômeno dos duplicados.
 *
 * Exemplos:
 *     009.DOC- 152,93 … ALLREDE. RCB 774456
 *        01.2026  R$ 149,90  força 3
 *        02.2026  R$ 149,90  força 2
 *
 * Um documento físico não paga dois lançamentos. Ou um dos pares é falso, ou são
 * dois lançamentos legítimos do mesmo valor (mensalidade) e o arquivo do outro mês
 * está faltando/não foi achado.
 *
 * ── Mas cuidado com a régua ─────────────────────────────────────────────────
 * O painel é POR PERÍODO: cada mês é uma consulta independente, e a vizinhança é
 * intencional ([[vizinhanca-mistura-meses]]). Um documento aparecer no resultado
 * de janeiro E de fevereiro pode ser efeito de consultas separadas, não um "duplo
 * consumo" dentro da mesma conferência. Se for isso, não é defeito — é como o
 * painel funciona, e o usuário vê um mês por vez.
 *
 * ── O que decide ────────────────────────────────────────────────────────────
 *   1. os pares repetidos são do MESMO período ou de períodos diferentes?
 *      → mesmo período = defeito real; períodos diferentes = efeito de consulta
 *   2. quando é no mesmo período, os lançamentos são distintos?
 *   3. o valor é igual nos dois? (mensalidade vs erro)
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
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    const usos = new Map();               // arquivo → [{periodo, lancId, vLanc, forca, ent}]
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
            const o = p.lancamentoDaPlanilha(l); o._id = `${periodo}#${i}`; return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const arq = x.documento.arquivo;
            if (!usos.has(arq)) usos.set(arq, []);
            usos.get(arq).push({
                periodo, lancId: x.lancamento._id,
                vLanc: Math.abs(Number(x.lancamento.valor) || 0),
                forca: x.forca, ent: norm(x.lancamento.entidade || ''),
                nf: String(x.lancamento.nf || ''),
            });
        }
    }

    const repetidos = [...usos].filter(([, u]) => u.length > 1);
    console.log('═'.repeat(78));
    console.log(`DOCUMENTOS EM MAIS DE UM PAR: ${repetidos.length} de ${usos.size}`);
    console.log('═'.repeat(78));

    // ── (1) mesmo período ou períodos diferentes? ──────────────────────────
    let mesmoPeriodo = 0, periodosDiferentes = 0;
    const doMesmo = [];
    for (const [arq, u] of repetidos) {
        const periodos = new Set(u.map(x => x.periodo));
        if (periodos.size === 1) { mesmoPeriodo++; doMesmo.push({ arq, u }); }
        else periodosDiferentes++;
    }
    console.log(`\n   repetido DENTRO do mesmo período: ${mesmoPeriodo}  ${pct(mesmoPeriodo, repetidos.length)}  ← defeito real`);
    console.log(`   em períodos DIFERENTES:           ${periodosDiferentes}  ${pct(periodosDiferentes, repetidos.length)}  ← consultas separadas`);
    console.log('\n   (o painel consulta um mês por vez; o mesmo documento servir de');
    console.log('    candidato em meses vizinhos é o comportamento projetado)');

    if (doMesmo.length) {
        console.log('\n── os repetidos NO MESMO PERÍODO ───────────────────────────');
        for (const { arq, u } of doMesmo.slice(0, 12)) {
            console.log(`\n   ${arq.slice(0, 64)}`);
            for (const x of u)
                console.log(`      ${x.periodo}  ${brl(x.vLanc).padStart(14)}  NF=${x.nf.padEnd(10)} força ${x.forca}  ${x.ent.slice(0, 22)}`);
            const vals = new Set(u.map(x => x.vLanc.toFixed(2)));
            const nfs = new Set(u.map(x => x.nf));
            console.log(`      valores distintos: ${vals.size}   NFs distintas: ${nfs.size}`);
        }
    }

    // ── (2) nos períodos diferentes, o valor é o mesmo? ────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) EM PERÍODOS DIFERENTES: mensalidade ou erro?');
    console.log('═'.repeat(78));
    let mesmoValor = 0, valorDif = 0;
    const exMesmo = [];
    for (const [arq, u] of repetidos) {
        if (new Set(u.map(x => x.periodo)).size === 1) continue;
        const vals = new Set(u.map(x => x.vLanc.toFixed(2)));
        if (vals.size === 1) { mesmoValor++; if (exMesmo.length < 8) exMesmo.push({ arq, u }); }
        else valorDif++;
    }
    console.log(`\n   mesmo valor nos dois meses: ${mesmoValor}  ← mensalidade: o doc do outro mês falta`);
    console.log(`   valores diferentes:         ${valorDif}`);
    for (const { arq, u } of exMesmo) {
        console.log(`\n   ${arq.slice(0, 62)}`);
        for (const x of u) console.log(`      ${x.periodo}  ${brl(x.vLanc)}  força ${x.forca}  NF=${x.nf}`);
    }

    // ── (3) o painel mostra os dois ao usuário? ────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) QUANTOS PARES ESTÃO ENVOLVIDOS NO TOTAL?');
    console.log('═'.repeat(78));
    let paresEnvolvidos = 0;
    for (const [, u] of repetidos) paresEnvolvidos += u.length;
    console.log(`\n   pares envolvendo documento reutilizado: ${paresEnvolvidos}`);
    console.log(`   se cada documento só pudesse servir 1 par, sobrariam: ${paresEnvolvidos - repetidos.length} lançamentos sem documento`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
