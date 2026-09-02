/**
 * _medir/amostra.js — monta a amostra de auditoria dos "sem documento".
 *
 * O painel diz que N lançamentos não têm documento arquivado. Ninguém sabe quanto
 * disso é nota que realmente não foi arquivada e quanto é PDF que existe mas o
 * pareamento não achou. Só olho humano no arquivo responde, e para isso a lista
 * tem de vir CONFERÍVEL: o que procurar, onde já foi procurado, e o candidato mais
 * parecido que o motor viu e recusou.
 *
 * A amostra é ALEATÓRIA com semente fixa — reproduzível, e sem o viés de pegar os
 * primeiros da planilha (que sairiam ordenados por data e fornecedor).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const par = require('../routes/_pareamento');

const TAMANHO = Number(process.env.AMOSTRA_N || 40);
const SEMENTE = Number(process.env.AMOSTRA_SEMENTE || 20260902);

// PRNG com semente, para a amostra ser reproduzível.
function aleatorio(semente) {
    let s = semente >>> 0;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function amostrar(lista, n, semente) {
    const r = [...lista];
    const rnd = aleatorio(semente);
    for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [r[i], r[j]] = [r[j], r[i]];
    }
    return r.slice(0, n);
}

const fmtBRL = v => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtData = t => t == null ? '' : new Date(t).toISOString().slice(0, 10).split('-').reverse().join('/');

/**
 * O documento MAIS PARECIDO que existe nas pastas consultadas, mesmo não tendo
 * casado. É a informação que decide a conferência: se o motor errou por pouco, o
 * candidato aparece aqui e quem confere vê na hora; se não há candidato nenhum, é
 * indício de que a nota realmente não está arquivada.
 */
