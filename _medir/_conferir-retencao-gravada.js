/**
 * _medir/_conferir-retencao-gravada.js — a releitura gravou mesmo os campos?
 *
 * Roda DEPOIS de `reprocessar-fiscal.js --gravar`. Vai ao banco e procura, no
 * `dados_parser` das linhas de 03.2026, os campos que `parseNfse` passou a extrair.
 *
 * Confere CONTEÚDO, não contagem: a memória do projeto
 * (`cache-esconde-mudanca-de-extracao.md`) registra que o número de linhas não muda
 * quando a extração muda — só o conteúdo muda. Contar linhas daria "tudo certo"
 * mesmo que nada tivesse sido regravado.
 *
 * Compara com a prévia (`_previa-releitura-03.js`), que disse quais arquivos
 * deveriam ganhar retenção. O que a prévia previu e o banco não tem é falha real.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const PERIODO_ALVO = '03.2026';

function internasRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname',
        `${src.slice(0, corte)} return { retencaoDoParser };`);
    return f(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

function separarCsv(linha) {
    const out = []; let atual = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (aspas) { if (c === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; } else atual += c; }
        else if (c === '"') aspas = true;
        else if (c === ';') { out.push(atual); atual = ''; }
        else atual += c;
    }
    out.push(atual); return out;
}

const CAMPOS_NFSE = ['Valor do serviço', 'Valor líquido', 'ISS retido',
                     'IRRF retido', 'INSS retido', 'CSLL retido', 'COFINS retido', 'PIS retido'];

(async () => {
    const { retencaoDoParser } = internasRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    let linhas = 0, comCampoNfse = 0, comRetencaoValida = 0;
    const achados = [];
    let periodosVistos = new Set();

    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo');
        const iPasta = cols.indexOf('pasta');
        const iParser = cols.indexOf('dados_parser');
        if (iArq < 0 || iParser < 0) continue;

        for (let i = 1; i < ls.length; i++) {
            const campos = separarCsv(ls[i]);
            const pastaRel = iPasta >= 0 ? (campos[iPasta] || '') : '';
            // Só as linhas da pasta de março — é essa que foi relida.
            if (!/2026\.03/.test(pastaRel) && !/2026\.03/.test(campos[iArq] || '')) continue;
            periodosVistos.add(row.PERIODO);
            linhas++;

            const bruto = (campos[iParser] || '').trim();
            if (!bruto.startsWith('{')) continue;
            let d; try { d = JSON.parse(bruto); } catch (e) { continue; }

            const temAlgum = CAMPOS_NFSE.some(k => d[k] != null && String(d[k]).trim() !== '' && String(d[k]).trim() !== '—');
            if (!temAlgum) continue;
            comCampoNfse++;

            const r = retencaoDoParser(d);
            if (r) {
                comRetencaoValida++;
                achados.push({ arq: campos[iArq], ...r });
            }
        }
    }

    console.log(`períodos tocados: ${[...periodosVistos].join(', ')}`);
    console.log(`linhas de 2026.03 no banco: ${linhas}\n`);
    console.log(`com ALGUM campo de NFS-e gravado:        ${comCampoNfse}`);
    console.log(`com RETENÇÃO válida (conta fecha):       ${comRetencaoValida}`);
    console.log(`  → a prévia previu 10. ${comRetencaoValida >= 10 ? 'OK' : '*** ABAIXO DO PREVISTO'}\n`);

    if (achados.length) {
        console.log('RETENÇÕES GRAVADAS:');
        for (const a of achados.sort((x, y) => y.retido - x.retido))
            console.log(`  bruto ${a.bruto.toFixed(2).padStart(10)}  retido ${a.retido.toFixed(2).padStart(9)}  ` +
                `líquido ${a.liquido.toFixed(2).padStart(10)}   ${String(a.arq).slice(0, 60)}`);
    } else {
        console.log('*** NENHUMA retenção gravada. A releitura não escreveu os campos novos —');
        console.log('    confira se rodou com --gravar e na pasta certa.');
    }
    process.exit(0);
})();
