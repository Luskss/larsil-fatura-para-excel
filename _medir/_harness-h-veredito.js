/**
 * _medir/_harness-h-veredito.js — H é a escolhida: o que ela estraga e resiste?
 *
 * QUADRO FINAL (`_harness-sem-a-soma.js`), contra o índice atual:
 *
 *   variante              CURA  ESTRAGA  saldo   força3  valorOK  semValor
 *   F_com_soma             27      13     +14      +2      +14       -1
 *   G_sem_soma             15      14      +1      -8       -1      +28
 *   H_primeira_parcela     15       1     +14      -1      +15       +0
 *
 * F e H empatam em saldo (+14), mas F ESTRAGA 13 e H estraga 1. F "cura mais"
 * porque quebra mais e depois recupera — ruído, não ganho. H é cirúrgica.
 * G (sem valor nos órfãos) é a pior: perde cobertura e força 3.
 *
 * A regra de H:
 *   • IDENTIDADE (numero, cnpj, emitente, data): qualquer linha, documento antes
 *   • VALOR: da linha de DOCUMENTO; se só houver parcelas, a PRIMEIRA parcela
 *
 * A segunda cláusula não foi escolha estética: `_harness-c-versus-f.js` mediu nos
 * 637 órfãos que o lançado bate com a 1ª parcela em 20 casos e com a soma em 4.
 *
 * ── O que falta ─────────────────────────────────────────────────────────────
 *   1. o único ESTRAGADO: é aceitável?
 *   2. repetir 2× ([[repetir-o-ganho-antes-de-somar]])
 *   3. H mexe nos campos de IDENTIDADE de quantos arquivos? (o defeito original
 *      contaminava numero em 29,9% e cnpj em 25,7%)
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
const H = g => {
    const docs = g.filter(x => !x.parcela), pars = g.filter(x => x.parcela);
    const at = fundir(g.slice().sort(docPrimeiro));
    let v = null;
    for (const l of docs) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
    if (v == null && pars.length)
        for (const l of pars.slice().sort(porOrdem)) { const x = paraNumero(primeiro(l.d, CAMPOS.valor)); if (x) { v = x; break; } }
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

    // ── (1) repetir 2× ─────────────────────────────────────────────────────
    console.log('═'.repeat(78));
    console.log('(1) H REPETIDA 2×');
    console.log('═'.repeat(78));
    const rod = [];
    for (let i = 0; i < 2; i++) {
        const a = medir(construir(A_atual)), x = medir(construir(H));
        let cura = 0, estraga = 0;
        for (const [id, va] of a.porLanc) {
            const vx = x.porLanc.get(id); if (!vx) continue;
            if (va.estado !== 'ok' && vx.estado === 'ok') cura++;
            if (va.estado === 'ok' && vx.estado !== 'ok') estraga++;
        }
        rod.push({ a, x, cura, estraga });
        console.log(`   rodada ${i + 1}:  CURA ${cura}   ESTRAGA ${estraga}   valorOK ${x.ok - a.ok >= 0 ? '+' : ''}${x.ok - a.ok}   força3 ${x.forca[3] - a.forca[3] >= 0 ? '+' : ''}${x.forca[3] - a.forca[3]}`);
    }
    console.log(`\n   ${rod[0].cura === rod[1].cura && rod[0].estraga === rod[1].estraga ? '✓ idêntica nas duas' : '⚠ instável'}`);

    // ── (2) o único estragado ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O QUE H ESTRAGA');
    console.log('═'.repeat(78));
    const { a: A, x: X } = rod[0];
    for (const [id, va] of A.porLanc) {
        const vx = X.porLanc.get(id); if (!vx) continue;
        if (va.estado === 'ok' && vx.estado !== 'ok') {
            console.log(`\n   lançado=${brl(va.vLanc)}`);
            console.log(`      A: ${brl(va.vIdx)} (${va.estado})  f${va.forca}  ${va.arq.slice(0, 50)}`);
            console.log(`      H: ${vx.vIdx == null ? '(sem valor)' : brl(vx.vIdx)} (${vx.estado})  f${vx.forca}  ${vx.arq.slice(0, 50)}`);
            const g = grupos.get(semPN(vx.arq)) || [];
            console.log(`      o grupo tem ${g.filter(y => !y.parcela).length} doc + ${g.filter(y => y.parcela).length} parcelas`);
        }
    }

    // ── (3) quanto a IDENTIDADE muda ───────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) QUANTOS ARQUIVOS MUDAM DE IDENTIDADE');
    console.log('═'.repeat(78));
    const iA = construir(A_atual), iH = construir(H);
    const mudou = { numero: 0, cnpj: 0, emitente: 0, valor: 0, dtEmissao: 0 };
    for (const k of Object.keys(iH)) {
        const a = iA[k] || {}, x = iH[k] || {};
        for (const campo of Object.keys(mudou))
            if (String(a[campo] == null ? '' : a[campo]) !== String(x[campo] == null ? '' : x[campo])) mudou[campo]++;
    }
    console.log('');
    for (const [c2, n] of Object.entries(mudou))
        console.log(`   ${c2.padEnd(12)} ${String(n).padStart(4)} arquivos  ${pct(n, Object.keys(iH).length)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
