/**
 * _medir/_investigar-marco.js — por que 43,9% do VALOR de 03.2026 não acha documento,
 * se a pasta está 933/933 lida?
 *
 * Não é falta de leitura, então a causa está no casamento. As hipóteses que este
 * script separa, em ordem de custo para o usuário:
 *   A. concentração — poucos lançamentos gigantes respondem pelo grosso do valor;
 *   B. a conta/origem do lançamento é do tipo que NÃO tem nota de fornecedor
 *      (folha, tributo, transferência) — não é defeito, é escopo;
 *   C. existe documento com aquele valor na pasta, mas o motor recusou o par —
 *      aí sim é do motor, e o diagnóstico diz qual regra vetou.
 *
 * Uso: node _medir/_investigar-marco.js [MM.AAAA] [--n 40]
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

const PERIODO = process.argv.find(a => /^\d{2}\.\d{4}$/.test(a)) || '03.2026';
const iN = process.argv.indexOf('--n');
const N = iN >= 0 ? parseInt(process.argv[iN + 1], 10) : 30;

const BRL = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
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
    const casados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.lancamento));
    const sem = lancamentos.filter(l => !casados.has(l)).sort((a, b) => (b.valor || 0) - (a.valor || 0));
    const vSem = sem.reduce((s, l) => s + (l.valor || 0), 0);

    console.log(`=== ${PERIODO}: ${sem.length} lançamentos sem documento, ${BRL(vSem)} ===\n`);

    // ── A. concentração ──────────────────────────────────────────────────────
    let acc = 0, i = 0;
    for (const l of sem) { acc += l.valor || 0; i++; if (acc >= vSem * 0.5) break; }
    console.log(`CONCENTRAÇÃO: os ${i} maiores (de ${sem.length}) somam metade do valor`);
    const acima100k = sem.filter(l => (l.valor || 0) >= 100000);
    const abaixo1k = sem.filter(l => (l.valor || 0) < 1000);
    console.log(`  >= R$ 100 mil: ${acima100k.length} lançamentos, ${BRL(acima100k.reduce((s, l) => s + l.valor, 0))}`);
    console.log(`  <  R$ 1 mil  : ${abaixo1k.length} lançamentos, ${BRL(abaixo1k.reduce((s, l) => s + l.valor, 0))}`);

    // ── B. por conta / origem ────────────────────────────────────────────────
    const porChave = (campo) => {
        const m = new Map();
        for (const l of sem) {
            const k = String((l.bruto && (l.bruto[campo] ?? l.bruto[campo.toUpperCase()])) ?? l[campo] ?? '(vazio)').trim() || '(vazio)';
            const o = m.get(k) || { n: 0, v: 0 };
            o.n++; o.v += l.valor || 0; m.set(k, o);
        }
        return [...m].sort((a, b) => b[1].v - a[1].v);
    };

    // Descobre os campos disponíveis num lançamento, para não chutar nome de coluna.
    const amostra = sem[0];
    console.log(`\nCAMPOS de um lançamento: ${Object.keys(amostra || {}).join(', ')}`);
    if (amostra && amostra.bruto) console.log(`CAMPOS do bruto: ${Object.keys(amostra.bruto).join(', ')}`);

    for (const campo of ['historico', 'origem', 'conta', 'entidade', 'filial']) {
        const linhas = porChave(campo);
        if (linhas.length <= 1 && linhas[0] && linhas[0][0] === '(vazio)') continue;
        console.log(`\n── por ${campo} (top 8 por valor) ──`);
        for (const [k, o] of linhas.slice(0, 8))
            console.log(`  ${BRL(o.v).padStart(16)}  ${String(o.n).padStart(4)}x  ${k.slice(0, 60)}`);
    }

    // ── C. existe documento com esse valor na pasta? ─────────────────────────
    const todosDocs = Object.values(documentosPorMes).flat();
    const usados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.documento.arquivo));
    const livres = todosDocs.filter(d => !usados.has(d.arquivo));
    const cent = (v) => Math.round((v || 0) * 100);
    const porValor = new Map();
    for (const d of livres) {
        for (const v of [d.valor, d.valorDoNome].filter(x => x != null)) {
            const k = cent(v);
            if (!porValor.has(k)) porValor.set(k, []);
            porValor.get(k).push(d);
        }
    }
    let comCandidato = 0, valorComCandidato = 0;
    for (const l of sem) {
        if (porValor.has(cent(l.valor))) { comCandidato++; valorComCandidato += l.valor || 0; }
    }
    console.log(`\n── C. existe documento LIVRE com o mesmo valor? ──`);
    console.log(`  ${comCandidato} de ${sem.length} lançamentos têm candidato por valor exato`);
    console.log(`  valor envolvido: ${BRL(valorComCandidato)}  (${(valorComCandidato * 100 / (vSem || 1)).toFixed(1)}% do buraco)`);
    console.log(`  documentos livres na vizinhança: ${livres.length} de ${todosDocs.length}`);

    console.log(`\n── os ${N} maiores sem documento ──`);
    for (const l of sem.slice(0, N)) {
        const cand = porValor.get(cent(l.valor));
        const marca = cand ? `  <-- ${cand.length} doc(s) com esse valor: ${cand[0].arquivo.slice(0, 44)}` : '';
        const desc = (l.historico || (l.bruto && (l.bruto.HISTORICO || l.bruto.Historico)) || '').toString().slice(0, 46);
        console.log(`  ${BRL(l.valor).padStart(16)}  ${String(l.data || '').slice(0, 10).padEnd(11)} ${desc}${marca}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
