/**
 * _medir/_harness-a-forca-piora.js — C troca força 3 por força 1?
 *
 * ACHADO (`_harness-c-versus-f.js`): C cria 4 pares e perde 3, e as trocas são
 * suspeitas — o MESMO lançamento migra de um documento para outro:
 *
 *   − 01.2026  R$ 3.340,00  força 3  120.DOC- 1670,00 … PRATAO SERVICO
 *   + 01.2026  R$ 3.340,00  força 2  041.DOC- 1670,00 … PRATAO SERVICO   ⚠ e o valor NÃO bate
 *
 *   − 01.2026  R$ 2.000,00  força 3  008.DOC- 713,33 … TECNOTRATOR
 *   + 01.2026  R$ 2.000,00  força 3  023.DOC- 713,33 … TECNOTRATOR
 *
 * Trocar um par de força 3 por um de força 1 é PIORA, mesmo que o valor exibido
 * fique certo. A força é a métrica que o projeto usa para dizer quão confiável é o
 * casamento ([[ordenar-forca-entre-passadas]]).
 *
 * "valor OK +15" pode estar escondendo uma degradação de força — seria
 * [[media-agregada-esconde-par-falso]] de novo.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. a distribuição de FORÇA muda entre A e cada variante?
 *   2. quantos lançamentos trocam de documento? o novo documento é melhor?
 *   3. o veredito final combinando valor certo E força preservada
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const { paraNumero, paraData, soDigitos } = require('./ocr');
function primeiro(obj, chaves) {
    for (const k of chaves) { const v = obj[k]; if (v != null && String(v).trim() !== '') return v; }
    return null;
}
const CAMPOS = {
    numero:   ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF'],
    emitente: ['Emitente', 'Razão social', 'Nome do emitente'],
    valor:    ['Valor total da nota', 'Valor total', 'Valor do boleto'],
    cnpj:     ['CNPJ emitente', 'CNPJ / CPF', 'CNPJ'],
    dtEmi:    ['Data de emissão', 'Data emissao'],
};
function fundir(lista) {
    const at = {};
    for (const l of lista) {
        const numero = primeiro(l.d, CAMPOS.numero), emitente = primeiro(l.d, CAMPOS.emitente);
        const valor = primeiro(l.d, CAMPOS.valor), cnpjP = primeiro(l.d, CAMPOS.cnpj);
        const dtEmi = primeiro(l.d, CAMPOS.dtEmi);
        if (numero && !at.numero) at.numero = soDigitos(numero);
        if (emitente && !at.emitente) at.emitente = String(emitente);
        if (valor != null && at.valor == null) { const v = paraNumero(valor); if (v) at.valor = v; }
        const cn = soDigitos(cnpjP || l.cnpjCol);
        if (cn.length >= 11 && !at.cnpj) at.cnpj = cn;
        if (dtEmi && at.dtEmissao == null) { const t = paraData(dtEmi); if (t) at.dtEmissao = t; }
    }
    return at;
}
const porOrdem = (a, b) => a.ordem - b.ordem;
const docPrimeiro = (a, b) => (a.parcela ? 1 : 0) - (b.parcela ? 1 : 0) || a.ordem - b.ordem;

const VARIANTES = {
    A_atual:        g => fundir(g.slice().sort(porOrdem)),
    B_so_documento: g => { const d = g.filter(x => !x.parcela); return d.length ? fundir(d) : {}; },
    C_doc_primeiro: g => fundir(g.slice().sort(docPrimeiro)),
    E_doc_senao_1a: g => { const d = g.filter(x => !x.parcela);
        return d.length ? fundir(d) : fundir(g.filter(x => x.parcela).sort(porOrdem)); },
    F_por_campo:    g => {
        const docs = g.filter(x => !x.parcela), pars = g.filter(x => x.parcela);
        const at = fundir(g.slice().sort(docPrimeiro));
        let v = null;
        for (const l of docs) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
        if (v == null && pars.length) { let s = 0, n = 0;
            for (const l of pars) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { s += x; n++; } }
            if (n) v = Number(s.toFixed(2)); }
        if (v != null) at.valor = v; else delete at.valor;
        return at;
    },
};

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT ID_RELATORIO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo ORDER BY ID_RELATORIO');
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
    const grupos = new Map();
    let ordem = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo'), iParser = cols.indexOf('dados_parser'), iCnpj = cols.indexOf('cnpj');
        if (iArq < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const campos = sep(ls[i]);
            const arqExato = String(campos[iArq] || '').trim();
            if (!arqExato) continue;
            let d = {};
            const b = iParser >= 0 ? (campos[iParser] || '').trim() : '';
            if (b.startsWith('{')) { try { d = JSON.parse(b); } catch (e) {} }
            const base = semPN(arqExato);
            if (!grupos.has(base)) grupos.set(base, []);
            grupos.get(base).push({ ordem: ordem++, arqExato, parcela: ehParcela(arqExato), d,
                                     cnpjCol: iCnpj >= 0 ? String(campos[iCnpj] || '').trim() : '' });
        }
    }

    const c = h.carregar();
    // chave do LANÇAMENTO (não do documento): para ver troca de documento
    function medir(idx) {
        const porLanc = new Map();
        const forca = { 1: 0, 2: 0, 3: 0 };
        let ok = 0, errado = 0, semValor = 0;
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
                const o = p.lancamentoDaPlanilha(l);
                o._id = `${periodo}#${i}`;
                return o;
            });
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                const f = x.forca || 0;
                if (forca[f] != null) forca[f]++;
                const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
                const e = idx[semPN(x.documento.arquivo)];
                const vIdx = e && e.valor != null ? e.valor : null;
                if (vIdx == null) semValor++;
                else if (Math.abs(vIdx - vLanc) < 0.02) ok++;
                else errado++;
                porLanc.set(x.lancamento._id || `${periodo}|${vLanc}|${x.lancamento.entidade}`,
                            { arq: x.documento.arquivo, forca: f, vLanc });
            }
        }
        return { forca, ok, errado, semValor, porLanc };
    }

    const res = {};
    for (const k of Object.keys(VARIANTES)) {
        const idx = {};
        for (const [base, g] of grupos) { const e = VARIANTES[k](g); if (e && Object.keys(e).length) idx[base] = e; }
        res[k] = medir(idx);
    }

    console.log('═'.repeat(78));
    console.log('A FORÇA DOS PARES — a métrica que o projeto usa');
    console.log('═'.repeat(78));
    console.log('\nvariante              força 3   força 2   força 1   total   valor OK');
    for (const [k, v] of Object.entries(res)) {
        const tot = v.forca[1] + v.forca[2] + v.forca[3];
        console.log(`  ${k.padEnd(20)} ${String(v.forca[3]).padStart(7)}   ${String(v.forca[2]).padStart(7)}   ${String(v.forca[1]).padStart(7)}   ${String(tot).padStart(5)}   ${String(v.ok).padStart(8)}`);
    }

    const A = res.A_atual;
    console.log('\n── contra o índice ATUAL ───────────────────────────────────');
    for (const [k, v] of Object.entries(res)) {
        if (k === 'A_atual') continue;
        const d3 = v.forca[3] - A.forca[3], d2 = v.forca[2] - A.forca[2], d1 = v.forca[1] - A.forca[1];
        const sinal = n => (n >= 0 ? '+' : '') + n;
        console.log(`  ${k.padEnd(20)} força3 ${sinal(d3).padStart(4)}  força2 ${sinal(d2).padStart(4)}  força1 ${sinal(d1).padStart(4)}  valorOK ${sinal(v.ok - A.ok).padStart(4)}  errados ${sinal(v.errado - A.errado).padStart(4)}`);
    }

    // ── lançamentos que trocaram de documento ──────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('LANÇAMENTOS QUE TROCARAM DE DOCUMENTO (A → C)');
    console.log('═'.repeat(78));
    const C = res.C_doc_primeiro;
    let trocou = 0, melhorou = 0, piorou = 0, igual = 0;
    const exemplos = [];
    for (const [id, a] of A.porLanc) {
        const cc = C.porLanc.get(id);
        if (!cc) continue;
        if (a.arq === cc.arq) continue;
        trocou++;
        if (cc.forca > a.forca) melhorou++;
        else if (cc.forca < a.forca) { piorou++; if (exemplos.length < 8) exemplos.push({ id, a, cc }); }
        else igual++;
    }
    console.log(`\n   lançamentos que trocaram de documento: ${trocou}`);
    console.log(`      força MELHOROU: ${melhorou}`);
    console.log(`      força PIOROU:   ${piorou}  ${piorou ? '⚠' : ''}`);
    console.log(`      força igual:    ${igual}`);
    for (const e of exemplos) {
        console.log(`\n   ⚠ ${brl(e.a.vLanc)}`);
        console.log(`      A: força ${e.a.forca}  ${e.a.arq.slice(0, 54)}`);
        console.log(`      C: força ${e.cc.forca}  ${e.cc.arq.slice(0, 54)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
