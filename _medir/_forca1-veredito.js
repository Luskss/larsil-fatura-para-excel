/**
 * _medir/_forca1-veredito.js — a decisão sobre a força 1, com a régua boa
 *
 * RÉGUA CORRIGIDA (`_forca1-regua-corrigida.js`): piso de 3 letras (pega BRV, TMJ,
 * TIM) e estado "indecidível" separado de "bate". O quadro real:
 *
 *   força   pares   bate   NÃO bate   indecidível
 *     3      1546   1478       68          0        ← 95,6% de acerto
 *     2       431    344       79          8        ← 79,8%
 *     1       147      4      142          1        ← 2,7%
 *
 * **142 dos 147 pares de força 1 casam lançamento e documento sem relação.** Os 4
 * legítimos são TCO, THR (2×) e TRACKPLUS; o indecidível (GM & S) é visivelmente
 * correto pelo emitente.
 *
 * ── As variantes ────────────────────────────────────────────────────────────
 *   A  hoje                — 147 pares de força 1, 142 falsos
 *   B  exigir que BATA     — mantém 4; corta os 142 falsos E o indecidível
 *   C  cortar só os "NÃO"  — mantém 4 + 1 indecidível, corta 142
 *   D  desligar a força 1  — corta os 147
 *
 * C é B com o benefício da dúvida para o indecidível. Em produção, "não consigo
 * julgar" não deve virar "reprovado" — cortaria par bom em silêncio.
 *
 * ── O que decide ────────────────────────────────────────────────────────────
 * Não é o número de pares (perder par falso é ganho), e sim:
 *   • falsos eliminados × legítimos preservados
 *   • o efeito nas forças 2 e 3 (deve ser ZERO)
 *   • quantos lançamentos ficam sem documento — e se isso é honesto
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|REC|VIA|COPIA|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A|EM|NA|NO)$/;
const PISO = 3;
function tokens(txt, ehArquivo) {
    let t = norm(txt);
    if (ehArquivo) t = t.replace(/\.PDF$/i, '').replace(/\d{1,4}\.DOC-?/i, ' ')
                        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ');
    return t.replace(/[\d.,\/+#;&-]+/g, ' ').split(/\s+/)
            .filter(x => x.length >= PISO && !RUIDO.test(x));
}
function avaliar(entLanc, arq, emitenteDoc) {
    const alvo = tokens(entLanc, false);
    const doDoc = [...new Set([...tokens(arq, true), ...tokens(emitenteDoc, false)])];
    if (!alvo.length || !doDoc.length) return 'indecidivel';
    for (const a of alvo) for (const t of doDoc) {
        if (a === t) return 'bate';
        const n = Math.min(a.length, t.length, 5);
        if (n >= 4 && a.slice(0, n) === t.slice(0, n)) return 'bate';
    }
    return 'nao';
}

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    const pares = [];
    let lancTot = 0;
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        lancTot += lancs.length;
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            pares.push({ periodo, arq: x.documento.arquivo, forca: x.forca,
                          ent: String(x.lancamento.entidade || ''),
                          valor: Math.abs(Number(x.lancamento.valor) || 0),
                          estado: avaliar(x.lancamento.entidade, x.documento.arquivo, o.emitente) });
        }
    }

    const VARIANTES = {
        A_hoje:           () => true,
        B_exige_bate:     x => x.forca > 1 || x.estado === 'bate',
        C_corta_so_nao:   x => x.forca > 1 || x.estado !== 'nao',
        D_desliga_f1:     x => x.forca > 1,
    };

    console.log('═'.repeat(78));
    console.log('AS VARIANTES, COM A RÉGUA CORRIGIDA');
    console.log('═'.repeat(78));
    console.log('\nvariante            pares   f3     f2    f1   falsos cortados   bons cortados');
    const res = {};
    for (const [k, fn] of Object.entries(VARIANTES)) {
        const s = pares.filter(fn);
        const f3 = s.filter(x => x.forca === 3).length;
        const f2 = s.filter(x => x.forca === 2).length;
        const f1 = s.filter(x => x.forca === 1).length;
        const falsosCortados = pares.filter(x => x.forca === 1 && x.estado === 'nao' && !fn(x)).length;
        const bonsCortados = pares.filter(x => x.forca === 1 && x.estado !== 'nao' && !fn(x)).length;
        res[k] = { total: s.length, f3, f2, f1, falsosCortados, bonsCortados };
        console.log(`  ${k.padEnd(18)} ${String(s.length).padStart(5)}  ${String(f3).padStart(4)}  ${String(f2).padStart(5)}  ${String(f1).padStart(4)}  ${String(falsosCortados).padStart(15)}  ${String(bonsCortados).padStart(14)}`);
    }

    console.log('\n── as forças 2 e 3 ficam intactas? ─────────────────────────');
    const A = res.A_hoje;
    let ok = true;
    for (const [k, v] of Object.entries(res)) {
        if (k === 'A_hoje') continue;
        const intacto = v.f3 === A.f3 && v.f2 === A.f2;
        if (!intacto) ok = false;
        console.log(`  ${k.padEnd(18)} força3 ${v.f3 === A.f3 ? 'igual ✓' : 'MUDOU ⚠'}   força2 ${v.f2 === A.f2 ? 'igual ✓' : 'MUDOU ⚠'}`);
    }
    console.log(`\n   ${ok ? '✓ nenhuma variante toca as forças 2 e 3' : '⚠ alguma variante vazou'}`);

    // ── o efeito na cobertura ──────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('O EFEITO NO PAINEL');
    console.log('═'.repeat(78));
    console.log(`\n   lançamentos: ${lancTot}`);
    for (const [k, v] of Object.entries(res)) {
        const semDoc = lancTot - v.total;
        console.log(`   ${k.padEnd(18)} cobertura ${pct(v.total, lancTot).padStart(6)}   sem documento: ${semDoc}`);
    }
    console.log('\n   Perder um par FALSO não piora o painel: o lançamento já não tinha');
    console.log('   documento de verdade. A cobertura cai, a CONFIANÇA sobe.');

    // ── precisão geral ─────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('PRECISÃO DO PAINEL (pares cujo fornecedor confere)');
    console.log('═'.repeat(78));
    console.log('');
    for (const [k, fn] of Object.entries(VARIANTES)) {
        const s = pares.filter(fn);
        const bate = s.filter(x => x.estado === 'bate').length;
        const nao = s.filter(x => x.estado === 'nao').length;
        console.log(`   ${k.padEnd(18)} bate ${String(bate).padStart(5)}   não bate ${String(nao).padStart(4)}   precisão ${pct(bate, bate + nao).padStart(6)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
