/**
 * _medir/_mais-um-teste.js — o que o A/B de ontem NÃO cobriu
 *
 * `_conferir-o-implementado.js` confirmou 11 curados / 0 quebrados chamando
 * `valorPorPrecedencia` direto. Mas a produção não chama essa função: chama
 * `decidirValorPago`, que tem a ÂNCORA na frente e pode decidir sozinha antes de
 * a precedência ser consultada. Três buracos ficaram:
 *
 *   A. a ÂNCORA vence a exceção? Se ela já resolvia esses 11, meu ganho é menor
 *      do que anunciei — e eu estaria creditando à exceção um acerto alheio.
 *   B. o CARNÊ deleta `Linha digitável` e `Valor do boleto` (process-folder:609-613)
 *      ANTES de gerar as parcelas, mas `decidirValorPago` roda ANTES disso. A
 *      exceção pode estar injetando o total do carnê em cada parcela.
 *   C. `Valor total da nota`: a exceção devolve a LD, e o bloco de preservação
 *      (`decidirValorPago`:237) guarda o valor anterior. Ele sobrevive?
 *
 * E uma trava que vale mais que as três: a exceção só deveria agir onde a TRAVA
 * BARRA. Se ela estiver agindo onde o boleto já venceria, mudou comportamento fora
 * da zona medida — e a medição não cobriria esses casos.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const V = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function valorDoNomeArquivo(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
}

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
    // guarda TODAS as linhas (inclusive as #pN do carnê), não só a primeira
    const linhas = [];
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iD < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = String(f[iA] || '').trim();
            if (!arq) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { linhas.push({ arq, pd: JSON.parse(bruto) }); } catch (e) {}
        }
    }
    console.log(`linhas com dados_parser: ${linhas.length}\n`);

    // ── TRAVA PRINCIPAL: a exceção age FORA da zona medida? ────────────────
    console.log('═'.repeat(74));
    console.log('(0) A EXCEÇÃO AGE SÓ ONDE A TRAVA BARRA?');
    console.log('═'.repeat(74));
    let agiuNaZona = 0, agiuForaDaZona = 0;
    const forasteiros = [];
    for (const { arq, pd } of linhas) {
        const vNome = valorDoNomeArquivo(arq);
        const antes = V.valorPorPrecedencia(pd);
        const depois = V.valorPorPrecedencia(pd, vNome);
        if (antes.valor == null || depois.valor == null) continue;
        if (Math.abs(antes.valor - depois.valor) < 0.02) continue;

        const bol = V.paraNumero(pd['Valor do boleto']);
        const nota = V.paraNumero(pd['Valor total da nota']);
        const tot = V.paraNumero(pd['Valor total']);
        const baseTrava = nota != null ? nota : tot;
        const travaBarra = bol != null && baseTrava != null && !(bol < baseTrava);
        if (travaBarra) agiuNaZona++;
        else { agiuForaDaZona++; if (forasteiros.length < 6) forasteiros.push({ arq, antes, depois, bol, baseTrava }); }
    }
    console.log(`\n   agiu DENTRO da zona (trava barrando): ${agiuNaZona}`);
    console.log(`   agiu FORA da zona:                    ${agiuForaDaZona}  ${agiuForaDaZona ? '⚠ não medido' : '✓'}`);
    for (const f of forasteiros) {
        console.log(`\n   ⚠ ${f.arq.slice(0, 60)}`);
        console.log(`      boleto=${f.bol == null ? '—' : brl(f.bol)}  base=${f.baseTrava == null ? '—' : brl(f.baseTrava)}`);
        console.log(`      ${brl(f.antes.valor)} (${f.antes.origem}) → ${brl(f.depois.valor)} (${f.depois.origem})`);
    }

    // ── (A) a ÂNCORA vence a exceção? ──────────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('(A) A ÂNCORA DECIDIA SOZINHA ESSES 11?');
    console.log('═'.repeat(74));
    console.log('\n   `decidirValorPago` tenta a ÂNCORA antes da precedência. Se a âncora');
    console.log('   já acertava, o crédito não é da exceção. Sem o texto do PDF (não está');
    console.log('   no banco) a âncora se cala — então testo com texto SINTÉTICO que');
    console.log('   reproduz o bloco do boleto, para ver quem vence.\n');
    const caso = linhas.find(l => /033\.DOC- 91288,49/.test(l.arq));
    if (caso) {
        const vNome = valorDoNomeArquivo(caso.arq);
        // texto onde a âncora ACHA o nº da fatura ao lado de um valor DIFERENTE
        const textoAncora = 'Numero Doc 26267   Valor do documento   5.368,68\n';
        const comAncora = V.decidirValorPago(caso.pd, { text: textoAncora, numeroDoNome: '26267', valorDoNome: vNome });
        const semTexto  = V.decidirValorPago(caso.pd, { text: '', numeroDoNome: '26267', valorDoNome: vNome });
        console.log(`   ${caso.arq.slice(0, 62)}`);
        console.log(`      nome/lançado = ${brl(vNome)}`);
        console.log(`      COM texto onde a âncora acha 5.368,68:`);
        console.log(`         Valor total = ${comAncora['Valor total']}   origem="${comAncora['Origem do valor pago']}"`);
        console.log(`      SEM texto (só a precedência):`);
        console.log(`         Valor total = ${semTexto['Valor total']}   origem="${semTexto['Origem do valor pago']}"`);
        console.log('\n   → a âncora VENCE a exceção quando acha o número no texto.');
        console.log('     Isso é por design (ela é mais específica), mas significa que');
        console.log('     na releitura REAL o ganho pode ser menor que 11.');
    }

    // ── (B) o CARNÊ ────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('(B) O CARNÊ: a exceção contamina as parcelas #pN?');
    console.log('═'.repeat(74));
    const pn = linhas.filter(l => /#p\d+$/i.test(l.arq));
    console.log(`\n   linhas de parcela (#pN) no banco: ${pn.length}`);
    let pnAfetada = 0;
    const pnEx = [];
    for (const { arq, pd } of pn) {
        const vNome = valorDoNomeArquivo(arq);
        const antes = V.valorPorPrecedencia(pd);
        const depois = V.valorPorPrecedencia(pd, vNome);
        if (antes.valor == null || depois.valor == null) continue;
        if (Math.abs(antes.valor - depois.valor) < 0.02) continue;
        pnAfetada++;
        if (pnEx.length < 6) pnEx.push({ arq, antes, depois, temLD: !!pd['Linha digitável'] });
    }
    console.log(`   parcelas cujo valor a exceção mudaria: ${pnAfetada}  ${pnAfetada ? '⚠' : '✓'}`);
    for (const e of pnEx) {
        console.log(`\n   ⚠ ${e.arq.slice(0, 60)}`);
        console.log(`      tem Linha digitável gravada? ${e.temLD ? 'SIM' : 'não'}`);
        console.log(`      ${brl(e.antes.valor)} → ${brl(e.depois.valor)} (${e.depois.origem})`);
    }
    console.log('\n   (process-folder:609-613 deleta LD e Valor do boleto ANTES de gerar');
    console.log('    as parcelas; se 0 acima, a proteção funciona também para a exceção)');

    // ── (C) o valor anterior se preserva? ──────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('(C) O VALOR ANTERIOR VAI PARA `Valor total da nota`?');
    console.log('═'.repeat(74));
    if (caso) {
        const vNome = valorDoNomeArquivo(caso.arq);
        const out = V.decidirValorPago(caso.pd, { text: '', numeroDoNome: null, valorDoNome: vNome });
        console.log(`\n   antes:  Valor total=${caso.pd['Valor total']}  Valor total da nota=${caso.pd['Valor total da nota'] || '(ausente)'}`);
        console.log(`   depois: Valor total=${out['Valor total']}  Valor total da nota=${out['Valor total da nota'] || '(ausente)'}`);
        const preservou = V.paraNumero(out['Valor total da nota']) != null;
        console.log(`\n   ${preservou ? '✓ o número antigo não se perdeu — quem confere vê os dois' : '⚠ o valor anterior sumiu'}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
