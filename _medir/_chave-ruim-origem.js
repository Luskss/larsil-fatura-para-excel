/**
 * _medir/_chave-ruim-origem.js — de onde vieram as chaves inválidas que sobraram no
 * banco: 39 com 44 dígitos e DV errado, 346 sem 44 dígitos (medido por `_chave-dv.js`).
 *
 * A correção em `_nf-parsers.js` impede novas, mas não limpa as gravadas. Antes de
 * decidir se vale limpar, é preciso saber O QUE elas são. Hipóteses a separar:
 *   a) linha digitável de boleto (47 díg) lida como chave — o erro que a validação
 *      de UF/modelo já devia pegar;
 *   b) chave real com dígitos perdidos na leitura (a IA truncando);
 *   c) chave real com lixo concatenado (número da nota grudado no fim);
 *   d) sequência numérica qualquer do documento.
 *
 * Distingue (b) e (c) de (a) e (d) testando se ALGUMA janela de 44 dígitos dentro da
 * sequência é válida — se for, a chave certa está ali, só mal recortada.
 *
 * Uso: node _medir/_chave-ruim-origem.js [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');
const { chaveValida } = require('../routes/_nf-parsers');

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

// A chave certa está escondida dentro da sequência? Testa toda janela de 44 dígitos.
function janelaValida(d) {
    if (d.length < 44) return '';
    for (let i = 0; i + 44 <= d.length; i++) {
        const j = d.slice(i, i + 44);
        if (chaveValida(j)) return j;
    }
    return '';
}

// Assinatura de linha digitável de boleto: 47 dígitos, ou começa com código de banco
// conhecido seguido de moeda 9 (ex.: "23790", "00190", "34191").
const pareceBoleto = d => d.length === 47 || /^(001|033|041|104|237|341|356|389|422|748|756)9/.test(d);

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    const cls = {
        recuperavel: 0,     // a chave certa está dentro, mal recortada
        boleto: 0,          // linha digitável
        curta: 0,           // menos de 44 dígitos, nada a recuperar
        dv44: 0,            // 44 dígitos, DV errado, sem janela válida
        outro: 0,
    };
    const porTipo = new Map(), porOrigem = new Map();
    const ex = { recuperavel: [], boleto: [], curta: [], dv44: [] };
    let total = 0;

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        for (const row of rows.slice(1)) {
            if (!row[i('arquivo')]) continue;
            let dp = null;
            try { dp = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            const ch = dp && dp['Chave de acesso'];
            if (!ch || String(ch).trim() === '' || String(ch).trim() === '—') continue;
            const d = String(ch).replace(/\D/g, '');
            if (chaveValida(d)) continue;    // as boas não interessam aqui
            total++;

            const arq = String(row[i('arquivo')]).slice(0, 56);
            const rotulo = `${rec.PERIODO} · ${row[i('tipo')] || '?'} · ${arq}\n        ${d.length} díg: ${d.slice(0, 50)}${d.length > 50 ? '…' : ''}`;

            const dentro = janelaValida(d);
            if (dentro) {
                cls.recuperavel++;
                if (ex.recuperavel.length < 4) ex.recuperavel.push(`${rotulo}\n        → contém a chave válida: ${dentro}`);
            } else if (pareceBoleto(d)) {
                cls.boleto++;
                if (ex.boleto.length < 3) ex.boleto.push(rotulo);
            } else if (d.length < 44) {
                cls.curta++;
                if (ex.curta.length < 3) ex.curta.push(rotulo);
            } else if (d.length === 44) {
                cls.dv44++;
                if (ex.dv44.length < 3) ex.dv44.push(rotulo);
            } else cls.outro++;

            const t = row[i('tipo')] || '(sem tipo)';
            porTipo.set(t, (porTipo.get(t) || 0) + 1);
            const o = row[i('origem')] || '(sem origem)';
            porOrigem.set(o, (porOrigem.get(o) || 0) + 1);
        }
    }

    const pct = n => (total ? (100 * n / total).toFixed(1) + '%' : '—');
    console.log(`escopo: ${periodoArg || 'todos os meses'}`);
    console.log(`chaves INVÁLIDAS no banco: ${total}\n`);
    console.log(`o que são:`);
    console.log(`  chave certa mal recortada  ${cls.recuperavel}  ${pct(cls.recuperavel)}   ← dá para recuperar sem reler o PDF`);
    console.log(`  linha digitável de boleto  ${cls.boleto}  ${pct(cls.boleto)}   ← nunca foi chave; apagar`);
    console.log(`  curta demais (<44)         ${cls.curta}  ${pct(cls.curta)}   ← leitura truncada; apagar`);
    console.log(`  44 díg, DV errado          ${cls.dv44}  ${pct(cls.dv44)}   ← dígito trocado; apagar`);
    console.log(`  outro                      ${cls.outro}  ${pct(cls.outro)}`);

    if (porTipo.size) {
        console.log(`\npor tipo de documento:`);
        for (const [k, v] of [...porTipo].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(v).padStart(5)}  ${k}`);
    }
    if (porOrigem.size) {
        console.log(`\npor origem da leitura:`);
        for (const [k, v] of [...porOrigem].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
    }
    for (const [nome, lista] of [['RECUPERÁVEIS', ex.recuperavel], ['BOLETO', ex.boleto], ['CURTAS', ex.curta], ['DV ERRADO', ex.dv44]]) {
        if (!lista.length) continue;
        console.log(`\nexemplos — ${nome}:`);
        for (const e of lista) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
