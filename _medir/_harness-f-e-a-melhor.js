/**
 * _medir/_harness-f-e-a-melhor.js — F resiste? e por que ela vence C?
 *
 * QUADRO COMPLETO (`_harness-a-forca-piora.js`), contra o índice atual:
 *
 *   variante         força3  força2  força1  valorOK  errados
 *   B_so_documento      -8      +7      -1       -1      -29
 *   C_doc_primeiro      -1      +1      +1      +15      -14
 *   E_doc_senao_1a      -2      +2      +1      +12      -20
 *   F_por_campo         +2      -1      -1      +14      -13   ← única que GANHA força 3
 *
 * C parecia melhor por "valor OK +15", mas troca 2 pares de força 3 para força 2.
 * F cura quase o mesmo (+14) e MELHORA a força. A diferença entre as duas:
 *
 *   C: reordena tudo (documento antes de parcela) e funde na ordem nova
 *   F: separa as responsabilidades —
 *        • IDENTIDADE (numero, cnpj, emitente, data): qualquer linha serve, porque
 *          não variam entre parcelas do mesmo documento
 *        • VALOR: SÓ da linha de documento; se não houver, soma das parcelas
 *
 * F vence porque em C o `numero` também migra para o da linha de documento, e em
 * alguns casos a linha de parcela tinha o número MELHOR para o casamento.
 *
 * ── O que falta antes de implementar ────────────────────────────────────────
 *   1. repetir 2× ([[repetir-o-ganho-antes-de-somar]])
 *   2. F troca pares? a força piora em algum?
 *   3. os 14 curados por F são os LOCALIZA da investigação de ontem?
 *   4. a soma das parcelas (usada nos órfãos) prejudica alguém?
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

const A_atual = g => fundir(g.slice().sort(porOrdem));
const F_por_campo = g => {
    const docs = g.filter(x => !x.parcela), pars = g.filter(x => x.parcela);
    const at = fundir(g.slice().sort(docPrimeiro));
    let v = null;
    for (const l of docs) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
    if (v == null && pars.length) { let s = 0, n = 0;
        for (const l of pars) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { s += x; n++; } }
        if (n) v = Number(s.toFixed(2)); }
    if (v != null) at.valor = v; else delete at.valor;
    return at;
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
    const construir = fn => {
        const idx = {};
        for (const [base, g] of grupos) { const e = fn(g); if (e && Object.keys(e).length) idx[base] = e; }
        return idx;
    };
    const c = h.carregar();

    function medir(idx) {
        const forca = { 1: 0, 2: 0, 3: 0 };
        const porLanc = new Map();
        let ok = 0, errado = 0, semValor = 0;
        const curados = [];
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
                const f = x.forca || 0;
                if (forca[f] != null) forca[f]++;
                const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
                const e = idx[semPN(x.documento.arquivo)];
                const vIdx = e && e.valor != null ? e.valor : null;
                let estado;
                if (vIdx == null) { semValor++; estado = 'sem'; }
                else if (Math.abs(vIdx - vLanc) < 0.02) { ok++; estado = 'ok'; }
                else { errado++; estado = 'erro'; }
                porLanc.set(x.lancamento._id, { arq: x.documento.arquivo, forca: f, vLanc, vIdx, estado });
            }
        }
        return { forca, ok, errado, semValor, porLanc };
    }

    console.log('═'.repeat(78));
    console.log('(1) F REPETIDA 2× — o ganho resiste?');
    console.log('═'.repeat(78));
    const rodadas = [];
    for (let i = 0; i < 2; i++) {
        const a = medir(construir(A_atual));
        const f = medir(construir(F_por_campo));
        rodadas.push({ a, f });
        console.log(`\n   rodada ${i + 1}:  valorOK ${f.ok - a.ok >= 0 ? '+' : ''}${f.ok - a.ok}   errados ${f.errado - a.errado >= 0 ? '+' : ''}${f.errado - a.errado}   força3 ${f.forca[3] - a.forca[3] >= 0 ? '+' : ''}${f.forca[3] - a.forca[3]}`);
    }
    const estavel = JSON.stringify(rodadas[0].f.forca) === JSON.stringify(rodadas[1].f.forca)
                 && rodadas[0].f.ok === rodadas[1].f.ok;
    console.log(`\n   ${estavel ? '✓ estável nas duas rodadas' : '⚠ INSTÁVEL — não somar'}`);

    // ── (2) F troca pares? piora força? ────────────────────────────────────
    const A = rodadas[0].a, F = rodadas[0].f;
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) F TROCA DOCUMENTO DE ALGUM LANÇAMENTO?');
    console.log('═'.repeat(78));
    let trocou = 0, piorou = 0, melhorou = 0;
    const exTroca = [];
    for (const [id, a] of A.porLanc) {
        const f = F.porLanc.get(id);
        if (!f || a.arq === f.arq) continue;
        trocou++;
        if (f.forca < a.forca) { piorou++; exTroca.push({ a, f, ruim: true }); }
        else if (f.forca > a.forca) { melhorou++; exTroca.push({ a, f }); }
        else exTroca.push({ a, f });
    }
    console.log(`\n   trocaram de documento: ${trocou}   melhorou: ${melhorou}   piorou: ${piorou} ${piorou ? '⚠' : '✓'}`);
    for (const e of exTroca.slice(0, 6)) {
        console.log(`\n   ${e.ruim ? '⚠ ' : ''}${brl(e.a.vLanc)}`);
        console.log(`      A: f${e.a.forca} ${e.a.estado.padEnd(4)} ${e.a.arq.slice(0, 50)}`);
        console.log(`      F: f${e.f.forca} ${e.f.estado.padEnd(4)} ${e.f.arq.slice(0, 50)}`);
    }

    // ── (3) quem F cura ────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) OS QUE F CURA (erro → acerto)');
    console.log('═'.repeat(78));
    let n = 0;
    for (const [id, a] of A.porLanc) {
        const f = F.porLanc.get(id);
        if (!f) continue;
        if (a.estado === 'erro' && f.estado === 'ok') {
            n++;
            if (n <= 16) {
                console.log(`\n   ${brl(a.vLanc).padStart(15)}   ${brl(a.vIdx)} → ${brl(f.vIdx)}`);
                console.log(`      ${f.arq.slice(0, 62)}`);
            }
        }
    }
    console.log(`\n   total curados: ${n}`);

    // ── (4) F estraga alguém? ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(4) F ESTRAGA ALGUÉM (acerto → erro)?');
    console.log('═'.repeat(78));
    let m = 0;
    for (const [id, a] of A.porLanc) {
        const f = F.porLanc.get(id);
        if (!f) continue;
        if (a.estado === 'ok' && f.estado !== 'ok') {
            m++;
            console.log(`\n   ⚠ ${brl(a.vLanc).padStart(15)}   ${brl(a.vIdx)} → ${f.vIdx == null ? '(sem valor)' : brl(f.vIdx)}`);
            console.log(`      ${f.arq.slice(0, 62)}`);
        }
    }
    console.log(`\n   total estragados: ${m}  ${m ? '⚠' : '✓ nenhum'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
