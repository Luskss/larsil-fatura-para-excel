/**
 * _medir/_orfas.js — o upsert casa por `arquivo|pasta`, então renomear a pasta-raiz
 * gravou a linha nova AO LADO da antiga em vez de substituí-la (ver memória
 * [[pasta-renomeada-duplica-linha]]). Este medidor responde, antes de decidir se vale
 * limpar:
 *
 *   1. quantos PDFs têm mais de uma linha para o MESMO nome de arquivo, em pastas
 *      diferentes, dentro do mesmo relatório mensal;
 *   2. quais dessas pastas são o prefixo novo ("AAAA.MM.EXTRATOS CONTABILIDADE/…")
 *      e quais são o caminho antigo — isto é, se dá para decidir qual sobra pelo
 *      formato do caminho, sem ir ao disco;
 *   3. se as duas linhas DIVERGEM em campos que o pareamento usa (CNPJ, emitente,
 *      número, valor) — porque é a divergência, não a duplicata em si, que joga o
 *      casamento no acaso;
 *   4. se a linha antiga tem algum campo que a nova NÃO tem (o que a limpeza perderia).
 *
 * Uso: node _medir/_orfas.js [periodo]     (sem período = todos os meses)
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

// O prefixo novo que a renomeação introduziu: "2026.03.EXTRATOS CONTABILIDADE/…".
const RE_PASTA_NOVA = /^\d{4}\.\d{2}\.[^/]*EXTRATOS/i;

const CHAVES_NUMERO = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF', 'Nº do CT-e'];
const CHAVES_VALOR  = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
const norm = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const primeiro = (d, ks) => { for (const k of ks) if (d && d[k] && String(d[k]).trim() !== '—') return String(d[k]).trim(); return ''; };
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    let totalLinhas = 0;
    let gruposDup = 0, linhasEmDup = 0, orfasRemoviveis = 0;
    let semParNovo = 0;           // duplicata onde NENHUMA das pastas é a nova → não dá para decidir pelo caminho
    let maisDeDuas = 0;
    const diverge = { cnpj: 0, emitente: 0, numero: 0, valor: 0 };
    const soNaVelha = new Map();  // campo → quantas vezes só a linha velha o tem
    const exemplosDiv = [];
    const porPeriodo = new Map();

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);

        // agrupa por nome de arquivo dentro do mesmo relatório
        const porArquivo = new Map();
        for (const row of rows.slice(1)) {
            const arq = row[i('arquivo')];
            if (!arq) continue;
            totalLinhas++;
            if (!porArquivo.has(arq)) porArquivo.set(arq, []);
            porArquivo.get(arq).push(row);
        }

        for (const [arq, grupo] of porArquivo) {
            if (grupo.length < 2) continue;
            // só conta como órfã de renomeação se as PASTAS diferem
            const pastas = new Set(grupo.map(g => g[i('pasta')]));
            if (pastas.size < 2) continue;

            gruposDup++;
            linhasEmDup += grupo.length;
            if (grupo.length > 2) maisDeDuas++;
            porPeriodo.set(rec.PERIODO, (porPeriodo.get(rec.PERIODO) || 0) + 1);

            const novas  = grupo.filter(g => RE_PASTA_NOVA.test(g[i('pasta')]));
            const velhas = grupo.filter(g => !RE_PASTA_NOVA.test(g[i('pasta')]));
            if (!novas.length) { semParNovo++; continue; }
            orfasRemoviveis += velhas.length;
            if (!velhas.length) continue;

            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const dN = pj(novas[0]), dV = pj(velhas[0]);

            const cN = digitos(novas[0][i('cnpj')] || dN['CNPJ emitente']);
            const cV = digitos(velhas[0][i('cnpj')] || dV['CNPJ emitente']);
            const eN = norm(dN['Emitente']), eV = norm(dV['Emitente']);
            const nN = digitos(primeiro(dN, CHAVES_NUMERO)), nV = digitos(primeiro(dV, CHAVES_NUMERO));
            const vN = norm(primeiro(dN, CHAVES_VALOR)), vV = norm(primeiro(dV, CHAVES_VALOR));

            const difs = [];
            if (cN && cV && cN !== cV) { diverge.cnpj++; difs.push(`cnpj ${cV} → ${cN}`); }
            if (eN && eV && eN !== eV) { diverge.emitente++; difs.push(`emitente "${eV}" → "${eN}"`); }
            if (nN && nV && nN !== nV) { diverge.numero++; difs.push(`numero ${nV} → ${nN}`); }
            if (vN && vV && vN !== vV) { diverge.valor++; difs.push(`valor ${vV} → ${vN}`); }
            if (difs.length && exemplosDiv.length < 6)
                exemplosDiv.push(`${rec.PERIODO} · ${arq}\n        velha: ${velhas[0][i('pasta')]}\n        nova : ${novas[0][i('pasta')]}\n        ${difs.join('\n        ')}`);

            // o que a limpeza perderia: campo presente só na velha
            for (const k of Object.keys(dV)) {
                const temV = dV[k] != null && String(dV[k]).trim() !== '' && String(dV[k]).trim() !== '—';
                const temN = dN[k] != null && String(dN[k]).trim() !== '' && String(dN[k]).trim() !== '—';
                if (temV && !temN) soNaVelha.set(k, (soNaVelha.get(k) || 0) + 1);
            }
        }
    }

    console.log(`escopo: ${periodoArg || 'todos os meses'}   (${totalLinhas} linhas)\n`);
    console.log(`PDFs com linha duplicada em pastas diferentes  ${gruposDup}`);
    console.log(`  linhas envolvidas                            ${linhasEmDup}`);
    console.log(`  grupos com mais de 2 linhas                  ${maisDeDuas}`);
    console.log(`  órfãs removíveis (pasta antiga, há par novo) ${orfasRemoviveis}`);
    console.log(`  sem par na pasta nova (não dá p/ decidir)    ${semParNovo}`);

    console.log(`\ndivergência entre a linha velha e a nova (só onde as duas têm o campo):`);
    console.log(`  CNPJ      ${diverge.cnpj}`);
    console.log(`  emitente  ${diverge.emitente}`);
    console.log(`  número    ${diverge.numero}`);
    console.log(`  valor     ${diverge.valor}`);

    if (soNaVelha.size) {
        console.log(`\ncampos presentes SÓ na linha velha (o que a limpeza perderia):`);
        for (const [k, n] of [...soNaVelha].sort((a, b) => b[1] - a[1]).slice(0, 12))
            console.log(`   ${String(n).padStart(5)}  ${k}`);
    } else {
        console.log(`\nnenhum campo existe só na linha velha — a nova cobre tudo.`);
    }

    if (porPeriodo.size) {
        console.log(`\npor período:`);
        for (const [p, n] of [...porPeriodo].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${p}`);
    }

    if (exemplosDiv.length) {
        console.log(`\nexemplos de divergência (confira antes de decidir):`);
        for (const e of exemplosDiv) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
