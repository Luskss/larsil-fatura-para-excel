/**
 * _medir/teto.js — onde está o teto? os 999 "sem documento" que restam.
 *
 * O diagnóstico pós-§17 diz: 22 recusas da regra, 1 disputa, e 976 "sem candidato
 * óbvio". As variantes (A)/(B) que atacam as 22 rendem +1 a +3 pares — marginal.
 *
 * Então a pergunta certa não é "que regra falta", é: **existe documento na pasta
 * para esses 976?** Este script mede o teto estrutural — quantos lançamentos ainda
 * poderiam casar se a regra fosse perfeita, contra quantos simplesmente não têm
 * papel arquivado.
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');

const fmt = v => (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
    const c = h.carregar();
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const idx = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO)).ocrPorArquivo || {};

    // Universo: TODOS os PDFs de TODOS os meses (busca mais frouxa que o motor).
    const todos = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes))
        for (const a of arqs)
            todos.push({ mes, ...par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]) });

    let semDoc = 0, comAlgumSinal = 0, comDoisSinais = 0, semNada = 0;
    let livres = 0, disputados = 0;
    const porValor = { ate100: 0, ate1k: 0, acima1k: 0 };
    let valorSemNada = 0;

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(par.lancamentoDaPlanilha);
        const documentosPorMes = {};
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            documentosPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = par.conferirPeriodo(lancs, documentosPorMes, periodo);
        const usados = new Set([...r.pares, ...r.paresVizinhos].map(p => p.documento.arquivo));

        for (const l of r.semDocumento) {
            semDoc++;
            let melhor = 0, melhorLivre = false;
            for (const d of todos) {
                const f = (par.valorBate(l, d) ? 1 : 0) + (par.numeroBate(l, d) ? 1 : 0)
                        + (par.entidadeBate(l, d) ? 1 : 0);
                if (f > melhor) { melhor = f; melhorLivre = !usados.has(d.arquivo); }
            }
            if (melhor >= 2) { comDoisSinais++; melhorLivre ? livres++ : disputados++; }
            else if (melhor === 1) comAlgumSinal++;
            else {
                semNada++;
                valorSemNada += l.valor || 0;
                if (l.valor < 100) porValor.ate100++;
                else if (l.valor < 1000) porValor.ate1k++;
                else porValor.acima1k++;
            }
        }
    }

    console.log('=== OS 999 "SEM DOCUMENTO" — TEM PAPEL NA PASTA? ===\n');
    console.log(`  total sem documento ...................... ${semDoc}`);
    console.log(`  com 2+ sinais em algum PDF do arquivo .... ${comDoisSinais}  (${(comDoisSinais / semDoc * 100).toFixed(1)}%)`);
    console.log(`     ...documento livre .................... ${livres}`);
    console.log(`     ...documento já usado por outro ....... ${disputados}`);
    console.log(`  com 1 sinal só (fraco demais) ............ ${comAlgumSinal}`);
    console.log(`  **NENHUM sinal em 4.238 PDFs** ........... ${semNada}  (${(semNada / semDoc * 100).toFixed(1)}%)`);

    console.log('\n  os "nenhum sinal", por valor:');
    console.log(`    abaixo de R$ 100 .... ${porValor.ate100}`);
    console.log(`    R$ 100 a R$ 1.000 ... ${porValor.ate1k}`);
    console.log(`    acima de R$ 1.000 ... ${porValor.acima1k}`);
    console.log(`    valor total ......... R$ ${fmt(valorSemNada)}`);

    console.log('\n  Leitura: o que tem "nenhum sinal" não é falha de regra — é papel');
    console.log('  que não está no arquivo. Nenhuma mudança no motor recupera isso.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
