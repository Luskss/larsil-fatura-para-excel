/**
 * _medir/diagnostico.js — pergunta ao motor, par a par, POR QUE recusou.
 *
 * A amostra mostrou casos com fornecedor + valor + NF concordando que mesmo assim
 * ficaram em "sem documento" (G CORPORI NF 60 R$1.720,00 × 053.DOC-...CORPORI.NF 60).
 * A regra diz que (número E entidade) casa sem olhar data — então ou o número não
 * está batendo como parece, ou o documento foi consumido por OUTRO lançamento.
 *
 * Este script separa as duas causas, que pedem correções opostas:
 *   REGRA    — `casa()` devolve null: algum sinal não bate de verdade
 *   DISPUTA  — `casa()` casaria, mas o documento foi levado por outro lançamento
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

const fmt = v => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const dia = t => t == null ? '?' : new Date(t).toISOString().slice(0, 10);

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    const causas = { regra: 0, disputa: 0, semCandidato: 0 };
    const detalhes = { regra: [], disputa: [] };

    for (const periodo of h.PERIODOS) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        const todosPares = [...r.pares, ...r.paresVizinhos];
        const casados = new Set(todosPares.map(p => p.lancamento));
        // Documento → lançamento que o levou, para identificar disputa.
        const donoDoDoc = new Map();
        for (const p of todosPares) donoDoDoc.set(p.documento.arquivo, p.lancamento);
        const docs = Object.values(documentosPorMes).flat();

        for (const l of lancamentos) {
            if (casados.has(l)) continue;

            // Candidatos "óbvios": fornecedor bate E (número ou valor) bate.
            const obvios = docs.filter(d =>
                par.entidadeBate(l, d) && (par.numeroBate(l, d) || par.valorBate(l, d)));
            if (!obvios.length) { causas.semCandidato++; continue; }

            // Entre os óbvios, algum que a REGRA aceitaria?
            const aceitos = obvios.filter(d => par.casa(l, d) != null);
            if (aceitos.length) {
                // A regra casaria — então perdeu a disputa pelo documento.
                causas.disputa++;
                const d = aceitos[0];
                if (detalhes.disputa.length < 40) {
                    detalhes.disputa.push({ periodo, l, d, dono: donoDoDoc.get(d.arquivo) });
                }
            } else {
                // A regra recusou todos. Guardar por que, sinal a sinal.
                causas.regra++;
                const d = obvios[0];
                if (detalhes.regra.length < 40) {
                    detalhes.regra.push({
                        periodo, l, d,
                        num: par.numeroBate(l, d),
                        val: par.valorBate(l, d),
                        ent: par.entidadeBate(l, d),
                        dist: par.distanciaDias(l, d),
                    });
                }
            }
        }
    }

    console.log('CAUSA DE NÃO CASAR (só os que têm candidato óbvio na pasta)');
    console.log(`  regra recusou ...................... ${causas.regra}`);
    console.log(`  perdeu a disputa pelo documento .... ${causas.disputa}`);
    console.log(`  sem candidato óbvio ................ ${causas.semCandidato}`);

    console.log('\n=== REGRA RECUSOU (amostra) ===');
    for (const x of detalhes.regra.slice(0, 12)) {
        console.log(`\n${x.l.entidade.slice(0, 44)}  NF ${x.l.nf}  R$ ${fmt(x.l.valor)}`);
        console.log(`  doc: ${x.d.arquivo.slice(0, 68)}`);
        console.log(`       numero=${x.num} valor=${x.val} entidade=${x.ent}` +
            ` dist=${x.dist == null ? 'sem data' : Math.round(x.dist) + 'd'}`);
        console.log(`       nfPlanilha=${x.l.nfDig} numDoc=${x.d.numeroDig || '-'}` +
            ` alt=${x.d.numeroAlt || '-'} | valPlan=${fmt(x.l.valor)} valDoc=${x.d.valor == null ? '-' : fmt(x.d.valor)}`);
    }

    console.log('\n=== PERDEU A DISPUTA (amostra) ===');
    for (const x of detalhes.disputa.slice(0, 12)) {
        console.log(`\n${x.l.entidade.slice(0, 44)}  NF ${x.l.nf}  R$ ${fmt(x.l.valor)}`);
        console.log(`  queria: ${x.d.arquivo.slice(0, 66)}`);
        console.log(`  levou : ${x.dono ? x.dono.entidade.slice(0, 40) + ' NF ' + x.dono.nf + ' R$ ' + fmt(x.dono.valor) : '?'}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
