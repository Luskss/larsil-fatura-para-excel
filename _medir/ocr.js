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
// Linha de PARCELA de carnê ("...pdf#p3"), que traz o valor daquela parcela e não
// o do documento. Distinguir as duas é o que a regra de fusão precisa saber.
const ehParcela = s => /#p\d+$/i.test(String(s || ''));

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
 *
 * ── A REGRA DE FUSÃO (corrigida em 21/09/2026) ──────────────────────────────
 * Um carnê gera N+1 linhas: a do DOCUMENTO e uma por PARCELA (`#p1`…`#pN`), com
 * valores legitimamente diferentes. A versão anterior removia o sufixo e ficava
 * com o PRIMEIRO valor visto — e as parcelas vêm antes no CSV, então o índice
 * descrevia o documento com o valor da parcela.
 *
 * O estrago era real e me custou um dia: medindo com esse índice eu "achei" 58
 * documentos com valor errado, rastreei até uma trava em `_valor-do-pagamento.js`,
 * implementei um conserto e só descobri o engano ao testar o carnê. A linha do
 * documento já estava certa no banco ([[trava-do-boleto-maior-barra-a-ld]]).
 *
 * A regra agora separa dois tipos de campo:
 *
 *   IDENTIDADE (numero, cnpj, emitente, dtEmissao) — não varia entre as parcelas
 *     do mesmo documento, então qualquer linha serve; ordena documento primeiro
 *     só para desempatar.
 *
 *   VALOR — varia, e só a linha de DOCUMENTO tem o valor do documento. Quando o
 *     grupo só tem parcelas (637 casos: o carnê gerou parcelas e nenhuma linha de
 *     documento), usa a PRIMEIRA parcela.
 *
 * A última cláusula foi MEDIDA, não escolhida: nos 637 órfãos, o valor lançado na
 * planilha bate com a 1ª parcela em 20 casos e com a SOMA das parcelas em 4. Somar
 * parece mais "correto" e é pior — a variante que soma estraga 13 pares
 * (`_medir/_harness-sem-a-soma.js`).
 *
 * Medido contra o valor lançado, jan–jun/2026, repetido 2× com resultado idêntico:
 *
 *   variante                      CURA  ESTRAGA  força3  valorOK
 *   só linha de documento           15      14      -8       -1
 *   por campo + SOMA nos órfãos     27      13      +2      +14
 *   ESTA (por campo + 1ª parcela)   15       1      -1      +15
 *
 * O único "estragado" não é regressão: é um lançamento de R$ 3.340 (2× R$ 1.670)
 * migrando entre dois documentos gêmeos, e o grupo nem tem parcelas.
 */
async function indexar() {
    const cache = path.join(h.CACHE, 'ocr.json');
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    // 1ª passada: junta as linhas por arquivo, PRESERVANDO se é parcela e a ordem
    // em que apareceram. Sem guardar isso não dá para escolher a fonte depois.
    const grupos = new Map();
    let ordem = 0;
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
            const arqExato = String(campos[iArq] || '').trim();
            if (!arqExato) continue;
            const arq = arquivoBase(arqExato);

            let d = {};
            const bruto = iParser >= 0 ? (campos[iParser] || '').trim() : '';
            if (bruto.startsWith('{')) { try { d = JSON.parse(bruto); } catch (e) { d = {}; } }

            if (!grupos.has(arq)) grupos.set(arq, []);
            grupos.get(arq).push({
                ordem: ordem++,
                parcela: ehParcela(arqExato),
                d,
                cnpjCol: iCnpj >= 0 ? (campos[iCnpj] || '').trim() : '',
            });
        }
    }

    // 2ª passada: para cada arquivo, escolhe a fonte de cada campo (ver o cabeçalho).
    const idx = {};
    for (const [arq, grupo] of grupos) {
        // documento antes de parcela; dentro de cada tipo, a ordem original
        const ordenado = grupo.slice().sort((a, b) =>
            (a.parcela ? 1 : 0) - (b.parcela ? 1 : 0) || a.ordem - b.ordem);

        const at = {};
        // IDENTIDADE: primeira linha que tiver o campo, documento tendo preferência
        for (const l of ordenado) {
            const numero = primeiro(l.d, ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF']);
            const emitente = primeiro(l.d, ['Emitente', 'Razão social', 'Nome do emitente']);
            const cnpjP = primeiro(l.d, ['CNPJ emitente', 'CNPJ / CPF', 'CNPJ']);
            const dtEmi = primeiro(l.d, ['Data de emissão', 'Data emissao']);
            if (numero && !at.numero) at.numero = soDigitos(numero);
            if (emitente && !at.emitente) at.emitente = String(emitente);
            const cn = soDigitos(cnpjP || l.cnpjCol);
            if (cn.length >= 11 && !at.cnpj) at.cnpj = cn;
            if (dtEmi && at.dtEmissao == null) { const t = paraData(dtEmi); if (t) at.dtEmissao = t; }
        }

        // VALOR: só da linha de DOCUMENTO. Sem ela, a PRIMEIRA parcela (medido:
        // somar as parcelas estraga 13 pares, ver o cabeçalho).
        const CHAVES_VALOR = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
        let v = null;
        for (const l of ordenado) {
            if (l.parcela) continue;
            const x = paraNumero(primeiro(l.d, CHAVES_VALOR));
            if (x) { v = x; break; }
        }
        if (v == null) {
            for (const l of ordenado) {
                if (!l.parcela) continue;
                const x = paraNumero(primeiro(l.d, CHAVES_VALOR));
                if (x) { v = x; break; }
            }
        }
        if (v != null) at.valor = v;

        if (Object.keys(at).length) idx[arq] = at;
    }
    fs.writeFileSync(cache, JSON.stringify(idx));
    return idx;
}

module.exports = { indexar, paraNumero, paraData, soDigitos };
