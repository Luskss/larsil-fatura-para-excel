/**
 * _medir/_quantos-documentos-de-verdade.js — o ganho é 11 ou menos?
 *
 * ERRO MEU (21/09/2026): `_conferir-o-implementado.js` deduplicava por `base()`,
 * que remove o sufixo `#pN`. Quando um carnê tinha várias parcelas, eu guardava a
 * PRIMEIRA linha que aparecia — às vezes uma parcela — e a exibia com o nome do
 * documento. `_mais-um-teste.js` revelou isso: as linhas afetadas eram `#p2`, `#p3`.
 *
 * `_carne-a-excecao-vaza.js` já provou que a produção não é afetada (a linha 619
 * sobrescreve o valor da parcela e a LD é deletada antes). Mas o NÚMERO que eu
 * reportei — "11 curados" — pode estar contando parcelas como documentos.
 *
 * É a armadilha de [[parcelas-pn-sobram-no-upsert]] e a mesma que me fez contar
 * "44 documentos" que eram 3 em [[numero-do-pedido-no-campo-nf-e-3-casos]].
 *
 * ── O que este script faz diferente ─────────────────────────────────────────
 * Separa as duas populações e conta cada uma:
 *   • linhas SEM `#pN` (documento único) — a produção roda a exceção nelas
 *   • linhas COM `#pN` (parcela de carnê) — a produção as sobrescreve
 *
 * O ganho REAL é só o primeiro grupo.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const V = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const sep = (l) => {
        const o = []; let a = '', q = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (q) { if (ch === '"') { if (l[i + 1] === '"') { a += '"'; i++; } else q = false; } else a += ch; }
            else if (ch === '"') q = true;
            else if (ch === ';') { o.push(a); a = ''; }
            else a += ch;
        }
        o.push(a); return o;
    };
    const linhas = [];
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iD < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = String(f[iA] || '').trim();
            if (!arq) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { linhas.push({ arq, pd: JSON.parse(bruto) }); } catch (e) {}
        }
    }

    // o lançamento, por documento base
    const lancPorArquivo = new Map();
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
            const v = Math.abs(Number(x.lancamento.valor) || 0);
            if (v) lancPorArquivo.set(semPN(x.documento.arquivo), v);
        }
    }

    console.log('═'.repeat(74));
    console.log('O GANHO REAL: documentos, não parcelas');
    console.log('═'.repeat(74));

    const grupos = { documento: [], parcela: [] };
    for (const { arq, pd } of linhas) {
        const vLanc = lancPorArquivo.get(semPN(arq));
        if (!vLanc) continue;
        const vNome = valorDoNomeArquivo(arq);
        const antes = V.valorPorPrecedencia(pd);
        const depois = V.valorPorPrecedencia(pd, vNome);
        if (antes.valor == null || depois.valor == null) continue;
        if (Math.abs(antes.valor - depois.valor) < 0.02) continue;
        const certoAntes = Math.abs(antes.valor - vLanc) < 0.02;
        const certoDepois = Math.abs(depois.valor - vLanc) < 0.02;
        const reg = { arq, antes, depois, vLanc, cura: !certoAntes && certoDepois,
                      quebra: certoAntes && !certoDepois };
        grupos[ehParcela(arq) ? 'parcela' : 'documento'].push(reg);
    }

    for (const [nome, arr] of Object.entries(grupos)) {
        const cura = arr.filter(x => x.cura).length;
        const quebra = arr.filter(x => x.quebra).length;
        console.log(`\n── linhas de ${nome.toUpperCase()} ──`);
        console.log(`   a exceção mudaria o valor em: ${arr.length}`);
        console.log(`      cura:   ${cura}`);
        console.log(`      quebra: ${quebra}`);
        if (nome === 'parcela')
            console.log('   → IRRELEVANTE na produção: a linha 619 sobrescreve com o valor');
            console.log('     da parcela e a LD é deletada antes (provado em _carne-a-excecao-vaza)');
    }

    const docs = grupos.documento;
    const curaDoc = docs.filter(x => x.cura);
    console.log(`\n${'═'.repeat(74)}`);
    console.log('NÚMERO CORRIGIDO');
    console.log('═'.repeat(74));
    console.log(`\n   ontem eu reportei: 11 curados`);
    console.log(`   documentos ÚNICOS de verdade curados: ${curaDoc.length}`);
    if (curaDoc.length) {
        console.log('\n   os documentos (não parcelas):');
        for (const d of curaDoc.sort((a, b) => b.vLanc - a.vLanc))
            console.log(`      ${brl(d.vLanc).padStart(15)}  ${brl(d.antes.valor).padStart(13)} → ${brl(d.depois.valor).padStart(13)}  ${d.arq.slice(0, 40)}`);
    }

    // quantos documentos-pai distintos estão por trás das parcelas afetadas?
    const paisAfetados = new Set(grupos.parcela.map(x => semPN(x.arq)));
    console.log(`\n   documentos-pai por trás das ${grupos.parcela.length} parcelas afetadas: ${paisAfetados.size}`);
    for (const pai of paisAfetados) console.log(`      ${pai.slice(0, 60)}`);
    console.log('\n   → esses PAIS não têm linha própria no banco (viraram parcelas),');
    console.log('     então a exceção não tem onde agir neles hoje. Na RELEITURA,');
    console.log('     ela agirá no pdComum antes do bloco do carnê — e o valor');
    console.log('     da parcela continuará prevalecendo.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
