/**
 * _medir/_macponta-os-dois-papeis.js — o lançamento de R$ 1,32 mi tem DOIS papéis.
 *
 * ACHADO (21/09/2026): o item de maior valor da fila (90% do dinheiro dela) é o
 * lançamento MACPONTA de R$ 1.320.000, **NF 2527**, e o acervo tem DOIS arquivos
 * na mesma pasta (2026.01.19) com esse valor:
 *
 *   031.DOC- 1320000,00-2026.01-19- MACPONTA PEDIDO 11352045- PROPOSTA 33636276 + PV.pdf
 *   031.DOC- 1320000,00-2026.01-19- MACPONTA.pdf
 *
 * Ambos classificados RECIBO pela IA. O pareamento escolheu o primeiro (o do nome
 * "PEDIDO/PROPOSTA"), e é ele que aparece na fila como divergência de tipo.
 *
 * ── A pergunta ──────────────────────────────────────────────────────────────
 * O segundo arquivo (nome limpo, "MACPONTA.pdf") é a NOTA FISCAL 2527 que falta?
 * Se for, o lançamento TEM documento fiscal no acervo e o painel está mostrando o
 * papel errado dos dois — um problema de ESCOLHA, não de ausência.
 *
 * O `CD_DESPESA: 9900` do lançamento também chama atenção: todos os outros
 * MACPONTA usam 419 ou 421. 9900 costuma ser conta de imobilizado/investimento —
 * compatível com a compra de uma máquina de R$ 1,3 milhão, não com despesa
 * corrente.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const separar = (linha) => {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (aspas) {
                if (ch === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
                else atual += ch;
            } else if (ch === '"') aspas = true;
            else if (ch === ';') { out.push(atual); atual = ''; }
            else atual += ch;
        }
        out.push(atual); return out;
    };

    console.log('═'.repeat(72));
    console.log('OS DOIS PAPÉIS DE R$ 1.320.000 — o que o banco extraiu de cada um');
    console.log('═'.repeat(72));

    let achou = 0;
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo');
        if (iA < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = separar(ls[i]);
            const arq = String(f[iA] || '').trim();
            if (!/1320000/.test(arq.replace(/[\s.]/g, ''))) continue;
            achou++;
            console.log(`\n${'─'.repeat(72)}`);
            console.log(arq);
            console.log('─'.repeat(72));
            for (let k = 0; k < cols.length; k++) {
                const v = String(f[k] || '').trim();
                if (!v || cols[k] === 'arquivo') continue;
                if (cols[k] === 'dados_parser') {
                    try {
                        const d = JSON.parse(v);
                        const campos = Object.entries(d).filter(([, vv]) => vv && vv !== '—');
                        console.log(`  dados_parser (${campos.length} campos preenchidos):`);
                        for (const [kk, vv] of campos) console.log(`     ${kk}: ${vv}`);
                    } catch (e) { console.log(`  dados_parser: ${v.slice(0, 100)}`); }
                } else {
                    console.log(`  ${cols[k]}: ${v.slice(0, 84)}`);
                }
            }
        }
    }
    if (!achou) console.log('\n  (nenhum dos dois está no banco)');

    console.log(`\n${'═'.repeat(72)}`);
    console.log('LEITURA');
    console.log('═'.repeat(72));
    console.log('\n  O lançamento é NF 2527, R$ 1.320.000, CD_DESPESA 9900 (os demais');
    console.log('  MACPONTA usam 419/421 — 9900 sugere imobilizado, coerente com compra');
    console.log('  de máquina, não despesa corrente).');
    console.log('\n  Se algum dos dois papéis trouxer "2527" ou uma chave de acesso, a nota');
    console.log('  EXISTE no acervo e o painel só escolheu o arquivo errado dos dois.');
    console.log('  Se nenhum trouxer, o lançamento está mesmo sem nota fiscal arquivada —');
    console.log('  e aí é achado de CONFERÊNCIA para levar à contabilidade.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
