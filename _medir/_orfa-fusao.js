/**
 * _medir/_orfa-fusao.js — se apagar a linha velha perde dado (577 têm `Itens` que a
 * nova não tem) e mantê-la joga o pareamento no acaso, resta FUNDIR: uma linha por
 * PDF, na pasta nova, campo a campo.
 *
 * Este medidor simula a fusão sem gravar nada e responde:
 *   1. quantos campos a linha fundida ganharia em relação à nova sozinha;
 *   2. em quantos casos há CONFLITO real (as duas têm o campo, com valores diferentes)
 *      — é aí que a fusão precisa de uma regra, e não de um `Object.assign`;
 *   3. se a regra "a nova vence, menos quando traz o CNPJ da LARSIL" resolve os
 *      conflitos de CNPJ, medida contra o valor escrito no nome do arquivo.
 *
 * Uso: node _medir/_orfa-fusao.js [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');

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
const CNPJ_LARSIL = '8420245000180';
const CHAVES_VALOR = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
const vazio = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const primeiro = (d, ks) => { for (const k of ks) if (d && d[k] && String(d[k]).trim() !== '—') return String(d[k]).trim(); return ''; };

function centavos(s) {
    if (!s) return null;
    let t = String(s).trim().replace(/[R$\s]/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function valorDoNome(nome) {
    const m = String(nome).match(/^\s*\d{1,4}\s*[.\-]?\s*DOC[.\-\s]*R?\$?\s*([\d.]{1,12},\d{2})/i);
    return m ? centavos(m[1]) : null;
}

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let grupos = 0, camposGanhos = 0, gruposQueGanham = 0;
    let conflitos = 0, gruposComConflito = 0;
    const conflitoPorCampo = new Map();

    // a regra proposta: nova vence, menos quando o CNPJ dela é o da LARSIL
    let regraAvaliada = 0, regraAcerta = 0, regraErra = 0, regraEmpate = 0;

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);

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
            grupos++;

            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const dN = pj(novas[0]), dV = pj(velhas[0]);

            let ganhou = 0, bateu = 0;
            for (const k of Object.keys(dV)) {
                if (vazio(dV[k])) continue;
                if (vazio(dN[k])) { ganhou++; continue; }
                if (String(dV[k]) !== String(dN[k])) {
                    bateu++;
                    conflitoPorCampo.set(k, (conflitoPorCampo.get(k) || 0) + 1);
                }
            }
            camposGanhos += ganhou;
            conflitos += bateu;
            if (ganhou) gruposQueGanham++;
            if (bateu) gruposComConflito++;

            // avalia a regra proposta contra o valor do nome
            const alvo = valorDoNome(arq);
            if (alvo != null) {
                const cN = digitos(novas[0][i('cnpj')] || dN['CNPJ emitente']);
                const preferirVelha = cN === CNPJ_LARSIL;
                const escolhido = preferirVelha ? dV : dN;
                const outro     = preferirVelha ? dN : dV;
                const vE = centavos(primeiro(escolhido, CHAVES_VALOR));
                const vO = centavos(primeiro(outro, CHAVES_VALOR));
                if (vE != null || vO != null) {
                    regraAvaliada++;
                    const okE = vE === alvo, okO = vO === alvo;
                    if (okE && !okO) regraAcerta++;
                    else if (okO && !okE) regraErra++;
                    else regraEmpate++;
                }
            }
        }
    }

    console.log(`escopo: ${periodoArg || 'todos os meses'}\n`);
    console.log(`grupos duplicados analisados            ${grupos}`);
    console.log(`\n── o que a FUSÃO ganharia ──`);
    console.log(`campos que só a velha tem               ${camposGanhos}`);
    console.log(`grupos que ganhariam ao menos 1 campo   ${gruposQueGanham}`);
    console.log(`\n── onde a fusão precisa de REGRA (as duas têm, com valores diferentes) ──`);
    console.log(`conflitos de campo                      ${conflitos}`);
    console.log(`grupos com ao menos 1 conflito          ${gruposComConflito}`);
    if (conflitoPorCampo.size) {
        console.log(`\ncampos que mais conflitam:`);
        for (const [k, n] of [...conflitoPorCampo].sort((a, b) => b[1] - a[1]).slice(0, 12))
            console.log(`   ${String(n).padStart(5)}  ${k}`);
    }

    console.log(`\n── regra proposta: "a nova vence, menos quando traz o CNPJ da LARSIL" ──`);
    console.log(`(julgada pelo valor escrito no nome do arquivo)`);
    console.log(`casos avaliados                         ${regraAvaliada}`);
    console.log(`  a regra escolhe a linha CERTA          ${regraAcerta}`);
    console.log(`  a regra escolhe a linha ERRADA         ${regraErra}`);
    console.log(`  empate (as duas certas ou as duas erradas) ${regraEmpate}`);
})().catch(e => { console.error(e); process.exit(1); });
