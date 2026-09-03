/**
 * _medir/verificar.js — roda o caminho DE PRODUÇÃO (routes/_pareamento.js +
 * camposOcr de routes/comparar-notas.js), não a reimplementação de variantes.js.
 *
 * É o teste que importa: confirma que o número medido é o número que a tela vai
 * mostrar, e não um resultado que só existe no harness.
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();

    // Índice do OCR pelo MESMO código que a rota usa (contarNoCsv → ocrPorArquivo).
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const b = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO));
    const idx = b.ocrPorArquivo || {};
    console.log(`índice OCR (código de produção): ${Object.keys(idx).length} arquivos\n`);

    let tot = { lanc: 0, conf: 0, sem: 0, fracos: 0 };
    console.log('período   lanç  confer  semDoc  fracos');
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
        const conf = r.pares.length + r.paresVizinhos.length;
        console.log(`${periodo}  ${String(lancamentos.length).padStart(4)}  ${String(conf).padStart(6)}` +
            `  ${String(r.lancamentosSemDocumento).padStart(6)}  ${String(r.fracos).padStart(6)}`);
        tot.lanc += lancamentos.length; tot.conf += conf;
        tot.sem += r.lancamentosSemDocumento; tot.fracos += r.fracos;
    }
    console.log(`\nTOTAL  lançamentos ${tot.lanc}  conferidos ${tot.conf}` +
        ` (${(tot.conf / tot.lanc * 100).toFixed(1)}%)  semDoc ${tot.sem}  fracos ${tot.fracos}`);
    // Atualizado em 03/09/2026 com a janela [-1,+1,+2,+3] (§14). O valor anterior
    // (1982/1121/177) era de §12, antes do piso de 2 dígitos e da janela nova.
    console.log('\nEsperado da medição: conferidos 2068, semDoc 989, fracos 176');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
