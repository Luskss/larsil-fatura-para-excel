/**
 * _medir/_emitente-fontes.js — as 1.752 linhas com "LARSIL" no campo `Emitente` (o nome
 * do PAGADOR gravado como se fosse o do fornecedor). A correção pelo NOME DO ARQUIVO
 * está reprovada: medido em `_emitente-qualidade.js`, 72% viraria lixo ("GRUPO 1153
 * COTA", "R$ 13.721,99- CDC VEICULOS…").
 *
 * Antes de concluir que só resta reprocessar, esta medição pergunta: existe OUTRA fonte
 * já gravada que dê o nome certo sem reler o PDF?
 *
 *   a) `Razão social (nota)` — o nome lido da nota, que o pipeline preserva quando
 *      difere do `Emitente`. Se estiver preenchido e não for LARSIL, é o candidato.
 *   b) O CNPJ da linha — se for de terceiro, o mesmo CNPJ em OUTRAS linhas do acervo
 *      (onde o emitente ficou certo) revela a razão social. É um "de-para" construído
 *      do próprio banco, sem inventar nada.
 *   c) A coluna `evidencia`, que grava "IA: <nome>".
 *
 * Uso: node _medir/_emitente-fontes.js
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

const CNPJ_LARSIL = '8420245000180';
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
const ehLarsil = s => /\bLARSIL\b/i.test(String(s ?? ''));
const vazio = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

(async () => {
    const pool = await getConnection();
    const r = await pool.request().query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    // 1ª passada: de-para CNPJ → nomes de emitente vistos em linhas SADIAS
    const nomesPorCnpj = new Map();
    const tabelas = [];
    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        tabelas.push({ periodo: rec.PERIODO, h, i, corpo: rows.slice(1).filter(x => x[i('arquivo')]) });
        for (const row of tabelas[tabelas.length - 1].corpo) {
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d) continue;
            const nome = d['Emitente'];
            if (vazio(nome) || ehLarsil(nome)) continue;      // só as linhas sadias ensinam
            const c = digitos(row[i('cnpj')] || d['CNPJ emitente']);
            if (!c || c === CNPJ_LARSIL) continue;
            if (!nomesPorCnpj.has(c)) nomesPorCnpj.set(c, new Map());
            const m = nomesPorCnpj.get(c);
            m.set(nome, (m.get(nome) || 0) + 1);
        }
    }

    // 2ª passada: para cada linha doente, que fontes existem?
    let doentes = 0;
    const tem = { razaoSocial: 0, cnpjDePara: 0, evidencia: 0, nenhuma: 0 };
    const soRazao = [], soDePara = [];
    let cnpjProprio = 0, semCnpj = 0;

    for (const { periodo, i, corpo } of tabelas) {
        for (const row of corpo) {
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || !ehLarsil(d['Emitente'])) continue;
            doentes++;

            const rs = d['Razão social (nota)'];
            const okRazao = !vazio(rs) && !ehLarsil(rs);

            const c = digitos(row[i('cnpj')] || d['CNPJ emitente']);
            if (!c) semCnpj++; else if (c === CNPJ_LARSIL) cnpjProprio++;
            const cands = (c && c !== CNPJ_LARSIL) ? nomesPorCnpj.get(c) : null;
            const okDePara = !!(cands && cands.size);

            const ev = String(row[i('evidencia')] || '').replace(/^IA:\s*/, '');
            const okEvid = !vazio(ev) && !ehLarsil(ev) && ev !== 'IA';

            if (okRazao) tem.razaoSocial++;
            if (okDePara) tem.cnpjDePara++;
            if (okEvid) tem.evidencia++;
            if (!okRazao && !okDePara && !okEvid) tem.nenhuma++;

            if (okRazao && soRazao.length < 5)
                soRazao.push(`${periodo} · ${String(row[i('arquivo')]).slice(0, 52)}\n        "${d['Emitente']}" → "${rs}"`);
            if (!okRazao && okDePara && soDePara.length < 5) {
                const melhor = [...cands].sort((a, b) => b[1] - a[1])[0];
                soDePara.push(`${periodo} · ${String(row[i('arquivo')]).slice(0, 52)}\n        CNPJ ${c} → "${melhor[0]}"  (visto ${melhor[1]}× no acervo, ${cands.size} nome(s) distinto(s))`);
            }
        }
    }

    const pct = n => (doentes ? (100 * n / doentes).toFixed(1) + '%' : '—');
    console.log(`linhas com "LARSIL" no Emitente  ${doentes}\n`);
    console.log(`CNPJ dessas linhas:`);
    console.log(`  da própria LARSIL              ${cnpjProprio}`);
    console.log(`  ausente                        ${semCnpj}`);
    console.log(`  de terceiro                    ${doentes - cnpjProprio - semCnpj}`);
    console.log(`\nfontes disponíveis SEM reler o PDF:`);
    console.log(`  Razão social (nota) utilizável ${tem.razaoSocial}  ${pct(tem.razaoSocial)}`);
    console.log(`  de-para por CNPJ do acervo     ${tem.cnpjDePara}  ${pct(tem.cnpjDePara)}`);
    console.log(`  coluna evidencia               ${tem.evidencia}  ${pct(tem.evidencia)}`);
    console.log(`  NENHUMA                        ${tem.nenhuma}  ${pct(tem.nenhuma)}`);
    console.log(`\n(de-para construído de ${nomesPorCnpj.size} CNPJs com emitente sadio)`);

    if (soRazao.length) { console.log(`\nexemplos via Razão social (nota):`); for (const e of soRazao) console.log(`   · ${e}`); }
    if (soDePara.length) { console.log(`\nexemplos via de-para por CNPJ:`); for (const e of soDePara) console.log(`   · ${e}`); }
})().catch(e => { console.error(e); process.exit(1); });
