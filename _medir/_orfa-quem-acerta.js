/**
 * _medir/_orfa-quem-acerta.js — nas 1.606 duplicatas por pasta renomeada, QUAL das
 * duas linhas está certa? Os primeiros exemplos de `_medir/_orfas.js` mostraram a
 * linha VELHA acertando e a NOVA trazendo o CNPJ da própria LARSIL — o oposto do
 * que "a mais recente vence" pressupõe. Se isso se confirmar no volume, apagar as
 * velhas destrói o dado bom.
 *
 * Árbitro independente das duas leituras: o VALOR no nome do arquivo
 * ("002.DOC- 52610,67-2026.03.04...") e o CNPJ da LARSIL (que nunca é o emitente,
 * ver memória [[cnpj-do-emitente-pega-o-pagador]]).
 *
 * Uso: node _medir/_orfa-quem-acerta.js [periodo]
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
const CNPJ_LARSIL = '8420245000180';   // sem zeros à esquerda, como digitos() devolve
const CHAVES_VALOR = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
const primeiro = (d, ks) => { for (const k of ks) if (d && d[k] && String(d[k]).trim() !== '—') return String(d[k]).trim(); return ''; };

// valor em centavos, a partir de "1.588,03" ou "1588,03" ou "1588.03"
function centavos(s) {
    if (!s) return null;
    let t = String(s).trim().replace(/[R$\s]/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// O valor que o arquivista escreveu no nome: "002.DOC- 1588,03 - 2026.03.20. ..."
// É evidência independente das duas leituras — foi digitado por pessoa, olhando o papel.
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

    // arbitragem por VALOR do nome do arquivo
    let comArbitro = 0, soVelhaBate = 0, soNovaBate = 0, ambasBatem = 0, nenhumaBate = 0;
    // arbitragem por CNPJ da LARSIL (o pagador nunca é o emitente)
    let velhaLarsil = 0, novaLarsil = 0, ambasLarsil = 0, nenhumaLarsil = 0, comCnpjNasDuas = 0;
    const exemplos = { velha: [], nova: [] };

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

            // ── árbitro 1: valor do nome do arquivo ──
            const alvo = valorDoNome(arq);
            if (alvo != null) {
                const vN = centavos(primeiro(dN, CHAVES_VALOR));
                const vV = centavos(primeiro(dV, CHAVES_VALOR));
                if (vN != null || vV != null) {
                    comArbitro++;
                    const okN = vN != null && vN === alvo;
                    const okV = vV != null && vV === alvo;
                    if (okN && okV) ambasBatem++;
                    else if (okV) {
                        soVelhaBate++;
                        if (exemplos.velha.length < 4) exemplos.velha.push(`${rec.PERIODO} · ${arq}\n        nome diz ${(alvo/100).toFixed(2)} · velha ${vV!=null?(vV/100).toFixed(2):'—'} ✓ · nova ${vN!=null?(vN/100).toFixed(2):'—'} ✗`);
                    }
                    else if (okN) {
                        soNovaBate++;
                        if (exemplos.nova.length < 4) exemplos.nova.push(`${rec.PERIODO} · ${arq}\n        nome diz ${(alvo/100).toFixed(2)} · velha ${vV!=null?(vV/100).toFixed(2):'—'} ✗ · nova ${vN!=null?(vN/100).toFixed(2):'—'} ✓`);
                    }
                    else nenhumaBate++;
                }
            }

            // ── árbitro 2: CNPJ da LARSIL como "emitente" é sempre erro ──
            const cN = digitos(novas[0][i('cnpj')] || dN['CNPJ emitente']);
            const cV = digitos(velhas[0][i('cnpj')] || dV['CNPJ emitente']);
            if (cN && cV) {
                comCnpjNasDuas++;
                const lN = cN === CNPJ_LARSIL, lV = cV === CNPJ_LARSIL;
                if (lN && lV) ambasLarsil++;
                else if (lN) novaLarsil++;
                else if (lV) velhaLarsil++;
                else nenhumaLarsil++;
            }
        }
    }

    console.log(`escopo: ${periodoArg || 'todos os meses'}\n`);
    console.log(`── árbitro 1: o valor escrito no nome do arquivo ──`);
    console.log(`duplicatas com valor no nome e ao menos uma leitura  ${comArbitro}`);
    console.log(`  as duas batem                                     ${ambasBatem}`);
    console.log(`  só a VELHA bate  (apagá-la perde o dado bom)       ${soVelhaBate}`);
    console.log(`  só a NOVA bate   (a velha é que está errada)       ${soNovaBate}`);
    console.log(`  nenhuma bate                                      ${nenhumaBate}`);

    console.log(`\n── árbitro 2: CNPJ da LARSIL lido como emitente (sempre erro) ──`);
    console.log(`duplicatas com CNPJ nas duas linhas                  ${comCnpjNasDuas}`);
    console.log(`  só a NOVA tem o CNPJ da LARSIL  (nova pior)        ${novaLarsil}`);
    console.log(`  só a VELHA tem o CNPJ da LARSIL (velha pior)       ${velhaLarsil}`);
    console.log(`  as duas têm                                       ${ambasLarsil}`);
    console.log(`  nenhuma tem                                       ${nenhumaLarsil}`);

    for (const [qual, lista] of [['VELHA', exemplos.velha], ['NOVA', exemplos.nova]]) {
        if (!lista.length) continue;
        console.log(`\nexemplos em que só a ${qual} bate com o nome:`);
        for (const e of lista) console.log(`   · ${e}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
