/**
 * _medir/_numero-pedido-no-campo-nf.js — quantos "Nº da NF-e" são PEDIDO/PROPOSTA?
 *
 * DEFEITO (21/09/2026), achado no caso MACPONTA: o documento
 * `...MACPONTA PEDIDO 11352045- PROPOSTA 33636276 + PV.pdf` gravou
 * `Nº da NF-e: 11352045` — que é o número do **PEDIDO**, não de nota fiscal.
 *
 * A causa provável está no FULL_PROMPT (_nf-ai-full.js:73-75):
 *
 *     "Quando o PDF agrupa fatura + anexos e o NOME DO ARQUIVO traz o número da
 *      fatura (ex.: "FT11610", "FAT 11610"), use ESSE número em numeroDocumento"
 *
 * A regra cita FT/FAT como exemplo, mas não RESTRINGE a eles. Num nome com
 * "PEDIDO 11352045" a IA encontra um número e obedece.
 *
 * ── O que se mede, ANTES de tocar no prompt ─────────────────────────────────
 * [[remendo-de-prompt-quebra-o-que-funciona]]: mexer no prompt é caro (exige
 * releitura) e já reprovou antes. Então primeiro: QUANTOS documentos têm no campo
 * do número um valor que vem de rótulo NÃO-FISCAL do nome (PEDIDO, PROPOSTA,
 * ORÇAMENTO, CONTRATO)?
 *
 *   pool grande → vale pensar em conserto
 *   pool ~1     → é o caso MACPONTA e mais nada; anotar e seguir
 *
 * Mede também o contrapeso: o número gravado BATE com algum número do nome? Se o
 * único número do nome é o do pedido, a IA não tinha alternativa — e o conserto
 * teria de ser "deixar vazio", não "achar outro".
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// rótulos NÃO-FISCAIS que carregam número no nome do arquivo
const ROTULO_NAO_FISCAL = /\b(PEDIDO|PROPOSTA|ORCAMENTO|CONTRATO|COTACAO|SIMULACAO)\b/;

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

    let linhas = 0, comRotulo = 0, numeroDoRotulo = 0, comNumero = 0;
    const casos = [], rotuloSemProblema = [];

    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser'),
              iT = cols.indexOf('tipo'), iO = cols.indexOf('origem');
        if (iA < 0 || iD < 0) continue;

        for (let i = 1; i < ls.length; i++) {
            const f = separar(ls[i]);
            const arq = String(f[iA] || '').trim();
            if (!arq) continue;
            linhas++;
            const nomeN = norm(arq);
            const temRotulo = ROTULO_NAO_FISCAL.test(nomeN);
            if (!temRotulo) continue;
            comRotulo++;

            let num = '';
            const bruto = (f[iD] || '').trim();
            if (bruto.startsWith('{')) {
                try {
                    const d = JSON.parse(bruto);
                    for (const k of ['Nº da NF-e', 'Nº do CT-e', 'Nº da NFS-e', 'Número do documento', 'Numero da NF'])
                        if (d[k] && d[k] !== '—') { num = String(d[k]).replace(/\D/g, ''); break; }
                } catch (e) {}
            }
            if (!num) continue;
            comNumero++;

            // o número gravado aparece logo depois de um rótulo não-fiscal no nome?
            const m = nomeN.match(new RegExp(`\\b(PEDIDO|PROPOSTA|ORCAMENTO|CONTRATO|COTACAO|SIMULACAO)\\b[^0-9]{0,4}(\\d{3,})`));
            const veioDoRotulo = m && m[2] === num;
            if (veioDoRotulo) {
                numeroDoRotulo++;
                casos.push({ arq, num, rotulo: m[1], tipo: String(f[iT] || ''), org: String(f[iO] || '') });
            } else if (rotuloSemProblema.length < 8) {
                rotuloSemProblema.push({ arq, num });
            }
        }
    }

    // Dedupe pelo PDF de origem: um carnê vira uma linha por PARCELA (`#p1`…`#p42`),
    // e contá-las infla o defeito de 3 documentos para 44. O sufixo `#pN` precisa
    // sair antes de contar — cf. [[parcelas-pn-sobram-no-upsert]].
    const base = s => String(s || '').replace(/#p\d+$/i, '');
    const unicos = new Map();
    for (const c of casos) if (!unicos.has(base(c.arq))) unicos.set(base(c.arq), c);
    const casosUnicos = [...unicos.values()];

    console.log(`linhas no banco: ${linhas}`);
    console.log(`  com rótulo não-fiscal no nome (PEDIDO/PROPOSTA/...): ${comRotulo}  ${pct(comRotulo, linhas)}`);
    console.log(`  dessas, com número gravado:                          ${comNumero}`);
    console.log(`  linhas cujo número É o do rótulo não-fiscal:         ${numeroDoRotulo}`);
    console.log(`  DOCUMENTOS ÚNICOS afetados:                          ${casosUnicos.length}  ← o defeito real\n`);

    console.log('── os casos (documentos únicos) ────────────────────────────');
    if (!casosUnicos.length) console.log('  (nenhum)');
    for (const c of casosUnicos) {
        console.log(`\n  nº gravado ${c.num}  (rótulo: ${c.rotulo})   tipo=${c.tipo}  via=${c.org}`);
        console.log(`     ${c.arq.slice(0, 68)}`);
    }

    console.log('\n── com rótulo, mas número de OUTRA origem (ok) ─────────────');
    for (const c of rotuloSemProblema)
        console.log(`  nº ${String(c.num).padEnd(10)} ${c.arq.slice(0, 56)}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('LEITURA');
    console.log('═'.repeat(68));
    console.log(`\n  O pool do defeito é ${casosUnicos.length} documento(s) únicos.`);
    if (casosUnicos.length <= 4) {
        console.log('\n  É pequeno demais para justificar mexer no FULL_PROMPT, que exigiria');
        console.log('  releitura com API e já reprovou antes ([[remendo-de-prompt-quebra-o-que-');
        console.log('  funciona]]). O caso MACPONTA é real, mas é UM — e o pareamento dele');
        console.log('  não depende desse campo (casou por VALOR).');
        console.log('\n  Recomendação: anotar, não consertar. Reavaliar se o padrão crescer.');
    } else {
        console.log('\n  Vale considerar uma regra: não aceitar número que venha logo após');
        console.log('  rótulo não-fiscal no nome. Medir o contrapeso antes.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
