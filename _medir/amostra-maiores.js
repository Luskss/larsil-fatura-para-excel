/**
 * _medir/amostra-maiores.js — os N lançamentos SEM DOCUMENTO de maior valor.
 *
 * Diferente de `amostra.js`, que sorteia para medir proporção: aqui o objetivo é
 * decidir. Medido em 03/2026: 94 dos 248 sem documento concentram R$ 2,25 mi de
 * R$ 2,29 mi. Conferir os maiores responde "o dinheiro está coberto?" com muito
 * menos trabalho do que conferir uma amostra aleatória.
 *
 * Para cada um a lista traz o que decide na hora:
 *   • os candidatos do MESMO fornecedor que o motor viu e recusou, com o motivo;
 *   • se 2-3 documentos do fornecedor SOMAM o valor do lançamento (parcela 1↔N);
 *   • todas as pastas já consultadas.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const par = require('../routes/_pareamento');

const N = Number(process.env.MAIORES_N || 30);
const brl = v => (Math.abs(v) || 0).toLocaleString('pt-BR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dia = t => t == null ? '' : new Date(t).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

// Por que este documento não casou com este lançamento? Em português, não em flags.
function porqueNao(l, d) {
    const num = par.numeroBate(l, d), val = par.valorBate(l, d);
    const partes = [];
    if (num) partes.push('número bate');
    else if (d.numeroDig) partes.push(`número difere (papel ${d.numeroDig} × planilha ${l.nfDig || '—'})`);
    else partes.push('sem número legível no papel');
    if (val) partes.push('valor bate');
    else if (d.valor != null) {
        const dif = Math.abs(Math.abs(l.valor) - d.valor);
        const pc = Math.abs(l.valor) ? (dif / Math.abs(l.valor) * 100) : 0;
        partes.push(`valor difere ${pc.toFixed(1)}% (papel ${brl(d.valor)})`);
    } else partes.push('sem valor legível no papel');
    const dist = par.distanciaDias(l, d);
    if (dist != null) partes.push(`${Math.round(dist)} dias do lançamento`);
    return partes.join(' · ');
}

// 2 ou 3 documentos livres do mesmo fornecedor que somam o valor do lançamento.
// Só vale como PISTA: somar subconjunto acha coincidência com facilidade, e a
// conferência humana é justamente quem separa parcela real de acaso aritmético.
function somaParcelas(l, docs) {
    const alvo = Math.abs(l.valor);
    if (!(alvo > 0)) return null;
    const m = docs.filter(d => d.valor != null).slice(0, 60);
    for (let i = 0; i < m.length; i++) {
        for (let j = i + 1; j < m.length; j++) {
            if (Math.abs(m[i].valor + m[j].valor - alvo) < 0.02) return [m[i], m[j]];
            for (let k = j + 1; k < m.length; k++)
                if (Math.abs(m[i].valor + m[j].valor + m[k].valor - alvo) < 0.02)
                    return [m[i], m[j], m[k]];
        }
    }
    return null;
}

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    const todos = [];
    for (const periodo of h.PERIODOS) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        const pastas = [];
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            pastas.push(alvo);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const usados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.documento.arquivo));
        const docs = Object.values(documentosPorMes).flat();
        const livres = docs.filter(d => !usados.has(d.arquivo));

        for (const l of r.semDocumento) {
            const mesmos = livres.filter(d => par.entidadeBate(l, d));
            todos.push({
                periodo, l, pastas,
                // Só é candidato de verdade quem bate número OU chega perto no
                // valor (≤25%). Sem esse corte a lista enchia de documento do
                // mesmo fornecedor com 98% de diferença de valor — ruído que faz
                // quem confere perder tempo lendo o que já dá para descartar.
                candidatos: mesmos
                    .filter(d => par.numeroBate(l, d) || (d.valor != null && Math.abs(l.valor) > 0 &&
                        Math.abs(Math.abs(l.valor) - d.valor) / Math.abs(l.valor) <= 0.25))
                    .map(d => ({ d, txt: porqueNao(l, d) }))
                    .sort((a, b) => {
                        const va = a.d.valor == null ? Infinity : Math.abs(Math.abs(l.valor) - a.d.valor);
                        const vb = b.d.valor == null ? Infinity : Math.abs(Math.abs(l.valor) - b.d.valor);
                        return va - vb;
                    }).slice(0, 3),
                parcelas: somaParcelas(l, mesmos),
            });
        }
    }

    todos.sort((a, b) => Math.abs(b.l.valor) - Math.abs(a.l.valor));
    const sel = todos.slice(0, N);
    const somaSel = sel.reduce((s, x) => s + Math.abs(x.l.valor), 0);
    const somaTudo = todos.reduce((s, x) => s + Math.abs(x.l.valor), 0);

    // ── CSV para preencher ──────────────────────────────────────────────────
    const cab = ['n', 'periodo', 'fornecedor', 'nf', 'valor', 'dt_lancamento',
        'pastas_procuradas', 'candidato_1', 'porque_nao_casou', 'soma_parcelas',
        'ACHOU? (S/N)', 'onde_estava', 'obs'];
    const linhas = [cab];
    sel.forEach((x, i) => {
        linhas.push([
            i + 1, x.periodo, x.l.entidade, x.l.nf, brl(x.l.valor), dia(x.l.dtLancamento),
            x.pastas.join(' '),
            x.candidatos[0] ? x.candidatos[0].d.arquivo : '(nenhum do mesmo fornecedor)',
            x.candidatos[0] ? x.candidatos[0].txt : '',
            x.parcelas ? x.parcelas.map(d => brl(d.valor)).join(' + ') : '',
            '', '', '',
        ]);
    });
    const csv = linhas.map(r => r.map(v => {
        const s = String(v == null ? '' : v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')).join('\r\n');
    const saidaCsv = path.join(__dirname, 'conferir-maiores.csv');
    fs.writeFileSync(saidaCsv, '﻿' + csv, 'utf8');

    // ── TXT para conferir lendo ─────────────────────────────────────────────
    const t = [];
    t.push('CONFERÊNCIA — os maiores lançamentos sem documento');
    t.push(`${sel.length} de ${todos.length} · R$ ${brl(somaSel)} de R$ ${brl(somaTudo)} ` +
           `(${(somaSel / somaTudo * 100).toFixed(0)}% do valor que falta)`);
    t.push(`Períodos: ${h.PERIODOS.join(', ')}`);
    t.push('');
    t.push('Para cada um: procure o PDF e marque S (achou) ou N (não está em pasta nenhuma).');
    t.push('Se achou, anote o nome do arquivo — é o que me diz por que o motor não viu.');
    t.push('');
    t.push('"candidato" = documento do MESMO fornecedor que o motor viu e recusou.');
    t.push('"somam" = 2-3 documentos do fornecedor que somam o valor (possível parcela).');
    t.push('='.repeat(76));
    sel.forEach((x, i) => {
        t.push('');
        t.push(`${String(i + 1).padStart(3)}. ${x.l.entidade}`);
        t.push(`     NF ${x.l.nf || '(sem)'} · R$ ${brl(x.l.valor)} · lanç. ${dia(x.l.dtLancamento) || '?'} · ${x.periodo}`);
        t.push(`     procurado em: ${x.pastas.join(', ')}`);
        if (x.candidatos.length) {
            for (const cd of x.candidatos) {
                t.push(`     candidato: ${cd.d.arquivo}`);
                t.push(`                ${cd.txt}`);
            }
        } else {
            t.push('     candidato: nenhum documento do mesmo fornecedor nas pastas');
        }
        if (x.parcelas)
            t.push(`     somam:     ${x.parcelas.map(d => brl(d.valor)).join(' + ')} = ${brl(x.l.valor)}` +
                   `  (${x.parcelas.map(d => d.arquivo.slice(0, 30)).join(' | ')})`);
        t.push('     ACHOU? [ ]S  [ ]N    arquivo: ________________________________');
    });
    const saidaTxt = path.join(__dirname, 'conferir-maiores.txt');
    fs.writeFileSync(saidaTxt, t.join('\n'), 'utf8');

    const comCand = sel.filter(x => x.candidatos.length).length;
    const comParc = sel.filter(x => x.parcelas).length;
    console.log(`${sel.length} maiores · R$ ${brl(somaSel)} (${(somaSel / somaTudo * 100).toFixed(0)}% do que falta)`);
    console.log(`  com candidato do mesmo fornecedor ... ${comCand}`);
    console.log(`  com soma de parcelas batendo ........ ${comParc}`);
    console.log(`  sem pista nenhuma ................... ${sel.length - comCand}`);
    console.log(`\ngerados:\n  ${saidaCsv}\n  ${saidaTxt}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
