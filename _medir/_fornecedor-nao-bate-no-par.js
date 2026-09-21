/**
 * _medir/_fornecedor-nao-bate-no-par.js — pares onde o fornecedor não confere
 *
 * ACHADO ao preparar a fila (`_fila-fechar-em-bloco.js`): entre os alertas de tipo
 * apareceram pares com fornecedor INCOMPATÍVEL com o documento:
 *
 *     lançamento AUTO POSTO CAROLINE  ← doc "ADRIANO CIRILO. FAT 902708.pdf"
 *     lançamento NATALY M P DA SILVA  ← doc "ADRIANO CIRILO. FAT 902708.pdf"
 *     lançamento 64.239.393 RAFAIANE  ← doc "MEGA REDES. RCB 902039.pdf"
 *
 * O MESMO documento pareado com fornecedores diferentes e alheios. Todos de
 * R$ 100,00 — casaram só por VALOR (força 1), e valor redondo colide fácil.
 *
 * Isso é pior que divergência de tipo: é PAR FALSO. O usuário abre a conferência,
 * vê um documento que não tem nada a ver com o lançamento, e perde a confiança no
 * painel inteiro.
 *
 * ── Antes de concluir, cuidado com a régua ──────────────────────────────────
 * O nome do arquivo traz o nome de QUEM RECEBEU (o favorecido do pagamento), e a
 * planilha traz a ENTIDADE do lançamento. Nem sempre são a mesma coisa — um
 * pagamento a "ADRIANO CIRILO" pode quitar uma nota do "AUTO POSTO CAROLINE" se
 * for repasse. Então "não bate" não prova falso.
 *
 * O que prova: o documento ter um NÚMERO e o lançamento ter OUTRO, com o
 * fornecedor também diferente — três sinais discordando.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 *   1. quantos pares têm fornecedor incompatível? por força
 *   2. desses, quantos têm também número discordante?
 *   3. quanto valor está nesses pares
 *   4. um documento servindo N lançamentos de fornecedores diferentes
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

// palavras do nome do arquivo que NÃO são fornecedor
const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A)$/;
function tokensNome(arq) {
    return norm(arq)
        .replace(/\.PDF$/i, '')
        .replace(/\d{1,4}\.DOC-?/i, ' ')
        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ')
        .replace(/[\d.,\/+#-]+/g, ' ')
        .split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
}
function compativel(entLanc, arq, emitenteDoc) {
    const e = norm(entLanc);
    if (!e) return true;
    const toks = tokensNome(arq);
    const alvo = e.split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
    if (!toks.length || !alvo.length) return true;      // sem base, não acusa
    for (const a of alvo) for (const t of toks) {
        if (a === t) return true;
        if (a.length >= 5 && t.length >= 5 && (a.startsWith(t.slice(0, 5)) || t.startsWith(a.slice(0, 5)))) return true;
    }
    // o emitente lido do papel também vale como prova
    const em = norm(emitenteDoc || '');
    if (em) for (const a of alvo) if (em.includes(a) || a.includes(em.slice(0, 6))) return true;
    return false;
}

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    const pares = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            pares.push({
                periodo, arq: x.documento.arquivo, forca: x.forca,
                ent: String(x.lancamento.entidade || ''),
                nf: soDig(x.lancamento.nf),
                numDoc: soDig(o.numero || ''),
                emit: String(o.emitente || ''),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
            });
        }
    }
    console.log(`pares: ${pares.length}\n`);

    // ── (1) fornecedor incompatível ────────────────────────────────────────
    const ruins = pares.filter(x => !compativel(x.ent, x.arq, x.emit));
    console.log('═'.repeat(78));
    console.log('(1) O FORNECEDOR DO LANÇAMENTO APARECE NO DOCUMENTO?');
    console.log('═'.repeat(78));
    console.log(`\n   pares com fornecedor INCOMPATÍVEL: ${ruins.length}  ${pct(ruins.length, pares.length)}`);
    const porForca = new Map();
    for (const x of ruins) porForca.set(x.forca, (porForca.get(x.forca) || 0) + 1);
    const totalPorForca = new Map();
    for (const x of pares) totalPorForca.set(x.forca, (totalPorForca.get(x.forca) || 0) + 1);
    console.log('\n   por força do par:');
    for (const f of [3, 2, 1])
        console.log(`      força ${f}: ${String(porForca.get(f) || 0).padStart(4)} de ${String(totalPorForca.get(f) || 0).padStart(4)}   ${pct(porForca.get(f) || 0, totalPorForca.get(f) || 0)}`);
    console.log(`\n   valor envolvido: ${brl(ruins.reduce((s, x) => s + x.valor, 0))}`);

    // ── (2) o número também discorda? ──────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O NÚMERO TAMBÉM DISCORDA? (três sinais contra)');
    console.log('═'.repeat(78));
    const comNum = ruins.filter(x => x.nf && x.numDoc && x.nf.length >= 4 && x.nf !== x.numDoc);
    const semBase = ruins.filter(x => !x.nf || !x.numDoc || x.nf.length < 4);
    const numIgual = ruins.filter(x => x.nf && x.numDoc && x.nf === x.numDoc);
    console.log(`\n   número do lançamento ≠ número do documento: ${comNum.length}  ← par provavelmente FALSO`);
    console.log(`   número IGUAL (o fornecedor é que difere):    ${numIgual.length}  ← repasse/terceiro`);
    console.log(`   sem número para comparar:                    ${semBase.length}`);
    console.log(`\n   valor dos provavelmente falsos: ${brl(comNum.reduce((s, x) => s + x.valor, 0))}`);

    // ── (3) um documento servindo vários fornecedores ──────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) UM DOCUMENTO PARA VÁRIOS FORNECEDORES DIFERENTES');
    console.log('═'.repeat(78));
    const porArq = new Map();
    for (const x of pares) {
        if (!porArq.has(x.arq)) porArq.set(x.arq, []);
        porArq.get(x.arq).push(x);
    }
    const multiForn = [];
    for (const [arq, lista] of porArq) {
        const ents = new Set(lista.map(x => norm(x.ent).slice(0, 12)).filter(Boolean));
        if (ents.size > 1) multiForn.push({ arq, lista, n: ents.size });
    }
    console.log(`\n   documentos pareados com 2+ fornecedores distintos: ${multiForn.length}`);
    for (const m of multiForn.sort((a, b) => b.n - a.n).slice(0, 10)) {
        console.log(`\n   ${m.arq.slice(0, 62)}`);
        for (const x of m.lista)
            console.log(`      ${x.periodo} ${brl(x.valor).padStart(12)} f${x.forca}  ${x.ent.slice(0, 40)}`);
    }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('AMOSTRA DOS PROVAVELMENTE FALSOS (maiores)');
    console.log('═'.repeat(78));
    for (const x of comNum.sort((a, b) => b.valor - a.valor).slice(0, 12)) {
        console.log(`\n   ${x.periodo}  ${brl(x.valor)}  força ${x.forca}`);
        console.log(`      lançamento: ${x.ent.slice(0, 44)}   NF=${x.nf}`);
        console.log(`      documento:  ${x.arq.slice(0, 54)}`);
        console.log(`      emitente lido: ${x.emit.slice(0, 34)}   nº=${x.numDoc}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
