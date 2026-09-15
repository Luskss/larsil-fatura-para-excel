/**
 * _medir/_emitente-qualidade.js — a correção em massa do `Emitente` (trocar "LARSIL"
 * pelo nome extraído do arquivo) trocaria 1.599 linhas, mas a amostra mostrou lixo:
 * "R$ 13.721,99- CDC VEICULOS P.JURIDICA - PRE", "GRUPO 1153 COTA", "03;20.PRIMO ROSSI".
 *
 * Antes de gravar qualquer coisa, esta medição separa o que `extrairEmitente` produz
 * em BOM e LIXO, por sinais objetivos:
 *   · contém dígito, "R$", ou trecho de data       → resíduo do nome do arquivo
 *   · é rótulo de consórcio ("GRUPO … COTA")       → não é entidade
 *   · é nome de banco/produto financeiro           → não é fornecedor
 *   · muito longo (>40 chars) ou muito curto (<3)  → não é razão social
 *
 * A pergunta que decide: em quantos casos a troca MELHORA de fato?
 *
 * Uso: node _medir/_emitente-qualidade.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection } = require('../config');
const { extrairEmitente } = require('../routes/_nf-parsers');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

function parseCsv(txt) {
    txt = String(txt || '').replace(/^﻿/, '');
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === ';') { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

const ehLarsil = s => /\bLARSIL\b/i.test(String(s ?? ''));

// Motivo pelo qual o nome extraído NÃO serve como entidade. Devolve '' quando serve.
function motivoLixo(s) {
    const t = String(s || '').trim();
    if (t.length < 3) return 'curto demais';
    if (t.length > 40) return 'longo demais (frase, não nome)';
    if (/R\$|\d{1,3}\.\d{3},\d{2}|\d+,\d{2}/.test(t)) return 'contém valor monetário';
    if (/\b\d{2}[./;-]\d{2}\b|\b20\d{2}\b/.test(t)) return 'contém data';
    if (/^GRUPO\b|\bCOTA\b/i.test(t)) return 'rótulo de consórcio';
    if (/\bCDC\b|\bFT\d|\bFN\b|ANEXAR|EXTRATO/i.test(t)) return 'rótulo bancário/operação';
    if (/\d/.test(t)) return 'contém dígito';
    return '';
}

(async () => {
    const pool = await getConnection();
    const r = await pool.request().query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    let comLarsil = 0, bons = 0, lixos = 0, semNome = 0, tambemLarsil = 0;
    const porMotivo = new Map();
    const exBons = [], exLixo = [];

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        for (const row of rows.slice(1)) {
            if (!row[i('arquivo')]) continue;
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || !ehLarsil(d['Emitente'])) continue;
            comLarsil++;

            const base = String(row[i('arquivo')]).replace(/#p\d+$/i, '');
            const doNome = extrairEmitente(base);
            if (!doNome) { semNome++; continue; }
            if (ehLarsil(doNome)) { tambemLarsil++; continue; }

            const motivo = motivoLixo(doNome);
            if (motivo) {
                lixos++;
                porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
                if (exLixo.length < 6) exLixo.push(`"${doNome}"  (${motivo})\n        de: ${base.slice(0, 62)}`);
            } else {
                bons++;
                if (exBons.length < 6) exBons.push(`"${doNome}"\n        de: ${base.slice(0, 62)}`);
            }
        }
    }

    const pct = n => (comLarsil ? (100 * n / comLarsil).toFixed(1) + '%' : '—');
    console.log(`linhas com "LARSIL" no Emitente     ${comLarsil}\n`);
    console.log(`o nome do arquivo daria:`);
    console.log(`  nome utilizável                   ${bons}  ${pct(bons)}   ← a troca melhora`);
    console.log(`  LIXO (valor, data, rótulo)        ${lixos}  ${pct(lixos)}   ← a troca PIORA`);
    console.log(`  também LARSIL (documento nosso)   ${tambemLarsil}  ${pct(tambemLarsil)}   ← já está certo`);
    console.log(`  nada                              ${semNome}  ${pct(semNome)}`);

    if (porMotivo.size) {
        console.log(`\npor que o nome não serve:`);
        for (const [k, v] of [...porMotivo].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
    }
    if (exBons.length) { console.log(`\nexemplos BONS:`); for (const e of exBons) console.log(`   · ${e}`); }
    if (exLixo.length) { console.log(`\nexemplos LIXO:`); for (const e of exLixo) console.log(`   · ${e}`); }
})().catch(e => { console.error(e); process.exit(1); });
