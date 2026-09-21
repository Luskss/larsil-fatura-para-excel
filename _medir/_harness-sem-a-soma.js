/**
 * _medir/_harness-sem-a-soma.js — a soma das parcelas é que estraga F
 *
 * ACHADO (`_harness-f-e-a-melhor.js`): F cura 26 e ESTRAGA 13. O padrão dos
 * estragados denuncia a causa:
 *
 *     2.004,52 → 4.009,04   (2×)
 *       669,06 → 1.338,12   (2×)
 *       210,00 →   630,00   (3×)
 *     6.120,00 → 30.600,00  (5×)
 *
 * É a SOMA DAS PARCELAS, usada quando não há linha de documento. Ela supõe que o
 * lançamento é o total do carnê — mas `_harness-c-versus-f.js` já tinha medido o
 * contrário nos órfãos: **o lançado bate com a 1ª parcela em 20 casos e com a
 * soma em apenas 4**. Eu implementei a soma mesmo com esse dado na mão.
 *
 * ── As variantes finais ─────────────────────────────────────────────────────
 *   A  atual                         (referência)
 *   F  por campo + SOMA nos órfãos   (cura 26, estraga 13)
 *   G  por campo, SEM soma           — valor só do documento; órfão fica sem valor
 *   H  por campo + 1ª PARCELA        — órfão usa a primeira parcela (o que os dados dizem)
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

// base comum de F/G/H: identidade de qualquer linha, documento primeiro
function identidade(g) { return fundir(g.slice().sort(docPrimeiro)); }
function valorDoDocumento(docs) {
    for (const l of docs) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) return x; }
    return null;
}

const VARIANTES = {
    A_atual: g => fundir(g.slice().sort(porOrdem)),

    F_com_soma: g => {
        const docs = g.filter(x => !x.parcela), pars = g.filter(x => x.parcela);
        const at = identidade(g);
        let v = valorDoDocumento(docs);
        if (v == null && pars.length) { let s = 0, n = 0;
            for (const l of pars) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { s += x; n++; } }
            if (n) v = Number(s.toFixed(2)); }
        if (v != null) at.valor = v; else delete at.valor;
        return at;
    },

    G_sem_soma: g => {
        const docs = g.filter(x => !x.parcela);
        const at = identidade(g);
        const v = valorDoDocumento(docs);
        if (v != null) at.valor = v; else delete at.valor;
        return at;
    },

    H_primeira_parcela: g => {
        const docs = g.filter(x => !x.parcela), pars = g.filter(x => x.parcela);
        const at = identidade(g);
        let v = valorDoDocumento(docs);
        if (v == null && pars.length) {
            const ord = pars.slice().sort(porOrdem);
            for (const l of ord) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
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

    const res = {};
    for (const k of Object.keys(VARIANTES)) res[k] = medir(construir(VARIANTES[k]));

    console.log('═'.repeat(78));
    console.log('A SOMA DAS PARCELAS ERA O PROBLEMA?');
    console.log('═'.repeat(78));
    console.log('\nvariante              força3  força2  força1   valorOK  errados  semValor');
    for (const [k, v] of Object.entries(res))
        console.log(`  ${k.padEnd(20)} ${String(v.forca[3]).padStart(6)}  ${String(v.forca[2]).padStart(6)}  ${String(v.forca[1]).padStart(6)}   ${String(v.ok).padStart(7)}  ${String(v.errado).padStart(7)}  ${String(v.semValor).padStart(8)}`);

    const A = res.A_atual;
    console.log('\n── contra o ATUAL, e o balanço cura/estraga ────────────────');
    for (const [k, v] of Object.entries(res)) {
        if (k === 'A_atual') continue;
        let cura = 0, estraga = 0;
        for (const [id, a] of A.porLanc) {
            const x = v.porLanc.get(id);
            if (!x) continue;
            if (a.estado !== 'ok' && x.estado === 'ok') cura++;
            if (a.estado === 'ok' && x.estado !== 'ok') estraga++;
        }
        const sinal = n => (n >= 0 ? '+' : '') + n;
        console.log(`\n  ${k}`);
        console.log(`     CURA ${String(cura).padStart(3)}   ESTRAGA ${String(estraga).padStart(3)}   saldo ${sinal(cura - estraga)}`);
        console.log(`     força3 ${sinal(v.forca[3] - A.forca[3])}   valorOK ${sinal(v.ok - A.ok)}   errados ${sinal(v.errado - A.errado)}   semValor ${sinal(v.semValor - A.semValor)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
