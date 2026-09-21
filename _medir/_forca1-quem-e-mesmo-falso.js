/**
 * _medir/_forca1-quem-e-mesmo-falso.js — separar nome fantasia de par falso
 *
 * MEDIDO ([[forca-1-e-quase-toda-par-falso]]): 133 dos 147 pares de força 1 (90,5%)
 * têm fornecedor incompatível com o documento. Mas a régua tem furo conhecido:
 *
 *     TELEFONICA DO BRASIL  ↔  documento "VIVO"        — mesma empresa
 *     COMPANHIA DE SANEAMENTO DE MINAS GERAIS ↔ COPASA — mesma empresa
 *
 * Nome fantasia × razão social. Sem tratar isso, qualquer regra acusa pares bons —
 * seria o quarto erro de régua da sessão ([[rcb-no-nome-e-numero-nao-tipo]],
 * [[nf-para-cte-nao-e-defeito]], [[notas-competindo-o-pool-e-2]]).
 *
 * ── O que este script faz ───────────────────────────────────────────────────
 *   1. lista os 133 para eu VER quantos são fantasia (não adivinhar a proporção)
 *   2. testa uma tabela de equivalência e mede quanto ela recupera
 *   3. usa o CNPJ como prova independente do nome: se o CNPJ do lançamento bate
 *      com o do documento, é a mesma empresa por mais diferente que o nome seja
 *   4. o resíduo depois de tudo isso é o pool real
 *
 * O CNPJ é o caminho certo — [[cnpj-nao-identifica-fornecedor]] reprovou usá-lo
 * como VETO de pareamento, mas aqui o uso é outro: confirmar identidade quando o
 * nome diverge, não vetar par.
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
const soDig = s => String(s || '').replace(/\D/g, '');

const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A)$/;
function tokensNome(arq) {
    return norm(arq).replace(/\.PDF$/i, '')
        .replace(/\d{1,4}\.DOC-?/i, ' ')
        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ')
        .replace(/[\d.,\/+#-]+/g, ' ')
        .split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
}
function nomeBate(entLanc, arq, emitenteDoc) {
    const e = norm(entLanc);
    if (!e) return true;
    const toks = tokensNome(arq);
    const alvo = e.split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
    if (!toks.length || !alvo.length) return true;
    for (const a of alvo) for (const t of toks) {
        if (a === t) return true;
        if (a.length >= 5 && t.length >= 5 && (a.startsWith(t.slice(0, 5)) || t.startsWith(a.slice(0, 5)))) return true;
    }
    const em = norm(emitenteDoc || '');
    if (em) for (const a of alvo) if (em.includes(a) || a.includes(em.slice(0, 6))) return true;
    return false;
}

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // CNPJ do lançamento: a planilha às vezes traz no campo ENTIDADE
    const cnpjDaEntidade = s => {
        const d = soDig(s);
        const m = String(s).match(/\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/);
        if (m) return soDig(m[0]);
        return d.length === 14 ? d : '';
    };

    const forca1 = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._cnpjBruto = String(l.cnpj || l.CNPJ || '');
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            if (x.forca !== 1) continue;
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            forca1.push({
                periodo, arq: x.documento.arquivo,
                ent: String(x.lancamento.entidade || ''),
                cnpjLanc: cnpjDaEntidade(x.lancamento.entidade) || soDig(x.lancamento._cnpjBruto),
                cnpjDoc: soDig(o.cnpj || ''),
                emit: String(o.emitente || ''),
                nf: soDig(x.lancamento.nf), numDoc: soDig(o.numero || ''),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
            });
        }
    }
    console.log(`pares de força 1: ${forca1.length}\n`);

    const incompat = forca1.filter(x => !nomeBate(x.ent, x.arq, x.emit));
    console.log('═'.repeat(78));
    console.log(`(1) OS ${incompat.length} COM NOME INCOMPATÍVEL — o CNPJ salva algum?`);
    console.log('═'.repeat(78));

    let cnpjBate = 0, cnpjDiscorda = 0, semCnpj = 0;
    const salvos = [];
    for (const x of incompat) {
        if (!x.cnpjLanc || !x.cnpjDoc || x.cnpjLanc.length < 14 || x.cnpjDoc.length < 14) { semCnpj++; continue; }
        if (x.cnpjLanc === x.cnpjDoc) { cnpjBate++; salvos.push(x); }
        else cnpjDiscorda++;
    }
    console.log(`\n   CNPJ do lançamento == CNPJ do documento: ${cnpjBate}  ← mesma empresa, nome fantasia`);
    console.log(`   CNPJ discorda:                           ${cnpjDiscorda}  ← par realmente errado`);
    console.log(`   sem CNPJ dos dois lados:                 ${semCnpj}  ← indecidível pelo CNPJ`);
    for (const s of salvos.slice(0, 8))
        console.log(`      ${s.ent.slice(0, 30)} ↔ ${s.emit.slice(0, 24)}  CNPJ ${s.cnpjDoc}`);

    // ── (2) a lista inteira, para eu VER e montar a tabela ────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) OS INCOMPATÍVEIS, UM A UM (para achar os nomes fantasia)');
    console.log('═'.repeat(78));
    for (const x of incompat.sort((a, b) => b.valor - a.valor)) {
        console.log(`\n   ${x.periodo} ${brl(x.valor).padStart(13)}  NF=${x.nf || '—'} × doc=${x.numDoc || '—'}`);
        console.log(`      lanç: ${x.ent.slice(0, 46)}`);
        console.log(`      doc:  ${x.emit.slice(0, 30).padEnd(32)} ${x.arq.slice(0, 40)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
