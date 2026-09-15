/**
 * _medir/_orfa-regra.js — qual regra de desempate usar na fusão das linhas órfãs.
 *
 * Medido antes (`_medir/_orfa-quem-acerta.js`): nenhum lado vence sempre. A linha
 * NOVA acerta o valor sozinha em 214 casos e a VELHA em 161; mas o CNPJ da própria
 * LARSIL (erro puro) aparece 111 vezes só na nova contra 11 só na velha. Logo o
 * desempate tem de ser POR CAMPO e por evidência, não por antiguidade.
 *
 * Este script testa regras candidatas contra árbitros independentes das duas leituras:
 *   · VALOR    → o valor escrito no nome do arquivo pelo arquivista;
 *   · CNPJ     → o CNPJ da LARSIL nunca é o emitente ([[cnpj-do-emitente-pega-o-pagador]]);
 *   · CHAVE    → a chave de acesso de 44 dígitos valida-se sozinha (DV mod-11) e
 *                carrega o CNPJ do emitente embutido, então não precisa de árbitro externo;
 *   · NÚMERO   → o número da NF costuma aparecer no nome do arquivo ("NF 4493").
 *
 * Não grava nada. Uso: node _medir/_orfa-regra.js [periodo]
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
const CHAVES_VALOR  = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
const CHAVES_NUMERO = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF', 'Nº do CT-e'];
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
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
// "… NF 4493 + BOL.pdf", "NFS 886", "NF-e 14129"
function numeroDoNome(nome) {
    const m = String(nome).match(/\bNFS?E?[-\s.]*(\d{2,9})\b/i);
    return m ? digitos(m[1]) : '';
}

// Chave de acesso da NF-e: 44 dígitos com DV mod-11. Valida-se sozinha — é a única
// evidência do conjunto que não depende de nenhum árbitro externo.
function chaveValida(ch) {
    const s = String(ch ?? '').replace(/\D/g, '');
    if (s.length !== 44) return false;
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(s[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return dv === Number(s[43]);
}
// O CNPJ do emitente está embutido nas posições 6..19 da chave.
const cnpjDaChave = ch => {
    const s = String(ch ?? '').replace(/\D/g, '');
    return s.length === 44 ? digitos(s.slice(6, 20)) : '';
};

(async () => {
    const periodoArg = process.argv[2] || null;
    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    // Para cada campo em conflito, contamos qual lado o árbitro dá como certo.
    const placar = {
        valor:  { nova: 0, velha: 0, ambas: 0, nenhuma: 0 },
        cnpj:   { nova: 0, velha: 0, ambas: 0, nenhuma: 0 },
        numero: { nova: 0, velha: 0, ambas: 0, nenhuma: 0 },
        chave:  { nova: 0, velha: 0, ambas: 0, nenhuma: 0 },
    };
    // regra "CNPJ: quem NÃO é LARSIL vence" — quantas vezes ela decide e acerta,
    // julgada pelo CNPJ embutido na chave de acesso válida (independente).
    let cnpjRegraDecide = 0, cnpjRegraAcerta = 0, cnpjRegraErra = 0;

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

            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const dN = pj(novas[0]), dV = pj(velhas[0]);

            // ── VALOR, arbitrado pelo nome do arquivo ──
            const alvoV = valorDoNome(arq);
            if (alvoV != null) {
                const a = centavos(primeiro(dN, CHAVES_VALOR)), b = centavos(primeiro(dV, CHAVES_VALOR));
                if (a != null && b != null && a !== b) {
                    const okA = a === alvoV, okB = b === alvoV;
                    if (okA && okB) placar.valor.ambas++;
                    else if (okA) placar.valor.nova++;
                    else if (okB) placar.valor.velha++;
                    else placar.valor.nenhuma++;
                }
            }

            // ── NÚMERO, arbitrado pelo nome do arquivo ──
            const alvoN = numeroDoNome(arq);
            if (alvoN) {
                const a = digitos(primeiro(dN, CHAVES_NUMERO)), b = digitos(primeiro(dV, CHAVES_NUMERO));
                if (a && b && a !== b) {
                    const okA = a === alvoN, okB = b === alvoN;
                    if (okA && okB) placar.numero.ambas++;
                    else if (okA) placar.numero.nova++;
                    else if (okB) placar.numero.velha++;
                    else placar.numero.nenhuma++;
                }
            }

            // ── CHAVE, autovalidável pelo DV ──
            const chA = dN['Chave de acesso'], chB = dV['Chave de acesso'];
            if (chA && chB && digitos(chA) !== digitos(chB)) {
                const okA = chaveValida(chA), okB = chaveValida(chB);
                if (okA && okB) placar.chave.ambas++;
                else if (okA) placar.chave.nova++;
                else if (okB) placar.chave.velha++;
                else placar.chave.nenhuma++;
            }

            // ── CNPJ, arbitrado pelo CNPJ embutido numa chave de acesso VÁLIDA ──
            const cA = digitos(novas[0][i('cnpj')] || dN['CNPJ emitente']);
            const cB = digitos(velhas[0][i('cnpj')] || dV['CNPJ emitente']);
            if (cA && cB && cA !== cB) {
                const chBoa = [chA, chB].find(c => chaveValida(c));
                const alvoC = chBoa ? cnpjDaChave(chBoa) : '';
                if (alvoC) {
                    const okA = cA === alvoC, okB = cB === alvoC;
                    if (okA && okB) placar.cnpj.ambas++;
                    else if (okA) placar.cnpj.nova++;
                    else if (okB) placar.cnpj.velha++;
                    else placar.cnpj.nenhuma++;

                    // a regra "quem não é LARSIL vence" decide aqui?
                    const lA = cA === CNPJ_LARSIL, lB = cB === CNPJ_LARSIL;
                    if (lA !== lB) {
                        cnpjRegraDecide++;
                        const escolhido = lA ? cB : cA;
                        if (escolhido === alvoC) cnpjRegraAcerta++; else cnpjRegraErra++;
                    }
                }
            }
        }
    }

    console.log(`escopo: ${periodoArg || 'todos os meses'}`);
    console.log(`\nEm cada campo em CONFLITO, qual lado o árbitro independente dá como certo:\n`);
    const linha = (nome, p, arb) => {
        const tot = p.nova + p.velha + p.ambas + p.nenhuma;
        console.log(`${nome.padEnd(8)} (árbitro: ${arb})`);
        console.log(`   conflitos julgados ${tot}`);
        console.log(`   só a NOVA certa    ${p.nova}`);
        console.log(`   só a VELHA certa   ${p.velha}`);
        console.log(`   as duas certas     ${p.ambas}`);
        console.log(`   nenhuma certa      ${p.nenhuma}`);
        if (p.nova + p.velha > 0) {
            const vencedor = p.nova >= p.velha ? 'NOVA' : 'VELHA';
            const acerto = Math.max(p.nova, p.velha) / (p.nova + p.velha) * 100;
            console.log(`   → preferir ${vencedor} acerta ${acerto.toFixed(0)}% dos decididos`);
        }
        console.log('');
    };
    linha('VALOR',  placar.valor,  'valor no nome do arquivo');
    linha('NÚMERO', placar.numero, 'número no nome do arquivo');
    linha('CHAVE',  placar.chave,  'dígito verificador mod-11');
    linha('CNPJ',   placar.cnpj,   'CNPJ embutido na chave válida');

    console.log(`regra "no CNPJ, quem NÃO é LARSIL vence":`);
    console.log(`   decide em          ${cnpjRegraDecide} conflitos`);
    console.log(`   acerta             ${cnpjRegraAcerta}`);
    console.log(`   erra               ${cnpjRegraErra}`);
})().catch(e => { console.error(e); process.exit(1); });
