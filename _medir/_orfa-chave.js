/**
 * _medir/_orfa-chave.js — a medição de `_orfa-regra.js` deu VELHA 80 × 0 NOVA nos
 * conflitos de chave de acesso. 100% é forte demais para aceitar sem olhar: pode ser
 * que a linha nova não grave chave nenhuma (e o "conflito" seja artefato), ou que
 * grave truncada/concatenada.
 *
 * Imprime os pares em conflito para inspeção direta.
 *
 * Uso: node _medir/_orfa-chave.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection } = require('../config');

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

const RE_PASTA_NOVA = /^\d{4}\.\d{2}\.[^/]*EXTRATOS/i;
function chaveValida(ch) {
    const s = String(ch ?? '').replace(/\D/g, '');
    if (s.length !== 44) return false;
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return dv === Number(s[43]);
}

(async () => {
    const quantos = Number(process.argv[2] || 10);
    const pool = await getConnection();
    const r = await pool.request().query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    let n = 0;
    const tam = { nova: new Map(), velha: new Map() };
    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = c => h.indexOf(c);
        const porArquivo = new Map();
        for (const row of rows.slice(1)) {
            const arq = row[i('arquivo')];
            if (!arq) continue;
            if (!porArquivo.has(arq)) porArquivo.set(arq, []);
            porArquivo.get(arq).push(row);
        }
        for (const [arq, grupo] of porArquivo) {
            if (grupo.length < 2) continue;
            if (new Set(grupo.map(g => g[i('pasta')])).size < 2) continue;
            const novas  = grupo.filter(g => RE_PASTA_NOVA.test(g[i('pasta')]));
            const velhas = grupo.filter(g => !RE_PASTA_NOVA.test(g[i('pasta')]));
            if (!novas.length || !velhas.length) continue;
            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const dN = pj(novas[0]), dV = pj(velhas[0]);
            const a = dN['Chave de acesso'], b = dV['Chave de acesso'];
            if (!a || !b) continue;
            const da = String(a).replace(/\D/g, ''), db = String(b).replace(/\D/g, '');
            if (da === db) continue;
            tam.nova.set(da.length, (tam.nova.get(da.length) || 0) + 1);
            tam.velha.set(db.length, (tam.velha.get(db.length) || 0) + 1);
            if (n++ < quantos) {
                console.log(`${rec.PERIODO} · ${arq}`);
                console.log(`   nova  (${String(da.length).padStart(2)} díg) ${a}   ${chaveValida(a) ? 'DV ok' : 'DV INVÁLIDO'}`);
                console.log(`   velha (${String(db.length).padStart(2)} díg) ${b}   ${chaveValida(b) ? 'DV ok' : 'DV INVÁLIDO'}`);
                console.log('');
            }
        }
    }
    console.log(`total de conflitos de chave: ${n}\n`);
    for (const lado of ['nova', 'velha']) {
        console.log(`tamanho da chave na linha ${lado}:`);
        for (const [k, v] of [...tam[lado]].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(4)} × ${k} dígitos`);
    }
})().catch(e => { console.error(e); process.exit(1); });
