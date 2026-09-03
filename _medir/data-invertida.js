/**
 * _medir/data-invertida.js — nome do arquivo com dia/mês trocado.
 *
 * Achado na auditoria de 02/2026: o documento
 *
 *   .../2026.02.EXTRATOS CONTABILIDADE/SANTANDER/2026.02.09/
 *       045.DOC- 1824,00-2026.09.02.ARPSEG . RC 902308+ AUT.pdf
 *
 * está FISICAMENTE na pasta de fevereiro (dia 09), mas o nome traz "2026.09.02".
 * `mesDoNome` tem precedência sobre `mesDaPasta` em contarNaPasta, então o
 * documento é indexado em SETEMBRO — 7 meses fora da janela, e o lançamento de
 * fevereiro aparece como "sem documento" com o papel na pasta certa.
 *
 * Mede quantos arquivos têm essa contradição entre nome e pasta.
 */
'use strict';
const h = require('./harness');

(async () => {
    const rota = h.internasDaRota();
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    const r = rota.contarNaPasta(raiz);

    let total = 0, divergentes = 0, semPasta = 0;
    const casos = [];
    for (const [mesIndexado, arqs] of Object.entries(r.arquivosPorMes)) {
        for (const a of arqs) {
            total++;
            const mesN = rota.mesDoNome(a.nome);
            const mesP = rota.mesDaPasta(a.rel);
            if (!mesP) { semPasta++; continue; }
            if (mesN && mesN !== mesP) {
                divergentes++;
                // Dia/mês trocado: o mês do nome é o DIA da pasta e vice-versa?
                const mn = mesN.split('.')[0], mp = mesP.split('.')[0];
                const dia = (a.rel.match(/(\d{2})(?:[\/\\]|$)/) || [])[1];
                const diaNome = (a.nome.match(/20\d{2}\.(\d{2})\.(\d{2})/) || [])[2];
                const trocado = dia && diaNome && mn === dia && mp === diaNome;
                casos.push({ nome: a.nome, rel: a.rel, mesN, mesP, indexado: mesIndexado, trocado });
            }
        }
    }

    console.log('=== NOME DO ARQUIVO × PASTA ONDE ESTÁ ===\n');
    console.log(`  arquivos fiscais indexados ......... ${total}`);
    console.log(`  sem data na pasta .................. ${semPasta}`);
    console.log(`  **mês do nome ≠ mês da pasta** ..... ${divergentes}`);
    const trocados = casos.filter(c => c.trocado).length;
    console.log(`  ...destes, com dia/mês TROCADO ..... ${trocados}`);

    // Distribuição da distância — o que está longe é o que dói.
    const dist = m => { const [a, b] = m.split('.').map(Number); return b * 12 + a; };
    const porDist = {};
    for (const c of casos) {
        const d = dist(c.mesN) - dist(c.mesP);
        porDist[d] = (porDist[d] || 0) + 1;
    }
    console.log('\n  distância (mês do nome − mês da pasta):');
    for (const [d, n] of Object.entries(porDist).sort((a, b) => Number(a[0]) - Number(b[0])))
        console.log(`    ${String(d).padStart(4)} meses: ${n}${Math.abs(Number(d)) > 3 ? '   <- fora de qualquer janela' : ''}`);

    console.log('\n  exemplos com dia/mês trocado:');
    for (const c of casos.filter(x => x.trocado).slice(0, 15))
        console.log(`    ${c.nome.slice(0, 66)}\n       pasta ${c.mesP} · indexado em ${c.indexado}`);

    console.log('\n  exemplos de outras divergências:');
    for (const c of casos.filter(x => !x.trocado).slice(0, 10))
        console.log(`    ${c.nome.slice(0, 66)}\n       pasta ${c.mesP} · indexado em ${c.indexado}`);

    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
