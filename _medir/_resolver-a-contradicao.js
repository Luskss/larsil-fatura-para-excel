/**
 * _medir/_resolver-a-contradicao.js — qual linha o painel usa, a #pN ou a do documento?
 *
 * CONTRADIÇÃO entre dois scripts meus (21/09/2026):
 *   • `_quantos-documentos-de-verdade.js` → os 11 curados são linhas `#pN`; 0 documentos
 *   • `_o-que-sobrou-dos-58.js`           → 0 dos 58 são `#pN`; 55 são documento
 *
 * Os dois não podem estar certos. A diferença está em COMO cada um buscou o
 * `dados_parser`: o primeiro varreu TODAS as linhas do banco; o segundo buscou pelo
 * nome EXATO que o pareamento usou, com fallback para o nome base.
 *
 * ── A pergunta que decide ───────────────────────────────────────────────────
 * Quando um carnê gera linhas `#p1..#pN`, EXISTE também uma linha sem sufixo? Se
 * não existe, o `documento.arquivo` do pareamento (que vem da PASTA, sem sufixo)
 * não encontra linha própria — e o `x.documento.valor` vem de outro lugar.
 *
 * De onde vem `documento.valor`, afinal? Se vier do índice de OCR e não do
 * `dados_parser`, então NENHUMA das minhas conclusões sobre `Valor total` se
 * aplica ao que o painel exibe — e eu estaria consertando um campo que o painel
 * não lê. É exatamente [[a-chave-do-parser-e-em-portugues]] e
 * [[parser-nao-cobre-campos-do-pareamento]].
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    const nomesNoBanco = new Set();
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo');
        if (iA < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const a = String(sep(ls[i])[iA] || '').trim();
            if (a) nomesNoBanco.add(a);
        }
    }

    const ALVOS = [
        '033.DOC- 91288,49 - 2026.03.12. LOCALIZA. FAT 26267.pdf',
        '016.DOC- 813,48 - 2026.03.12. LOCALIZA. FAT 408162.pdf',
        '020.DOC- 999,22 - 2026.03.12. LOCALIZA. FAT 102626.pdf',
    ];
    console.log('═'.repeat(74));
    console.log('(1) O CARNÊ TEM LINHA SEM SUFIXO?');
    console.log('═'.repeat(74));
    for (const alvo of ALVOS) {
        const temBase = nomesNoBanco.has(alvo);
        const pns = [...nomesNoBanco].filter(n => semPN(n) === alvo && n !== alvo);
        console.log(`\n   ${alvo.slice(0, 62)}`);
        console.log(`      linha SEM sufixo existe? ${temBase ? 'SIM' : 'NÃO'}`);
        console.log(`      linhas #pN: ${pns.length}${pns.length ? '  (' + pns.map(x => x.slice(-3)).join(', ') + ')' : ''}`);
    }

    // ── (2) de onde vem x.documento.valor? ─────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('(2) DE ONDE VEM `documento.valor` NO PAREAMENTO?');
    console.log('═'.repeat(74));
    const c = h.carregar();
    const idxOcr = await indexar();

    // um documento alvo, rastreado
    const alvo = ALVOS[0];
    let achado = null;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {})) {
        const a = arqs.find(x => x.nome === alvo);
        if (a) { achado = { mes, a }; break; }
    }
    if (!achado) { console.log('   (não achei o alvo na pasta)'); }
    else {
        const semOcr = p.documentoDoArquivo(achado.a.nome, achado.a.rel);
        const comOcr = p.enriquecerComOcr(p.documentoDoArquivo(achado.a.nome, achado.a.rel), idxOcr[achado.a.nome]);
        console.log(`\n   ${alvo.slice(0, 62)}   (mês ${achado.mes})`);
        console.log(`      valor SÓ do nome do arquivo:      ${semOcr.valor == null ? '—' : brl(semOcr.valor)}`);
        console.log(`      valor APÓS enriquecerComOcr:      ${comOcr.valor == null ? '—' : brl(comOcr.valor)}`);
        console.log(`      o índice de OCR tem este arquivo? ${idxOcr[achado.a.nome] ? 'SIM' : 'não'}`);
        if (idxOcr[achado.a.nome]) {
            const o = idxOcr[achado.a.nome];
            console.log(`      campos do índice: ${Object.keys(o).slice(0, 10).join(', ')}`);
            if (o.valor != null) console.log(`      idxOcr.valor = ${brl(o.valor)}`);
        }
        console.log('\n   → se o valor APÓS o OCR é o errado, é ELE que o painel exibe,');
        console.log('     e a origem dele é o índice — que vem do `dados_parser` gravado.');
    }

    // ── (3) o índice de OCR indexa a #pN ou a base? ────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('(3) O ÍNDICE DE OCR: por qual nome ele indexa?');
    console.log('═'.repeat(74));
    const chaves = Object.keys(idxOcr);
    const comPN = chaves.filter(k => /#p\d+$/i.test(k)).length;
    console.log(`\n   chaves no índice: ${chaves.length}`);
    console.log(`   com sufixo #pN:   ${comPN}`);
    console.log(`   sem sufixo:       ${chaves.length - comPN}`);
    for (const alvo2 of ALVOS) {
        const direto = idxOcr[alvo2];
        const pns = chaves.filter(k => semPN(k) === alvo2 && k !== alvo2);
        console.log(`\n   ${alvo2.slice(0, 56)}`);
        console.log(`      no índice pelo nome base? ${direto ? 'SIM' : 'não'}   ${direto && direto.valor != null ? '→ valor=' + brl(direto.valor) : ''}`);
        console.log(`      chaves #pN no índice: ${pns.length}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
