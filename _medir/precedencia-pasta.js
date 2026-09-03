/**
 * _medir/precedencia-pasta.js — quem decide o mês do documento: o NOME ou a PASTA?
 *
 * Hoje: `mesDoNome(e.name) || mesDaPasta(rel)` — o nome ganha.
 * Medido: 144 dos 4.238 arquivos têm nome e pasta discordando, e 37 deles a mais
 * de 3 meses de distância — fora de qualquer janela, invisíveis para o pareamento.
 *
 * A pasta é evidência mais forte: ela é criada pelo processo de arquivamento
 * (`.../2026.02.EXTRATOS CONTABILIDADE/SANTANDER/2026.02.09/`), enquanto o nome é
 * digitado à mão pelo arquivista — a mesma fonte de erro que §12 mediu no emitente.
 *
 * Critério de aceitação, como sempre: cobertura sobe E 2º campo não cai.
 */
'use strict';
const h = require('./harness');
const v = require('./variantes');
const ocrMod = require('./ocr');

(async () => {
    const rota = h.internasDaRota();
    const c = h.carregar();
    const idx = await ocrMod.indexar();

    // Reindexa a pasta com a precedência invertida, sem tocar em contarNaPasta.
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    const r = rota.contarNaPasta(raiz);
    const porPasta = {};
    let movidos = 0;
    for (const arqs of Object.values(r.arquivosPorMes)) {
        for (const a of arqs) {
            const mes = rota.mesDaPasta(a.rel) || rota.mesDoNome(a.nome);
            if (!mes) continue;
            (porPasta[mes] || (porPasta[mes] = [])).push(a);
            if (mes !== (rota.mesDoNome(a.nome) || rota.mesDaPasta(a.rel))) movidos++;
        }
    }
    console.log(`arquivos reindexados para outro mês: ${movidos}\n`);

    const cPasta = { ...c, pasta: { ...c.pasta, arquivosPorMes: porPasta } };
    const OPT = { ocr: true, minDigitosNum: 2 };

    const casos = [
        ['nome tem precedência (produção)', c,      OPT],
        ['PASTA tem precedência',           cPasta, OPT],
        ['nome + (nº E valor)',             c,      { ...OPT, numeroEValor: true }],
        ['PASTA + (nº E valor)',            cPasta, { ...OPT, numeroEValor: true }],
    ];

    console.log('variante                          confer   cob%   semDoc  2ºcampo  contrad');
    const res = [];
    for (const [nome, dados, opt] of casos) {
        const linhas = v.rodar(dados, idx, opt);
        const s = v.resumir(linhas), q = v.qualidade(linhas);
        res.push({ nome, s, q, linhas });
        console.log(`${nome.padEnd(33)} ${String(s.conferidos).padStart(5)}` +
            ` ${(s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(s.semDocumento).padStart(7)}` +
            ` ${(q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(q.contraditos).padStart(7)}`);
    }

    console.log('\n── por período (conferidos / semDoc) ──');
    console.log('período   ' + res.map((r, i) => `var${i + 1}`.padStart(13)).join(''));
    for (const p of h.PERIODOS) {
        const cels = res.map(r => {
            const l = r.linhas.find(x => x.periodo === p);
            return `${l.conferidos}/${l.semDocumento}`.padStart(13);
        });
        console.log(`${p}  ${cels.join('')}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