function melhorCandidato(l, docs) {
    // Começa em 0, não em -1: documento que não bate em NADA tem nota 0 e não
    // pode virar "o mais parecido". Com -1 ele virava, e a lista saía cheia de
    // pista falsa (DETRAN PR apontando para um documento da SAVANA).
    let melhor = null, melhorNota = 0;
    for (const d of docs) {
        let nota = 0;
        const porque = [];
        if (par.entidadeBate(l, d)) { nota += 3; porque.push('fornecedor'); }
        if (par.numeroBate(l, d)) { nota += 3; porque.push('número'); }
        if (par.valorBate(l, d)) { nota += 3; porque.push('valor'); }
        // Valor perto (até 10%) só conta quando algum campo de IDENTIDADE já
        // bateu — separa boleto com desconto sem transformar todo documento de
        // valor parecido em candidato.
        if (!par.valorBate(l, d) && porque.length && d.valor != null && l.valor > 0) {
            const dif = Math.abs(l.valor - d.valor) / l.valor;
            if (dif <= 0.10) { nota += 1; porque.push(`valor ~${(dif * 100).toFixed(1)}%`); }
        }
        if (!porque.length) continue;   // não bateu em nada: não é pista
        const dist = par.distanciaDias(l, d);
        if (dist != null && dist <= 30) nota += 0.5;
        if (nota > melhorNota) { melhorNota = nota; melhor = { d, porque, nota, dist }; }
    }
    return melhorNota <= 0 ? null : melhor;
}

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();

    // Índice do OCR pelo código de produção.
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    // Junta os "sem documento" de todos os períodos, guardando o contexto de cada um.
    const semDoc = [];
    for (const periodo of h.PERIODOS) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        const pastasConsultadas = [];
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            pastasConsultadas.push(alvo);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const casados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.lancamento));
        const todosDocs = Object.values(documentosPorMes).flat();

        for (const l of lancamentos) {
            if (casados.has(l)) continue;
            semDoc.push({ periodo, l, pastasConsultadas, todosDocs });
        }
    }

    console.error(`[amostra] ${semDoc.length} lançamentos sem documento nos 6 períodos`);
    const sel = amostrar(semDoc, TAMANHO, SEMENTE);

    // ── CSV para conferir (abre no Excel) ───────────────────────────────────
    const linhas = [[
        'n', 'periodo', 'fornecedor', 'nf', 'valor', 'dt_lancamento', 'dt_emissao',
        'pastas_procuradas', 'candidato_mais_parecido', 'candidato_bate_em',
        'candidato_dist_dias', 'ACHOU? (S/N)', 'onde_estava', 'obs',
    ]];
    const relatorio = [];

    // Calcula o candidato antes de listar, e ordena do mais forte para o mais
    // fraco: quem confere começa pelos que provavelmente são erro do motor (têm
    // documento parecido na pasta) e termina nos que provavelmente são nota que
    // não foi arquivada. Assim uma conferência parcial já responde a pergunta.
    const comCandidato = sel.map(s => ({ ...s, cand: melhorCandidato(s.l, s.todosDocs) }));
    comCandidato.sort((a, b) => (b.cand ? b.cand.nota : 0) - (a.cand ? a.cand.nota : 0));

    comCandidato.forEach((s, i) => {
        const { l, periodo, pastasConsultadas, cand } = s;
        linhas.push([
            i + 1, periodo, l.entidade, l.nf, fmtBRL(l.valor),
            fmtData(l.dtLancamento), fmtData(l.dtEmissao),
            pastasConsultadas.join(' '),
            cand ? cand.d.arquivo : '(nenhum parecido)',
            cand ? cand.porque.join('+') : '',
            cand && cand.dist != null ? Math.round(cand.dist) : '',
            '', '', '',
        ]);
        relatorio.push({ i: i + 1, periodo, l, cand, pastasConsultadas });
    });

    const csv = linhas.map(r => r.map(v => {
        const s = String(v == null ? '' : v);
        return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')).join('\r\n');
    const saidaCsv = path.join(__dirname, 'amostra-sem-documento.csv');
    fs.writeFileSync(saidaCsv, '﻿' + csv, 'utf8');

    // ── Texto legível, para conferir sem abrir o Excel ──────────────────────
    const txt = [];
    txt.push(`AMOSTRA DE AUDITORIA — lançamentos sem documento`);
    txt.push(`${sel.length} de ${semDoc.length} sorteados (semente ${SEMENTE}, reproduzível)`);
    txt.push(`Períodos: ${h.PERIODOS.join(', ')}`);
    txt.push('');
    txt.push('Para cada linha: procure o PDF na pasta e marque ACHOU? = S ou N.');
    txt.push('  S = o papel existe (o comparador errou) — anote onde estava');
    txt.push('  N = não achou em pasta nenhuma (a nota realmente não foi arquivada)');
    txt.push('');
    txt.push('='.repeat(78));
    for (const r of relatorio) {
        txt.push('');
        txt.push(`${String(r.i).padStart(3)}. ${r.l.entidade}`);
        txt.push(`     NF ${r.l.nf || '(sem)'}  ·  R$ ${fmtBRL(r.l.valor)}` +
                 `  ·  lanç. ${fmtData(r.l.dtLancamento) || '?'}` +
                 (r.l.dtEmissao ? `  ·  emis. ${fmtData(r.l.dtEmissao)}` : ''));
        txt.push(`     procurado em: ${r.pastasConsultadas.join(', ')}`);
        if (r.cand) {
            txt.push(`     mais parecido: ${r.cand.d.arquivo}`);
            txt.push(`                    bate em ${r.cand.porque.join(' + ')}` +
                     (r.cand.dist != null ? `, a ${Math.round(r.cand.dist)} dias` : ''));
        } else {
            txt.push(`     mais parecido: nenhum documento parecido nas pastas`);
        }
        txt.push(`     ACHOU? [ ]S  [ ]N     onde: ______________________`);
    }
    // Escrito só depois do cabeçalho de composição, inserido logo abaixo.
    const saidaTxt = path.join(__dirname, 'amostra-sem-documento.txt');

    // ── Composição do UNIVERSO (os 1.121), não só da amostra ───────────────
    // Diz o que a amostra representa: se 74% dos sem-documento têm algum PDF do
    // MESMO fornecedor na pasta, o gargalo não é nota faltando, é o motor não
    // conseguir decidir QUAL documento é o par.
    let uNumEnt = 0, uValEnt = 0, uSoEnt = 0, uNada = 0;
    for (const s of semDoc) {
        let tipo = 'nada';
        for (const d of s.todosDocs) {
            const e = par.entidadeBate(s.l, d);
            if (!e) continue;
            if (par.numeroBate(s.l, d)) { tipo = 'numEnt'; break; }
            if (par.valorBate(s.l, d)) { tipo = 'valEnt'; }
            else if (tipo === 'nada') tipo = 'soEnt';
        }
        if (tipo === 'numEnt') uNumEnt++;
        else if (tipo === 'valEnt') uValEnt++;
        else if (tipo === 'soEnt') uSoEnt++;
        else uNada++;
    }
    const pcU = n => `${n} (${(n / semDoc.length * 100).toFixed(1)}%)`;
    txt.splice(7, 0,
        '',
        `COMPOSIÇÃO DOS ${semDoc.length} SEM DOCUMENTO (universo, não só a amostra):`,
        `  fornecedor + valor batem, número difere .. ${pcU(uValEnt)}`,
        `  só o fornecedor bate ..................... ${pcU(uSoEnt)}`,
        `  nenhum PDF do mesmo fornecedor ........... ${pcU(uNada)}`,
        '',
        `Ou seja: em ${(100 - uNada / semDoc.length * 100).toFixed(0)}% dos casos EXISTE papel do mesmo fornecedor na`,
        `pasta — o motor só não consegue decidir qual é o par. É a esses que a`,
        `conferência precisa responder: é o documento certo ou é outra compra?`);
    fs.writeFileSync(saidaTxt, txt.join('\n'), 'utf8');

    // ── Composição da amostra, para saber o que esperar ────────────────────
    const comCand = relatorio.filter(r => r.cand).length;
    const forte = relatorio.filter(r => r.cand && r.cand.porque.length >= 2).length;
    const semNada = relatorio.length - comCand;
    console.log(`\namostra: ${sel.length} lançamentos`);
    console.log(`  com candidato parecido nas pastas ... ${comCand}`);
    console.log(`    destes, batendo em 2+ campos ...... ${forte}  <- provável erro do motor`);
    console.log(`  sem nenhum candidato ................ ${semNada}  <- provável nota não arquivada`);
    console.log(`\ngerados:\n  ${saidaCsv}\n  ${saidaTxt}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
