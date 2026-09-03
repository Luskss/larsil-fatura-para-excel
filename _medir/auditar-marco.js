/**
 * _medir/auditar-marco.js — os 248 "sem documento" de 03/2026 são reais?
 *
 * Para cada lançamento que o motor declarou sem papel, varre TODOS os PDFs do
 * arquivo permanente (todos os meses, não só a janela [-1,+1,+2]) procurando um
 * candidato que uma pessoa casaria de olho:
 *
 *   valor exato no nome do arquivo  |  número da NF  |  tokens do fornecedor
 *
 * A busca é deliberadamente MAIS FROUXA que a do motor. Se ela não acha nada, o
 * lançamento está mesmo sem documento arquivado. Se acha, é falha de pareamento
 * e o caso é impresso com o porquê.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const par = require('../routes/_pareamento');

const PERIODO = process.argv[2] || '03.2026';

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();

    // Índice do OCR pelo mesmo caminho da produção.
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    const pl = c.planilha[PERIODO] || { itens: [] };
    const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);

    const documentosPorMes = {};
    for (const off of [0, ...par.VIZINHANCA]) {
        const alvo = par.deslocarPeriodo(PERIODO, off);
        documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
            par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
    }
    const r = par.conferirPeriodo(lancamentos, documentosPorMes, PERIODO);

    console.log(`=== ${PERIODO} ===`);
    console.log(`lançamentos que deveriam ter documento: ${lancamentos.length}`);
    console.log(`  com documento nesta pasta ..... ${r.pares.length}`);
    console.log(`  com documento em pasta vizinha  ${r.paresVizinhos.length}`);
    console.log(`  SEM DOCUMENTO ................. ${r.lancamentosSemDocumento}`);
    console.log(`  (fracos, só por valor) ........ ${r.fracos}`);

    // ── Universo de busca: TODOS os PDFs de TODOS os meses do arquivo ───────
    const todos = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes))
        for (const a of arqs)
            todos.push({ mes, ...par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]) });
    console.log(`\nuniverso de busca: ${todos.length} PDFs em ${Object.keys(c.pasta.arquivosPorMes).length} meses\n`);

    // Documentos já consumidos por outro lançamento (para saber se é disputa).
    const consumidos = new Set([...r.pares, ...r.paresVizinhos].map(p => p.documento.arquivo));

    const achados = [];
    for (const l of r.semDocumento) {
        const cands = [];
        for (const d of todos) {
            const vBate = l.valor != null && d.valor != null &&
                Math.abs(l.valor - d.valor) < 0.005;
            const nBate = par.numeroBate(l, d);
            const eBate = par.entidadeBate(l, d);
            const forca = (vBate ? 1 : 0) + (nBate ? 1 : 0) + (eBate ? 1 : 0);
            if (forca >= 2) cands.push({ d, vBate, nBate, eBate, forca });
        }
        if (!cands.length) continue;
        cands.sort((a, b) => b.forca - a.forca);
        achados.push({ l, cands });
    }

    console.log(`dos ${r.lancamentosSemDocumento} sem documento, ${achados.length} têm candidato`);
    console.log(`com 2+ sinais concordando na pasta inteira\n`);

    const fmt = v => v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    achados.sort((a, b) => (b.l.valor || 0) - (a.l.valor || 0));

    const linhas = [];
    for (const { l, cands } of achados) {
        const top = cands[0];
        const sinais = [top.vBate && 'valor', top.nBate && 'número', top.eBate && 'fornecedor']
            .filter(Boolean).join('+');
        const disputa = consumidos.has(top.d.arquivo) ? ' [doc JÁ USADO por outro lançamento]' : '';
        linhas.push(
            `${l.entidade} · NF ${l.nf || "—"} · R$ ${fmt(l.valor)} · lanç. ${l.dtLancamento || "—"}\n` +
            `   cand: ${top.d.arquivo}\n` +
            `   pasta ${top.d.mes} · sinais: ${sinais} (força ${top.forca})${disputa}` +
            (cands.length > 1 ? ` · +${cands.length - 1} outros` : ''));
    }
    const txt = linhas.join('\n\n');
    fs.writeFileSync(path.join(__dirname, `auditoria-${PERIODO}.txt`), txt);
    console.log(txt.slice(0, 6000));
    console.log(`\n\n[lista completa em _medir/auditoria-marco.txt]`);

    // Distribuição dos candidatos por mês da pasta — mostra se a janela é o problema.
    const porMes = {};
    for (const { cands } of achados) {
        const m = cands[0].d.mes;
        porMes[m] = (porMes[m] || 0) + 1;
    }
    console.log('\ncandidatos por mês da pasta (a janela cobre 02,03,04,05):');
    for (const [m, n] of Object.entries(porMes).sort((a, b) => b[1] - a[1]))
        console.log(`  ${m}  ${n}`);

    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
