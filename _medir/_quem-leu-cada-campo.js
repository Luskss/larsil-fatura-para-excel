/**
 * _medir/_quem-leu-cada-campo.js — no processo atual, quem lê: IA ou parser local?
 *
 * PERGUNTA do usuário (21/09/2026), vendo os logs "[process-folder] IA: carnê em…":
 * esses documentos estão sendo lidos por IA ou por parser local?
 *
 * ── A resposta do CÓDIGO ────────────────────────────────────────────────────
 * Não é "ou" — é os DOIS, na mesma passada, com precedência definida.
 *
 * `scanAutomaticoUsaIA()` (scheduler.js:109) devolve TRUE por padrão
 * (`SCAN_AUTOMATICO_IA` != 'false'), e as rotas force-scan passam `forceAI: true`
 * fixo. Então todo scan entra no ramo `if (forceAI)` de `analyzePdf` e chama
 * `analyzeViaAI` — mas essa função NÃO é "só IA". A ordem dentro dela
 * (process-folder.js:424-520) é:
 *
 *   1. `extrairNotaAI`       ← a IA lê o texto (é o que aparece no log)
 *   2. `enriquecerComChaveAcesso` + `enriquecerComBoleto`  ← ARITMÉTICA do texto
 *   3. `extrairNotaFiscal`   ← EXTRATOR LOCAL determinístico
 *   4. `classify` + parser do tipo (parseNfse/parseDanfe/…)  ← PARSER LOCAL
 *   5. campos da VISÃO (se PDF-imagem)
 *
 * E a precedência é INVERSA à ordem de execução: 2, 3 e 4 só preenchem o que
 * está VAZIO — `Object.assign(pdComum, { ...local, ...pdComum })` mantém o que já
 * existia. Chave de acesso e linha digitável vêm do texto por construção e a IA
 * não as sobrescreve.
 *
 * O parser local SÓ vira caminho único quando a IA não devolve nada aproveitável
 * (`if (rowsIA) return rowsIA;` falha → "IA sem resultado … usando parser local").
 *
 * ── O que este script mede ──────────────────────────────────────────────────
 * Confirma no BANCO: qual a origem gravada, e quais campos vieram de cada fonte.
 * Ler o código diz a intenção; o banco diz o que aconteceu
 * ([[o-erro-mora-onde-a-funcao-nao-roda]]).
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const base = s => String(s || '').replace(/#p\d+$/i, '');

// Campos que SÓ o extrator/parser local produz — a IA não tem esses no schema.
const SO_LOCAL = ['Retenções', 'Valor do serviço', 'ISS', 'PIS', 'COFINS', 'CSLL', 'IRRF', 'INSS',
                  'Base de cálculo', 'Alíquota', 'Natureza da operação', 'Série', 'CFOP'];
// Campos que saem do texto por ARITMÉTICA (chave/linha digitável), nunca da IA.
const ARITMETICOS = ['Chave de acesso', 'Linha digitável', 'Vencimento (boleto)', 'Valor do boleto'];

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

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

    const docs = new Map();
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iO = cols.indexOf('origem'), iD = cols.indexOf('dados_parser');
        if (iA < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = base(String(f[iA] || '').trim());
            if (!arq || docs.has(arq)) continue;
            let d = {};
            const bruto = iD >= 0 ? (f[iD] || '').trim() : '';
            if (bruto.startsWith('{')) { try { d = JSON.parse(bruto); } catch (e) {} }
            docs.set(arq, { origem: String(f[iO] || '').trim(), campos: d });
        }
    }

    console.log(`documentos únicos no banco: ${docs.size}\n`);

    // ── a origem gravada ───────────────────────────────────────────────────
    const porOrigem = new Map();
    for (const [, v] of docs) porOrigem.set(v.origem || '(vazio)', (porOrigem.get(v.origem || '(vazio)') || 0) + 1);
    console.log('── coluna `origem` (quem LIDEROU a leitura) ────────────────');
    for (const [k, n] of [...porOrigem].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(k).padEnd(22)} ${String(n).padStart(5)}  ${pct(n, docs.size)}`);

    // ── mas os campos LOCAIS estão lá? ─────────────────────────────────────
    console.log('\n── nas linhas de origem IA, campos que SÓ o local produz ───');
    const iaDocs = [...docs.values()].filter(v => /IA/i.test(v.origem));
    let comSoLocal = 0, comAritmetico = 0;
    const achadosLocal = new Map(), achadosArit = new Map();
    for (const v of iaDocs) {
        let temL = false, temA = false;
        for (const k of Object.keys(v.campos)) {
            const val = v.campos[k];
            if (val == null || String(val).trim() === '' || String(val).trim() === '—') continue;
            if (SO_LOCAL.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
                temL = true; achadosLocal.set(k, (achadosLocal.get(k) || 0) + 1);
            }
            if (ARITMETICOS.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
                temA = true; achadosArit.set(k, (achadosArit.get(k) || 0) + 1);
            }
        }
        if (temL) comSoLocal++;
        if (temA) comAritmetico++;
    }
    console.log(`   documentos de origem IA: ${iaDocs.length}`);
    console.log(`     com campo que só o PARSER LOCAL produz: ${comSoLocal}  ${pct(comSoLocal, iaDocs.length)}`);
    console.log(`     com campo ARITMÉTICO (chave/linha dig.): ${comAritmetico}  ${pct(comAritmetico, iaDocs.length)}`);

    console.log('\n   campos locais mais frequentes em linha "IA":');
    for (const [k, n] of [...achadosLocal].sort((a, b) => b[1] - a[1]).slice(0, 10))
        console.log(`     ${k.padEnd(34)} ${String(n).padStart(5)}`);
    console.log('\n   campos aritméticos em linha "IA":');
    for (const [k, n] of [...achadosArit].sort((a, b) => b[1] - a[1]).slice(0, 8))
        console.log(`     ${k.padEnd(34)} ${String(n).padStart(5)}`);

    // ── os documentos dos logs do usuário ──────────────────────────────────
    console.log('\n── os documentos que apareceram no seu log ─────────────────');
    const ALVOS = ['GIRO PEAC', 'HDI SEGUROS', 'HDI Apólice', 'CIMAG', 'MAQNELSON. NF 98188',
                   'CASA RURAL. NF 435085', 'IRMAOS SILVA', 'CASA RURAL. NF 435084',
                   'TRCT', 'FN.SICREDI'];
    for (const alvo of ALVOS) {
        const achado = [...docs].find(([a]) => a.toUpperCase().includes(alvo.toUpperCase()));
        if (!achado) { console.log(`   (não achei "${alvo}" no banco — ainda não gravado?)`); continue; }
        const [arq, v] = achado;
        const nCampos = Object.values(v.campos).filter(x => x != null && String(x).trim() !== '' && String(x).trim() !== '—').length;
        const locais = Object.keys(v.campos).filter(k => SO_LOCAL.some(s => k.toLowerCase().includes(s.toLowerCase())));
        const arits = Object.keys(v.campos).filter(k => ARITMETICOS.some(s => k.toLowerCase().includes(s.toLowerCase())));
        console.log(`\n   ${arq.slice(0, 62)}`);
        console.log(`      origem=${v.origem}   ${nCampos} campos preenchidos`);
        if (locais.length) console.log(`      campos do PARSER LOCAL: ${locais.join(', ').slice(0, 60)}`);
        if (arits.length) console.log(`      campos ARITMÉTICOS: ${arits.join(', ').slice(0, 60)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
