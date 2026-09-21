/**
 * _medir/_a-trava-do-boleto-maior.js — a trava "boleto < nota" barra o valor certo?
 *
 * ACHADO (21/09/2026): dos 58 pares com valor errado, o valor CERTO já está gravado
 * na linha em 63,8% — em `Valor do boleto` (23) ou `Valor total` (14).
 *
 * E `_valor-do-pagamento.js:194` diz:
 *
 *     if (bol != null && (base == null || bol < base)) return { valor: bol, ... }
 *
 * O boleto só vence quando é MENOR que a base. No LOCALIZA de R$ 91.288,49:
 *
 *     Valor do boleto = 91288,49   ← o CERTO, vindo da LINHA DIGITÁVEL
 *     Valor total     =  5368,68   ← o que ficou
 *
 * O boleto é MAIOR, então a trava o rejeita. A trava existe por bom motivo — foi
 * medida em §16.5 e nas 4 perdas do A/B, onde boleto maior era multa/juros
 * (SENATRAN 78,09 → 130,16). Mas ela não distingue "maior porque é juros" de
 * "maior porque o total lido é de UM ITEM".
 *
 * ── A diferença que importa ─────────────────────────────────────────────────
 * `Valor do boleto` tem DUAS procedências muito diferentes:
 *   (a) lido do corpo do boleto  → pode ser multa/juros, merece a trava
 *   (b) derivado da LINHA DIGITÁVEL → é aritmética com DV validado
 *       ([[a-chave-de-acesso-valida-o-dv]] é o mesmo princípio)
 *
 * Na (b) o número não é uma leitura: os últimos 10 dígitos do campo 4 da linha
 * digitável SÃO o valor, conferido por DV. Um valor assim não deveria ceder a um
 * `Valor total` lido por IA/regex.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. nos 58, quantos têm `Linha digitável` gravada?
 *   2. o valor da LINHA DIGITÁVEL bate com o lançamento?
 *   3. quantos a trava está barrando (boleto maior que a base)?
 *   4. CUSTO: no acervo inteiro, quantos documentos HOJE CERTOS seriam quebrados
 *      se o boleto-da-linha-digitável passasse a vencer? ([[dimensionar-o-pool-antes-de-medir]])
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { paraNumero } = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// O valor embutido na LINHA DIGITÁVEL (boleto bancário, 47 dígitos).
// Campo 4 = valor, últimos 10 dígitos, em centavos.
function valorDaLinhaDigitavel(ld) {
    const d = String(ld || '').replace(/\D/g, '');
    if (d.length !== 47) return null;
    const cent = d.slice(37, 47);
    const v = Number(cent) / 100;
    return v > 0 ? v : null;
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const vn = p.valorDoNome;

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

    // ── os 58 ──────────────────────────────────────────────────────────────
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
            const vL = Math.abs(Number(x.lancamento.valor) || 0);
            const vD = Math.abs(Number(x.documento.valor) || 0);
            const vNome = Math.abs(Number(vn(x.documento.arquivo)) || 0);
            if (!vL || !vD || !vNome) continue;
            if (Math.abs(vNome - vL) > 0.02) continue;
            if (Math.abs(vD - vL) < 0.02) continue;
            casos.push({ arq: x.documento.arquivo, vL, vD, pd: banco.get(base(x.documento.arquivo)) || {} });
        }
    }

    console.log('═'.repeat(76));
    console.log(`A TRAVA "boleto < nota" NOS ${casos.length} CASOS`);
    console.log('═'.repeat(76));

    let comLD = 0, ldBate = 0, travaBarra = 0, ldBateEtravaBarra = 0;
    const alvos = [];
    for (const k of casos) {
        const ld = k.pd['Linha digitável'];
        const vLD = valorDaLinhaDigitavel(ld);
        const bol = paraNumero(k.pd['Valor do boleto']);
        const nota = paraNumero(k.pd['Valor total da nota']);
        const tot = paraNumero(k.pd['Valor total']);
        const baseTrava = nota != null ? nota : tot;
        const barrado = bol != null && baseTrava != null && !(bol < baseTrava);

        if (vLD != null) comLD++;
        if (vLD != null && Math.abs(vLD - k.vL) < 0.02) ldBate++;
        if (barrado) travaBarra++;
        if (vLD != null && Math.abs(vLD - k.vL) < 0.02 && barrado) {
            ldBateEtravaBarra++;
            alvos.push({ ...k, vLD, bol, baseTrava });
        }
    }

    console.log(`\n   com Linha digitável gravada:            ${String(comLD).padStart(3)}  ${pct(comLD, casos.length)}`);
    console.log(`   valor da LD == lançamento (DV confere):  ${String(ldBate).padStart(3)}  ${pct(ldBate, casos.length)}`);
    console.log(`   a trava "boleto < base" está barrando:   ${String(travaBarra).padStart(3)}  ${pct(travaBarra, casos.length)}`);
    console.log(`   AMBOS (LD certa E trava barrando):       ${String(ldBateEtravaBarra).padStart(3)}  ${pct(ldBateEtravaBarra, casos.length)}  ← alvo`);

    if (alvos.length) {
        console.log('\n── os casos onde a LD tem o valor certo e a trava a barra ──');
        for (const a of alvos.sort((x, y) => y.vL - x.vL).slice(0, 16)) {
            console.log(`\n   ${a.arq.slice(0, 64)}`);
            console.log(`      lançado=${brl(a.vL).padStart(14)}   LD=${brl(a.vLD).padStart(14)}  ← conferem`);
            console.log(`      gravado=${brl(a.vD).padStart(14)}   base da trava=${brl(a.baseTrava)}`);
        }
    }

    // ── CUSTO: no acervo, quem seria quebrado? ─────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('CUSTO NO ACERVO INTEIRO');
    console.log('═'.repeat(76));
    let zona = 0, hojeCerto = 0, quebraria = 0, curaria = 0, indiferente = 0;
    for (const [arq, pd] of banco) {
        const vLD = valorDaLinhaDigitavel(pd['Linha digitável']);
        if (vLD == null) continue;
        const bol = paraNumero(pd['Valor do boleto']);
        const nota = paraNumero(pd['Valor total da nota']);
        const tot = paraNumero(pd['Valor total']);
        const baseTrava = nota != null ? nota : tot;
        const barrado = bol != null && baseTrava != null && !(bol < baseTrava);
        if (!barrado) continue;          // a mudança só age onde a trava barra hoje
        zona++;
        const vNome = Math.abs(Number(vn(arq)) || 0);
        if (!vNome || tot == null) continue;
        const certoHoje = Math.abs(tot - vNome) < 0.02;
        const certoDepois = Math.abs(vLD - vNome) < 0.02;
        if (certoHoje) hojeCerto++;
        if (certoHoje && !certoDepois) quebraria++;
        else if (!certoHoje && certoDepois) curaria++;
        else indiferente++;
    }
    console.log(`\n   documentos com LD onde a trava barra hoje:  ${zona}`);
    console.log(`   com gabarito no nome para julgar:`);
    console.log(`      hoje CERTOS:                    ${String(hojeCerto).padStart(4)}`);
    console.log(`      a mudança QUEBRARIA:            ${String(quebraria).padStart(4)}  ← custo`);
    console.log(`      a mudança CURARIA:              ${String(curaria).padStart(4)}  ← ganho`);
    console.log(`      indiferente:                    ${String(indiferente).padStart(4)}`);
    console.log(`\n   razão ganho/custo: ${quebraria ? (curaria / quebraria).toFixed(1) + '×' : (curaria ? '∞ (custo zero)' : '—')}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
