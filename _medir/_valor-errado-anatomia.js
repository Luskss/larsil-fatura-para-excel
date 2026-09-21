/**
 * _medir/_valor-errado-anatomia.js — os 58 valores errados: quem leu, e de onde?
 *
 * ACHADO (21/09/2026, [[localiza-valor-do-item-nao-do-total]]): 58 pares têm o
 * valor do NOME igual ao LANÇAMENTO e o valor LIDO discordando dos dois. Duas
 * testemunhas contra uma — o defeito é real.
 *
 * Mas "58 valores errados" ainda não diz o que consertar. Falta a anatomia:
 *
 *   1. QUEM leu? (coluna `origem`: IA, conteúdo, visão…) — o defeito é de um motor
 *      só ou está espalhado? [[o-erro-mora-onde-a-funcao-nao-roda]]
 *   2. O valor lido tem RELAÇÃO com o certo? (razão, ou é número solto)
 *   3. Os campos do `dados_parser` contêm o valor CERTO em outra chave? Se o total
 *      está no documento mas em campo errado, o conserto é de mapeamento, não de
 *      leitura — muito mais barato.
 *   4. LOCALIZA tem assinatura própria?
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
const num = v => {
    const s = String(v == null ? '' : v).replace(/[R$\s]/g, '');
    if (!s) return 0;
    // pt-BR: 1.234,56  |  en: 1234.56
    const t = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    return Math.abs(Number(t) || 0);
};

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const vn = p.valorDoNome;

    // ── índice COMPLETO do banco: origem + todos os campos do parser ───────
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
        const iA = cols.indexOf('arquivo'), iO = cols.indexOf('origem'),
              iD = cols.indexOf('dados_parser'), iT = cols.indexOf('tipo'),
              iE = cols.indexOf('evidencia');
        if (iA < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = base(String(f[iA] || '').trim());
            if (!arq || banco.has(arq)) continue;
            let d = {};
            const bruto = iD >= 0 ? (f[iD] || '').trim() : '';
            if (bruto.startsWith('{')) { try { d = JSON.parse(bruto); } catch (e) {} }
            banco.set(arq, { origem: String(f[iO] || '').trim(), campos: d,
                             tipo: String(f[iT] || '').trim(), evid: String(f[iE] || '').trim() });
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
            const b = banco.get(base(x.documento.arquivo)) || { campos: {} };
            casos.push({ periodo, arq: x.documento.arquivo, vL, vD, forca: x.forca,
                         origem: b.origem || '(sem)', tipo: b.tipo || '', evid: b.evid || '',
                         campos: b.campos || {} });
        }
    }

    console.log('═'.repeat(76));
    console.log(`ANATOMIA DOS ${casos.length} VALORES ERRADOS`);
    console.log('═'.repeat(76));

    // ── (1) QUEM leu ───────────────────────────────────────────────────────
    console.log('\n── (1) a ORIGEM gravada: quem liderou a leitura ────────────');
    const porOrigem = new Map();
    for (const k of casos) porOrigem.set(k.origem, (porOrigem.get(k.origem) || 0) + 1);
    for (const [o, n] of [...porOrigem].sort((a, b) => b[1] - a[1]))
        console.log(`   ${o.padEnd(24)} ${String(n).padStart(3)}  ${pct(n, casos.length)}`);

    // comparar com a distribuição GERAL: a origem está super-representada?
    const geral = new Map();
    for (const [, v] of banco) geral.set(v.origem || '(sem)', (geral.get(v.origem || '(sem)') || 0) + 1);
    console.log('\n   contra o acervo inteiro (a origem está super-representada?):');
    for (const [o, n] of [...porOrigem].sort((a, b) => b[1] - a[1])) {
        const g = geral.get(o) || 0;
        const taxaAcervo = 100 * g / banco.size;
        const taxaCasos = 100 * n / casos.length;
        const sinal = taxaCasos > taxaAcervo * 1.5 ? ' ← concentrado' : '';
        console.log(`   ${o.padEnd(24)} acervo ${taxaAcervo.toFixed(1).padStart(5)}%   casos ${taxaCasos.toFixed(1).padStart(5)}%${sinal}`);
    }

    // ── (2) o valor CERTO está em outro campo? ─────────────────────────────
    console.log('\n── (2) o TOTAL certo está em outra chave do parser? ────────');
    let achouEmOutroCampo = 0;
    const ondeEstava = new Map();
    const semEmLugar = [];
    for (const k of casos) {
        let achou = null;
        for (const [chave, val] of Object.entries(k.campos)) {
            const n = num(val);
            if (!n) continue;
            if (Math.abs(n - k.vL) < 0.02) { achou = chave; break; }
        }
        if (achou) { achouEmOutroCampo++; ondeEstava.set(achou, (ondeEstava.get(achou) || 0) + 1); }
        else semEmLugar.push(k);
    }
    console.log(`   o valor lançado APARECE em algum campo do parser: ${achouEmOutroCampo}  ${pct(achouEmOutroCampo, casos.length)}`);
    console.log(`   não aparece em campo nenhum:                      ${casos.length - achouEmOutroCampo}  ${pct(casos.length - achouEmOutroCampo, casos.length)}`);
    if (ondeEstava.size) {
        console.log('\n   em QUAL campo o valor certo estava:');
        for (const [ch, n] of [...ondeEstava].sort((a, b) => b[1] - a[1]))
            console.log(`      ${ch.padEnd(34)} ${String(n).padStart(3)}`);
    }

    // ── (3) e o valor ERRADO, de onde saiu? ────────────────────────────────
    console.log('\n── (3) o valor ERRADO bate com qual campo do parser? ───────');
    const deOndeErrado = new Map();
    let erradoSemCampo = 0;
    for (const k of casos) {
        let achou = null;
        for (const [chave, val] of Object.entries(k.campos)) {
            const n = num(val);
            if (!n) continue;
            if (Math.abs(n - k.vD) < 0.02) { achou = chave; break; }
        }
        if (achou) deOndeErrado.set(achou, (deOndeErrado.get(achou) || 0) + 1);
        else erradoSemCampo++;
    }
    for (const [ch, n] of [...deOndeErrado].sort((a, b) => b[1] - a[1]).slice(0, 12))
        console.log(`      ${ch.padEnd(34)} ${String(n).padStart(3)}`);
    if (erradoSemCampo) console.log(`      (não bate com campo nenhum)        ${String(erradoSemCampo).padStart(3)}`);

    // ── (4) LOCALIZA em detalhe ────────────────────────────────────────────
    console.log('\n── (4) LOCALIZA: os campos de um caso concreto ─────────────');
    const umLoc = casos.filter(k => /LOCALIZA/i.test(k.arq)).sort((a, b) => b.vL - a.vL)[0];
    if (umLoc) {
        console.log(`\n   ${umLoc.arq.slice(0, 66)}`);
        console.log(`   lançado=${brl(umLoc.vL)}   LIDO=${brl(umLoc.vD)}   origem=${umLoc.origem}`);
        console.log(`   tipo=${umLoc.tipo}  evidência="${umLoc.evid}"`);
        console.log('\n   TODOS os campos gravados:');
        for (const [ch, val] of Object.entries(umLoc.campos)) {
            const s = String(val == null ? '' : val).trim();
            if (!s || s === '—') continue;
            const marca = Math.abs(num(val) - umLoc.vL) < 0.02 ? '  ← É O VALOR CERTO'
                        : Math.abs(num(val) - umLoc.vD) < 0.02 ? '  ← é o valor LIDO' : '';
            console.log(`      ${ch.padEnd(30)} ${s.slice(0, 34).padEnd(36)}${marca}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
