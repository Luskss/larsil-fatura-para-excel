/**
 * _medir/_macponta-1-3-milhao.js — o item de R$ 1,32 MILHÃO da fila.
 *
 * ACHADO (21/09/2026): dimensionando a fila que sobrou, um único item responde por
 * **90% do valor total** (R$ 1.320.000 de R$ 1.469.351):
 *
 *     031.DOC- 1320000,00-2026.01-19- MACPONTA PEDIDO 11352045- PROPOSTA...
 *     planilha "NOTA FISCAL RFB" (NF)  ×  banco RECIBO   [indecidível]
 *
 * O nome do arquivo diz **PEDIDO** e **PROPOSTA** — nenhum dos dois é documento
 * fiscal. Se for mesmo uma proposta comercial, o lançamento de R$ 1,32 milhão na
 * planilha está pareado com um papel que NÃO é a nota, e isso é muito mais grave
 * que um rótulo errado: é um lançamento milionário sem comprovante fiscal.
 *
 * Memória [[caca-macponta]] sugere que este fornecedor já foi investigado antes.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. o que o banco sabe desse documento (tipo, evidência, campos extraídos)
 *   2. todos os documentos MACPONTA do acervo — existe a nota de verdade?
 *   3. o lançamento da planilha: valor, data, entidade
 *   4. há outro documento no acervo com esse valor?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    const c = h.carregar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    // ── 1) todos os arquivos MACPONTA do acervo ────────────────────────────
    console.log('── documentos MACPONTA no acervo (varredura da pasta) ───────');
    const achados = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {})) {
        for (const a of arqs) {
            if (!/MACPONTA|MAC PONTA/i.test(norm(a.nome))) continue;
            achados.push({ mes, nome: a.nome, rel: a.rel });
        }
    }
    if (!achados.length) console.log('  (nenhum)');
    for (const a of achados) {
        const info = idx[a.nome] || {};
        console.log(`\n  [${a.mes}] ${a.nome}`);
        console.log(`     pasta: ${a.rel}`);
        console.log(`     banco: tipo=${info.tipo || '(não processado)'}  evid="${String(info.evidencia || '—').slice(0, 44)}"  via=${info.origem || '—'}`);
    }

    // ── 2) o dados_parser completo do documento de R$ 1,32 mi ──────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log('O QUE O BANCO EXTRAIU do documento de R$ 1,32 milhão');
    console.log('═'.repeat(70));

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
            if (!/MACPONTA|MAC PONTA/i.test(norm(arq))) continue;
            console.log(`\n  ${arq}`);
            for (let k = 0; k < cols.length; k++) {
                const v = String(f[k] || '').trim();
                if (!v) continue;
                if (cols[k] === 'dados_parser') {
                    try {
                        const d = JSON.parse(v);
                        console.log('    dados_parser:');
                        for (const [kk, vv] of Object.entries(d))
                            if (vv && vv !== '—') console.log(`       ${kk}: ${vv}`);
                    } catch (e) { console.log(`    dados_parser: ${v.slice(0, 90)}`); }
                } else {
                    console.log(`    ${cols[k]}: ${v.slice(0, 80)}`);
                }
            }
        }
    }

    // ── 3) o lançamento na planilha ────────────────────────────────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log('O LANÇAMENTO na planilha Delsoft');
    console.log('═'.repeat(70));
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const linhaTxt = norm(r.join(' '));
            if (!/MACPONTA|MAC PONTA/.test(linhaTxt)) continue;
            console.log('');
            for (let k = 0; k < header.length; k++) {
                const v = r[k];
                if (v === undefined || v === null || v === '') continue;
                console.log(`    ${header[k]}: ${v}`);
            }
        }
        break;
    }

    // ── 4) outro documento no acervo com esse valor? ───────────────────────
    console.log(`\n${'═'.repeat(70)}`);
    console.log('EXISTE outro documento de R$ 1.320.000 no acervo?');
    console.log('═'.repeat(70));
    let achou = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {})) {
        for (const a of arqs) {
            if (/1320000|1\.320\.000|1320\.000/.test(a.nome.replace(/\s/g, ''))) {
                achou++;
                console.log(`  [${mes}] ${a.nome}`);
            }
        }
    }
    if (!achou) console.log('  nenhum outro arquivo com esse valor no nome.');

    console.log('\nLEITURA: se o único papel for PEDIDO/PROPOSTA, o lançamento de R$ 1,32');
    console.log('milhão está sem nota fiscal no acervo — achado de CONFERÊNCIA, não de');
    console.log('motor, e de longe o item mais valioso da fila.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
