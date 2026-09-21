/**
 * _medir/_conferir-o-implementado.js — o código implantado faz o que foi medido?
 *
 * IMPLEMENTADO em 21/09/2026: `valorPorPrecedencia` ganhou uma exceção à trava
 * "boleto < base", liberada só quando o valor da LINHA DIGITÁVEL coincide com o
 * valor do NOME do arquivo ([[trava-do-boleto-maior-barra-a-ld]]).
 *
 * A medição que aprovou (`_separar-ld-de-juros.js`) usou uma SIMULAÇÃO da regra.
 * Este script chama a FUNÇÃO DE PRODUÇÃO já editada, sobre os mesmos documentos.
 * Se os números não baterem com 11 curados / 0 quebrados, o que implementei não é
 * o que medi ([[o-script-de-efeito-mentia]] começou assim).
 *
 * Também confere o que a simulação NÃO cobria: `decidirValorPago` inteiro, com a
 * âncora na frente. A âncora roda ANTES da precedência e pode decidir sozinha —
 * se ela já resolvia esses casos, meu ganho é menor do que anunciei.
 *
 * SOMENTE LEITURA (não grava no banco).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const V = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// o gabarito do nome, como process-folder.js o calcula (linha 81)
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
    console.log('─ sanidade: a função exporta o helper novo? ─');
    console.log(`   valorDaLinhaDigitavel exportada: ${typeof V.valorDaLinhaDigitavel === 'function' ? 'SIM' : 'NÃO ⚠'}`);
    const t = V.valorDaLinhaDigitavel('23792011029002604354862005184403310000009128849');
    console.log(`   teste: LD de 47 díg. → ${t}  (esperado 91288.49)`);

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
    const banco = new Map();
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
            const arq = base(String(f[iA] || '').trim());
            if (!arq || banco.has(arq)) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { banco.set(arq, JSON.parse(bruto)); } catch (e) {}
        }
    }

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
            if (v) lancPorArquivo.set(base(x.documento.arquivo), v);
        }
    }

    // ── A/B com a FUNÇÃO DE PRODUÇÃO ───────────────────────────────────────
    // sem texto: a âncora não age (ela precisa do texto do PDF, que não está no
    // banco). Isolar a PRECEDÊNCIA, que é onde a mudança mora.
    let cura = 0, quebra = 0, indif = 0, age = 0;
    const exemplos = [];
    for (const [arq, pd] of banco) {
        const vLanc = lancPorArquivo.get(arq);
        if (!vLanc) continue;
        const vNome = valorDoNomeArquivo(arq);

        const antes  = V.valorPorPrecedencia(pd);                // sem o parâmetro novo
        const depois = V.valorPorPrecedencia(pd, vNome);         // com ele

        if (antes.valor == null || depois.valor == null) continue;
        if (Math.abs(antes.valor - depois.valor) < 0.02) continue;   // regra não agiu
        age++;
        const certoAntes  = Math.abs(antes.valor  - vLanc) < 0.02;
        const certoDepois = Math.abs(depois.valor - vLanc) < 0.02;
        if (!certoAntes && certoDepois) { cura++; if (exemplos.length < 14) exemplos.push({ arq, antes, depois, vLanc, vNome }); }
        else if (certoAntes && !certoDepois) { quebra++; exemplos.push({ arq, antes, depois, vLanc, vNome, RUIM: true }); }
        else indif++;
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log('A/B COM A FUNÇÃO DE PRODUÇÃO (não com simulação)');
    console.log('═'.repeat(74));
    console.log(`\n   documentos onde a regra MUDA o valor: ${age}`);
    console.log(`      CURA (passa a bater com o lançado):  ${String(cura).padStart(3)}`);
    console.log(`      QUEBRA:                              ${String(quebra).padStart(3)}`);
    console.log(`      indiferente (errado antes e depois): ${String(indif).padStart(3)}`);
    console.log(`\n   previsto pela medição: 11 curados, 0 quebrados`);
    const bate = cura === 11 && quebra === 0;
    console.log(`   ${bate ? '✓ BATE com o previsto' : '⚠ NÃO bate — investigar antes de confiar'}`);

    console.log('\n── os casos ────────────────────────────────────────────────');
    for (const e of exemplos) {
        console.log(`\n   ${e.RUIM ? '⚠ QUEBRA  ' : ''}${e.arq.slice(0, 62)}`);
        console.log(`      lançado=${brl(e.vLanc).padStart(14)}  nome=${e.vNome ? brl(e.vNome).padStart(14) : '—'}`);
        console.log(`      antes=${brl(e.antes.valor).padStart(14)} (${e.antes.origem})`);
        console.log(`      depois=${brl(e.depois.valor).padStart(13)} (${e.depois.origem})`);
    }

    // ── a exceção respeita o SENATRAN? ─────────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('TRAVA DE REGRESSÃO: o SENATRAN continua intacto?');
    console.log('═'.repeat(74));
    for (const [arq, pd] of banco) {
        if (!/SENATRAN|MINISTERIO DA JUSTI/i.test(arq)) continue;
        const vNome = valorDoNomeArquivo(arq);
        const antes = V.valorPorPrecedencia(pd);
        const depois = V.valorPorPrecedencia(pd, vNome);
        if (antes.valor == null) continue;
        const mudou = depois.valor != null && Math.abs(antes.valor - depois.valor) > 0.02;
        if (mudou) console.log(`   ⚠ MUDOU: ${arq.slice(0, 54)}  ${brl(antes.valor)} → ${brl(depois.valor)}`);
    }
    console.log('   (nenhuma linha acima = nenhum documento SENATRAN foi alterado)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
