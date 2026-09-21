/**
 * _medir/_harness-variantes-de-conserto.js — seis formas de consertar o índice
 *
 * DEFEITO: `_medir/ocr.js` funde as linhas `#pN` com a do documento e fica com o
 * PRIMEIRO valor visto — que costuma ser o da parcela.
 *
 * ANATOMIA (`_harness-anatomia-do-conflito.js`):
 *   • 4.844 arquivos, 541 com documento E parcela
 *   • **637 grupos SÓ com parcelas** — não há linha de documento para preferir
 *   • contamina numero (29,9%), cnpj (25,7%), valor (23,7%), emitente (19,2%)
 *   • 40 arquivos aparecem em 2 relatórios (1 com valor divergente)
 *
 * Os 637 órfãos matam a variante ingênua: "prefira a linha sem sufixo" os deixaria
 * sem dado nenhum, trocando um defeito por outro. Por isso seis variantes:
 *
 *   A  ATUAL          — primeiro valor visto (o defeito, como referência)
 *   B  SÓ DOCUMENTO   — ignora `#pN` por completo
 *   C  DOC PRIMEIRO   — ordena documento antes de parcela, mantém a fusão
 *   D  DOC, SENÃO SOMA— documento; se só há parcelas, SOMA as parcelas
 *   E  DOC, SENÃO 1ª  — documento; se só há parcelas, usa a primeira parcela
 *   F  POR CAMPO      — cada campo da melhor fonte: valor do doc (ou soma das
 *                       parcelas), identidade (numero/cnpj/emitente) de qualquer
 *                       linha, porque não variam entre parcelas
 *
 * ── O JUIZ ──────────────────────────────────────────────────────────────────
 * O valor LANÇADO na planilha, via pares do painel. Não é circular: nenhuma
 * variante olha a planilha. Métrica dupla, porque uma só engana:
 *   • ACERTO: valor do índice == valor lançado
 *   • COBERTURA: o índice tem valor? (variante que se cala acerta 100% de nada)
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
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

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

// monta a entrada do índice a partir de uma lista ORDENADA de linhas
function fundir(lista) {
    const at = {};
    for (const l of lista) {
        const numero = primeiro(l.d, CAMPOS.numero);
        const emitente = primeiro(l.d, CAMPOS.emitente);
        const valor = primeiro(l.d, CAMPOS.valor);
        const cnpjP = primeiro(l.d, CAMPOS.cnpj);
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

const VARIANTES = {
    A_atual: (g) => fundir(g.slice().sort((a, b) => a.ordem - b.ordem)),

    B_so_documento: (g) => {
        const docs = g.filter(x => !x.parcela);
        return docs.length ? fundir(docs) : {};
    },

    C_doc_primeiro: (g) => fundir(g.slice().sort((a, b) =>
        (a.parcela ? 1 : 0) - (b.parcela ? 1 : 0) || a.ordem - b.ordem)),

    D_doc_senao_soma: (g) => {
        const docs = g.filter(x => !x.parcela);
        if (docs.length) return fundir(docs);
        const pars = g.filter(x => x.parcela);
        const at = fundir(pars);
        // só há parcelas: o valor do documento é a SOMA delas
        let soma = 0, n = 0;
        for (const l of pars) { const v = paraNumero(primeiro(l.d, CAMPOS.valor)); if (v) { soma += v; n++; } }
        if (n) at.valor = Number(soma.toFixed(2));
        return at;
    },

    E_doc_senao_primeira: (g) => {
        const docs = g.filter(x => !x.parcela);
        if (docs.length) return fundir(docs);
        return fundir(g.filter(x => x.parcela).sort((a, b) => a.ordem - b.ordem));
    },

    F_por_campo: (g) => {
        const docs = g.filter(x => !x.parcela);
        const pars = g.filter(x => x.parcela);
        // identidade: qualquer linha serve (não varia entre parcelas)
        const at = fundir(g.slice().sort((a, b) =>
            (a.parcela ? 1 : 0) - (b.parcela ? 1 : 0) || a.ordem - b.ordem));
        // VALOR: só do documento; se não houver, soma das parcelas
        at.valor = undefined;
        let v = null;
        for (const l of docs) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
        if (v == null && pars.length) {
            let soma = 0, n = 0;
            for (const l of pars) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { soma += x; n++; } }
            if (n) v = Number(soma.toFixed(2));
        }
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

    // construir um índice por variante
    const indices = {};
    for (const k of Object.keys(VARIANTES)) {
        indices[k] = {};
        for (const [base, g] of grupos) {
            const e = VARIANTES[k](g);
            if (e && Object.keys(e).length) indices[k][base] = e;
        }
    }

    console.log('═'.repeat(78));
    console.log('SEIS VARIANTES DE CONSERTO DO ÍNDICE');
    console.log('═'.repeat(78));
    console.log('\n── cobertura bruta do índice ───────────────────────────────');
    console.log('variante              arquivos   com valor   com numero   com cnpj');
    for (const k of Object.keys(VARIANTES)) {
        const idx = indices[k];
        const n = Object.keys(idx).length;
        const cv = Object.values(idx).filter(x => x.valor != null).length;
        const cn = Object.values(idx).filter(x => x.numero).length;
        const cc = Object.values(idx).filter(x => x.cnpj).length;
        console.log(`  ${k.padEnd(20)} ${String(n).padStart(6)}   ${String(cv).padStart(9)}   ${String(cn).padStart(10)}   ${String(cc).padStart(8)}`);
    }

    // ── o JUIZ: o valor lançado ────────────────────────────────────────────
    const c = h.carregar();
    console.log('\n── julgado pelo VALOR LANÇADO (via pares do painel) ────────');
    console.log('variante              pares   valor OK   sem valor   ERRADO   acerto');
    const resultado = {};
    for (const k of Object.keys(VARIANTES)) {
        const idx = indices[k];
        let pares = 0, ok = 0, semValor = 0, errado = 0;
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
                if (!vLanc) continue;
                pares++;
                const e = idx[semPN(x.documento.arquivo)];
                const vIdx = e && e.valor != null ? e.valor : null;
                if (vIdx == null) semValor++;
                else if (Math.abs(vIdx - vLanc) < 0.02) ok++;
                else errado++;
            }
        }
        resultado[k] = { pares, ok, semValor, errado };
        const comValor = ok + errado;
        console.log(`  ${k.padEnd(20)} ${String(pares).padStart(5)}   ${String(ok).padStart(8)}   ${String(semValor).padStart(9)}   ${String(errado).padStart(6)}   ${pct(ok, comValor).padStart(6)}`);
    }

    console.log('\nLEITURA: "acerto" é sobre os que TÊM valor. Uma variante que se cala');
    console.log('muito (sem valor alto) pode ter acerto bonito e servir menos.');
    console.log('O que interessa é `valor OK` em números absolutos.');

    const A = resultado.A_atual;
    console.log('\n── ganho contra o índice ATUAL ─────────────────────────────');
    for (const [k, v] of Object.entries(resultado)) {
        if (k === 'A_atual') continue;
        console.log(`  ${k.padEnd(20)} valor OK ${v.ok - A.ok >= 0 ? '+' : ''}${v.ok - A.ok}   errados ${v.errado - A.errado >= 0 ? '+' : ''}${v.errado - A.errado}   sem valor ${v.semValor - A.semValor >= 0 ? '+' : ''}${v.semValor - A.semValor}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
