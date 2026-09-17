/**
 * _medir/_conferir-planilha.js — responde a pergunta do painel ("os lançamentos da
 * planilha estão na pasta?") COM o banco no circuito, por período.
 *
 * Diferente de `baseline.js`, que pareia só pelo nome do arquivo: aqui cada
 * documento passa por `enriquecerComOcr`, então o que foi GRAVADO pelas releituras
 * entra na conta. Sem isso o documento fica sem data/número e o veto de janela some
 * — ver [[armadilha-medir-sem-ocr]].
 *
 * Reporta por CONTAGEM e por VALOR, porque a decisão do painel é por valor:
 * R$ 12,10 de pedágio e R$ 21 mil de nota de serviço não pesam igual.
 *
 * Uso: node _medir/_conferir-planilha.js [MM.AAAA ...]   (sem args = os 6 períodos)
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

const BRL = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();

    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};
    console.log(`índice de OCR: ${Object.keys(idx).length} arquivos com dados do banco\n`);

    const periodos = process.argv.slice(2).filter(a => /^\d{2}\.\d{4}$/.test(a));
    const alvos = periodos.length ? periodos : h.PERIODOS;

    console.log('período   lanç   conf   semDoc   %conf    valor total       valor sem doc     %valor');
    const tot = { l: 0, c: 0, s: 0, vt: 0, vs: 0 };

    for (const periodo of alvos) {
        const pl = c.planilha[periodo] || { itens: [] };
        const lancamentos = (pl.itens || []).map(par.lancamentoDaPlanilha);

        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancamentos, documentosPorMes, periodo);

        const casados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.lancamento));
        const conf = casados.size;
        const semDoc = lancamentos.length - conf;
        const vTotal = lancamentos.reduce((s, l) => s + (l.valor || 0), 0);
        const vSem = lancamentos.filter(l => !casados.has(l)).reduce((s, l) => s + (l.valor || 0), 0);

        tot.l += lancamentos.length; tot.c += conf; tot.s += semDoc; tot.vt += vTotal; tot.vs += vSem;

        console.log(
            `${periodo}  ${String(lancamentos.length).padStart(4)}  ${String(conf).padStart(5)}` +
            `  ${String(semDoc).padStart(6)}  ${(conf * 100 / (lancamentos.length || 1)).toFixed(1).padStart(6)}%` +
            `  ${BRL(vTotal).padStart(16)}  ${BRL(vSem).padStart(16)}  ${(vSem * 100 / (vTotal || 1)).toFixed(1).padStart(5)}%`);
    }

    console.log('\nTOTAL');
    console.log(`  lançamentos ........ ${tot.l}`);
    console.log(`  com documento ...... ${tot.c}  (${(tot.c * 100 / (tot.l || 1)).toFixed(1)}%)`);
    console.log(`  SEM documento ...... ${tot.s}`);
    console.log(`  valor lançado ...... ${BRL(tot.vt)}`);
    console.log(`  valor SEM documento  ${BRL(tot.vs)}  (${(tot.vs * 100 / (tot.vt || 1)).toFixed(1)}% do valor)`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
