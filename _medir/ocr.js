/**
 * _medir/ocr.js — indexa o que o OCR já gravou, por ARQUIVO.
 *
 * O pareamento hoje lê só o NOME do arquivo. O scheduler já extraiu, do miolo do
 * PDF, número da NF, emitente, valor e CNPJ, e gravou em
 * nfs.RELATORIOS_CONFERENCIA (coluna `dados_parser`, JSON, e coluna `cnpj`).
 * Este módulo transforma isso num índice arquivo → campos, para a medição poder
 * usá-lo como segundo sinal.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const arquivoBase = s => String(s || '').replace(/#p\d+$/i, '');

function separarCsv(linha) {
    const out = [];
    let atual = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (aspas) {
            if (c === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
            else atual += c;
        } else if (c === '"') aspas = true;
        else if (c === ';') { out.push(atual); atual = ''; }
        else atual += c;
    }
    out.push(atual);
    return out;
}

// "32233,6" / "R$ 1.234,56" / "1234.56" → número
function paraNumero(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? v : null;
    let s = String(v).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
    if (!s) return null;
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/,/.test(s) && !/\.\d/.test(s)) s = s.replace(/,/g, '');
    const n = Number(s);
    return isFinite(n) && n > 0 ? n : null;
}

// "31/12/2025" → epoch ms UTC
function paraData(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
}

const soDigitos = s => String(s || '').replace(/\D/g, '');

// Primeira chave presente, entre variações de nome que o parser usa.
function primeiro(obj, chaves) {
    for (const k of chaves) {
        const v = obj[k];
        if (v != null && String(v).trim() !== '') return v;
    }
    return null;
}

/**
 * Devolve { "arquivo.pdf": { numero, emitente, valor, cnpj, dtEmissao } }
 * Chave é o nome do arquivo SEM o sufixo #pN (carnê tem uma linha por parcela).
 * Quando o mesmo arquivo aparece em várias linhas, os campos são fundidos —
 * a parcela traz valor da parcela, o cabeçalho traz o valor da nota.
 */
async function indexar() {
    const cache = path.join(h.CACHE, 'ocr.json');
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    const idx = {};
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo');
        const iParser = cols.indexOf('dados_parser');
        const iCnpj = cols.indexOf('cnpj');
        if (iArq < 0) continue;

        for (let i = 1; i < ls.length; i++) {
            const campos = separarCsv(ls[i]);
            const arq = arquivoBase(campos[iArq] || '').trim();
            if (!arq) continue;

            let d = {};
            const bruto = iParser >= 0 ? (campos[iParser] || '').trim() : '';
            if (bruto.startsWith('{')) { try { d = JSON.parse(bruto); } catch (e) { d = {}; } }

            const numero = primeiro(d, ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF']);
            const emitente = primeiro(d, ['Emitente', 'Razão social', 'Nome do emitente']);
            const valor = primeiro(d, ['Valor total da nota', 'Valor total', 'Valor do boleto']);
            const cnpjP = primeiro(d, ['CNPJ emitente', 'CNPJ / CPF', 'CNPJ']);
            const cnpjC = iCnpj >= 0 ? (campos[iCnpj] || '').trim() : '';
            const dtEmi = primeiro(d, ['Data de emissão', 'Data emissao']);

            const at = idx[arq] || (idx[arq] = {});
            if (numero && !at.numero) at.numero = soDigitos(numero);
            if (emitente && !at.emitente) at.emitente = String(emitente);
            if (valor != null && at.valor == null) { const v = paraNumero(valor); if (v) at.valor = v; }
            const cn = soDigitos(cnpjP || cnpjC);
            if (cn.length >= 11 && !at.cnpj) at.cnpj = cn;
            if (dtEmi && at.dtEmissao == null) { const t = paraData(dtEmi); if (t) at.dtEmissao = t; }
        }
    }
    fs.writeFileSync(cache, JSON.stringify(idx));
    return idx;
}

module.exports = { indexar, paraNumero, paraData, soDigitos };
