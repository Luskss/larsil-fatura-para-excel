/**
 * _medir/relatorio-b.js — o grupo (b): número E valor batem, fornecedor não.
 *
 * Mede três coisas:
 *   1. tamanho do grupo (b) nos 6 períodos, sob a janela nova [-1,+1,+2,+3];
 *   2. a coluna FANTASIA resolveria? (ela já está em uso — quantos ela salva?)
 *   3. e se (número E valor) fosse caminho próprio, sem exigir fornecedor?
 *      Medido com o critério de sempre: cobertura sobe E 2º campo não cai.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const par = require('../routes/_pareamento');
const v = require('./variantes');
const ocrMod = require('./ocr');

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    // ── 1. Levantar o grupo (b) em todos os períodos ────────────────────────
    const casos = [];
    for (const periodo of h.PERIODOS) {
        const itensBrutos = (c.planilha[periodo] || { itens: [] }).itens || [];
        const lancamentos = itensBrutos.map(par.lancamentoDaPlanilha);
        // Guarda o item bruto junto, para poder olhar FANTASIA depois.
        const brutoDe = new Map();
        lancamentos.forEach((l, i) => brutoDe.set(l, itensBrutos[i]));

        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const usados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.documento.arquivo));

        // Universo: todos os PDFs de todos os meses (busca mais frouxa que o motor).
        const todos = [];
        for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes))
            for (const a of arqs)
                todos.push({ mes, ...par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]) });

        for (const l of r.semDocumento) {
            for (const d of todos) {
                const vB = d.valor != null && l.valor > 0 && Math.abs(l.valor - d.valor) < 0.005;
                const nB = par.numeroBate(l, d);
                const eB = par.entidadeBate(l, d);
                // O grupo (b) é exatamente: valor E número, SEM fornecedor.
                if (vB && nB && !eB) {
                    casos.push({ periodo, l, d, bruto: brutoDe.get(l), jaUsado: usados.has(d.arquivo) });
                    break;
                }
            }
        }
    }

    console.log('=== GRUPO (B): número E valor batem, fornecedor não ===\n');
    const porPeriodo = {};
    for (const k of casos) porPeriodo[k.periodo] = (porPeriodo[k.periodo] || 0) + 1;
    for (const p of h.PERIODOS) console.log(`  ${p}  ${porPeriodo[p] || 0}`);
    console.log(`  TOTAL ${casos.length}`);
    const disputados = casos.filter(k => k.jaUsado).length;
    console.log(`  destes, com documento já usado por outro lançamento: ${disputados}`);

    // ── 2. A FANTASIA resolveria? ───────────────────────────────────────────
    console.log('\n=== A COLUNA FANTASIA RESOLVE ESSES CASOS? ===\n');
    let fantVazia = 0, fantIgual = 0, fantNaoAjuda = 0, fantAjudaria = 0;
    const exemplos = [];
    for (const k of casos) {
        const fant = String(k.bruto?.fantasia || '').trim();
        const ent = String(k.bruto?.entidade || '').trim();
        if (!fant) { fantVazia++; continue; }
        if (fant.toUpperCase() === ent.toUpperCase()) { fantIgual++; continue; }
        // A fantasia JÁ está nos tokens do lançamento. Se mesmo assim entidadeBate
        // deu false, ela não contém o nome do arquivo. Confirmação direta:
        const tokFant = par.tokens(fant);
        const casaPelaFantasia = [...tokFant].some(t => k.d.tokens.has(t));
        if (casaPelaFantasia) fantAjudaria++; else fantNaoAjuda++;
        if (exemplos.length < 20)
            exemplos.push(`  ${ent.slice(0, 38).padEnd(38)} fant "${fant.slice(0, 26)}"\n` +
                          `     arq: ${k.d.arquivo.slice(0, 74)}`);
    }
    console.log(`  FANTASIA vazia ......................... ${fantVazia}`);
    console.log(`  FANTASIA idêntica à ENTIDADE ........... ${fantIgual}`);
    console.log(`  FANTASIA diferente, mas NÃO casa ....... ${fantNaoAjuda}`);
    console.log(`  FANTASIA casaria (bug: já está em uso) . ${fantAjudaria}`);
    console.log('\n  exemplos:\n' + exemplos.join('\n'));

    // ── 3. Variante: (número E valor) como caminho próprio ──────────────────
    console.log('\n\n=== VARIANTE: aceitar (número E valor) sem exigir fornecedor ===\n');
    const idxOcr = await ocrMod.indexar();
    const VARS = [
        ['produção (nº E ent) OU valor', {}],
        ['+ (nº E valor) como 3º caminho', { numeroEValor: true }],
    ];
    const res = [];
    for (const [nome, extra] of VARS) {
        const linhas = v.rodar(c, idxOcr, { ocr: true, minDigitosNum: 2,
            vizinhanca: par.VIZINHANCA, ...extra });
        res.push({ nome, s: v.resumir(linhas), q: v.qualidade(linhas) });
    }
    console.log('variante                          confer   cob%   semDoc  2ºcampo  contrad');
    for (const r of res)
        console.log(`${r.nome.padEnd(33)} ${String(r.s.conferidos).padStart(5)}` +
            ` ${(r.s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(r.s.semDocumento).padStart(7)}` +
            ` ${(r.q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(r.q.contraditos).padStart(7)}`);

    // Lista completa para conferência humana.
    const linhas = casos.map(k =>
        `${k.periodo} · ${k.bruto?.entidade || '?'} · NF ${k.l.nf} · R$ ${k.l.valor}\n` +
        `   fant: ${k.bruto?.fantasia || '(vazia)'}\n` +
        `   arq : ${k.d.arquivo}  [pasta ${k.d.mes}]${k.jaUsado ? '  JÁ USADO' : ''}`);
    fs.writeFileSync(path.join(__dirname, 'grupo-b.txt'), linhas.join('\n\n'));
    console.log(`\n[lista completa dos ${casos.length} casos em _medir/grupo-b.txt]`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
