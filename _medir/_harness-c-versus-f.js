/**
 * _medir/_harness-c-versus-f.js — por que C ganha, e o par a mais é real?
 *
 * RESULTADO (`_harness-variantes-de-conserto.js`):
 *
 *   variante              valor OK   errados   sem valor   (vs atual)
 *   C_doc_primeiro           +15       -14         +0      ← melhor
 *   F_por_campo              +14       -13          -1
 *   E_doc_senao_primeira     +12       -20          +9
 *   B_so_documento            -1       -29         +28     ← a ingênua, pior
 *
 * Duas coisas a esclarecer antes de escolher:
 *
 * ── 1. o número de PARES muda (2123 → 2124) ─────────────────────────────────
 * O índice alimenta o pareamento, então mudar o índice pode criar/destruir par.
 * Um par a mais não é necessariamente bom: pode ser par FALSO
 * ([[media-agregada-esconde-par-falso]]). Preciso ver QUAL par apareceu.
 *
 * ── 2. C não trata os 637 órfãos ────────────────────────────────────────────
 * C só reordena; nos grupos sem linha de documento ela continua pegando a
 * primeira parcela. D/E tratam, e perderam para C. Por quê? Se a soma (D) piora,
 * é sinal de que o valor lançado nesses casos É o da parcela, não o total.
 *
 * ── 3. C é estável? ─────────────────────────────────────────────────────────
 * [[repetir-o-ganho-antes-de-somar]]: rodar 2× antes de somar.
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
const ordenaDocPrimeiro = (a, b) => (a.parcela ? 1 : 0) - (b.parcela ? 1 : 0) || a.ordem - b.ordem;

async function carregarGrupos() {
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
    return grupos;
}

function construir(grupos, fn) {
    const idx = {};
    for (const [base, g] of grupos) { const e = fn(g); if (e && Object.keys(e).length) idx[base] = e; }
    return idx;
}

function pareamentoCom(c, idx) {
    const pares = new Map();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
            pares.set(`${periodo}|${x.documento.arquivo}`, {
                periodo, arq: x.documento.arquivo, vLanc, forca: x.forca,
                ent: x.lancamento.entidade || '',
            });
        }
    }
    return pares;
}

(async () => {
    const grupos = await carregarGrupos();
    const c = h.carregar();

    const idxA = construir(grupos, g => fundir(g.slice().sort((a, b) => a.ordem - b.ordem)));
    const idxC = construir(grupos, g => fundir(g.slice().sort(ordenaDocPrimeiro)));

    const parA = pareamentoCom(c, idxA);
    const parC = pareamentoCom(c, idxC);

    console.log('═'.repeat(76));
    console.log('(1) O PAR A MAIS: apareceu ou sumiu?');
    console.log('═'.repeat(76));
    const novos = [...parC.keys()].filter(k => !parA.has(k));
    const perdidos = [...parA.keys()].filter(k => !parC.has(k));
    console.log(`\n   pares com A: ${parA.size}   com C: ${parC.size}`);
    console.log(`   NOVOS em C:   ${novos.length}`);
    console.log(`   PERDIDOS em C: ${perdidos.length}`);
    for (const k of novos.slice(0, 10)) {
        const x = parC.get(k);
        console.log(`\n   + ${x.periodo}  ${brl(x.vLanc)}  força ${x.forca}  ${x.ent.slice(0, 20)}`);
        console.log(`     ${x.arq.slice(0, 62)}`);
        const e = idxC[semPN(x.arq)] || {};
        const eA = idxA[semPN(x.arq)] || {};
        console.log(`     índice A: valor=${eA.valor == null ? '—' : brl(eA.valor)} numero=${eA.numero || '—'}`);
        console.log(`     índice C: valor=${e.valor == null ? '—' : brl(e.valor)} numero=${e.numero || '—'}`);
        console.log(`     o par novo BATE com o lançado? ${e.valor != null && Math.abs(e.valor - x.vLanc) < 0.02 ? 'SIM ✓' : 'não ⚠'}`);
    }
    for (const k of perdidos.slice(0, 10)) {
        const x = parA.get(k);
        console.log(`\n   − ${x.periodo}  ${brl(x.vLanc)}  força ${x.forca}  ${x.arq.slice(0, 50)}`);
    }

    // ── (2) por que a SOMA (D) não ganhou? ─────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(2) NOS ÓRFÃOS, O LANÇADO É A PARCELA OU O TOTAL?');
    console.log('═'.repeat(76));
    const orfaos = [...grupos].filter(([, g]) => !g.some(x => !x.parcela));
    console.log(`\n   grupos só com parcelas: ${orfaos.length}`);
    let batePrimeira = 0, bateSoma = 0, bateNenhum = 0, semPar = 0;
    for (const [b, g] of orfaos) {
        // achar o lançamento pareado deste arquivo
        let vLanc = null;
        for (const [, x] of parC) if (semPN(x.arq) === b) { vLanc = x.vLanc; break; }
        if (vLanc == null) { semPar++; continue; }
        const pars = g.filter(x => x.parcela).sort((a, b2) => a.ordem - b2.ordem);
        const vPrim = paraNumero(primeiro(pars[0].d, CAMPOS.valor));
        let soma = 0;
        for (const l of pars) { const v = paraNumero(primeiro(l.d, CAMPOS.valor)); if (v) soma += v; }
        soma = Number(soma.toFixed(2));
        if (vPrim != null && Math.abs(vPrim - vLanc) < 0.02) batePrimeira++;
        else if (Math.abs(soma - vLanc) < 0.02) bateSoma++;
        else bateNenhum++;
    }
    console.log(`   sem par no painel:                 ${semPar}`);
    console.log(`   o lançado bate com a 1ª PARCELA:   ${batePrimeira}`);
    console.log(`   o lançado bate com a SOMA:         ${bateSoma}`);
    console.log(`   não bate com nenhum:               ${bateNenhum}`);
    console.log('\n   → explica por que D (soma) não superou C: nesses casos a');
    console.log('     contabilidade lança a PARCELA, não o total do carnê.');

    // ── (3) C é estável? ───────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(3) ESTABILIDADE: a construção de C é determinística?');
    console.log('═'.repeat(76));
    const idxC2 = construir(grupos, g => fundir(g.slice().sort(ordenaDocPrimeiro)));
    let difs = 0;
    for (const k of Object.keys(idxC)) {
        const a = JSON.stringify(idxC[k]), b = JSON.stringify(idxC2[k]);
        if (a !== b) difs++;
    }
    console.log(`\n   entradas diferentes entre duas construções: ${difs}  ${difs ? '⚠' : '✓ determinística'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
