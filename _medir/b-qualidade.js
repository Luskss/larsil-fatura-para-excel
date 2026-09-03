/**
 * _medir/b-qualidade.js — os 27 pares que (número E valor) acrescenta são bons?
 *
 * Estabilidade sob embaralhamento + o que exatamente muda entre as duas variantes
 * (pares ganhos, pares perdidos, pares que trocaram de documento).
 */
'use strict';
const h = require('./harness');
const v = require('./variantes');
const ocrMod = require('./ocr');

function embaralhar(a, semente) {
    const r = a.slice();
    let s = semente;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
}

(async () => {
    const c = h.carregar();
    const idx = await ocrMod.indexar();
    const OPT = { ocr: true, minDigitosNum: 2 };

    // ── Estabilidade ────────────────────────────────────────────────────────
    console.log('=== ESTABILIDADE SOB EMBARALHAMENTO ===\n');
    for (const semente of [1, 7, 42, 99]) {
        const baralhado = { ...c, planilha: {}, pasta: { arquivosPorMes: {} } };
        for (const [m, o] of Object.entries(c.planilha))
            baralhado.planilha[m] = { ...o, itens: embaralhar(o.itens || [], semente) };
        for (const [m, a] of Object.entries(c.pasta.arquivosPorMes))
            baralhado.pasta.arquivosPorMes[m] = embaralhar(a, semente + 1);
        const s = v.resumir(v.rodar(baralhado, idx, { ...OPT, numeroEValor: true }));
        console.log(`  semente ${String(semente).padStart(3)}: ${s.conferidos} pares`);
    }

    // ── O que muda, par a par ───────────────────────────────────────────────
    const base = v.rodar(c, idx, OPT);
    const nova = v.rodar(c, idx, { ...OPT, numeroEValor: true });

    const mapa = linhas => {
        const m = new Map();
        for (const L of linhas)
            for (const p of (L.pares || []))
                m.set(`${L.periodo}|${p.lancamento.nf}|${p.lancamento.entidade}|${p.lancamento.valor}`,
                      p.documento.arquivo);
        return m;
    };
    const mb = mapa(base), mn = mapa(nova);

    let ganhos = 0, perdas = 0, trocas = 0;
    const exTroca = [];
    for (const [k, arq] of mn) {
        if (!mb.has(k)) ganhos++;
        else if (mb.get(k) !== arq) { trocas++; if (exTroca.length < 8) exTroca.push(`  ${k}\n     ${mb.get(k)}\n  -> ${arq}`); }
    }
    for (const k of mb.keys()) if (!mn.has(k)) perdas++;

    console.log('\n=== O QUE MUDA ===\n');
    console.log(`  pares ganhos ... ${ganhos}`);
    console.log(`  pares perdidos . ${perdas}`);
    console.log(`  trocaram doc ... ${trocas}`);
    if (exTroca.length) console.log('\n  trocas:\n' + exTroca.join('\n'));

    // ── Via de casamento ────────────────────────────────────────────────────
    console.log('\n=== POR VIA ===\n');
    for (const [nome, linhas] of [['produção', base], ['+ (nº E valor)', nova]]) {
        const s = v.resumir(linhas);
        console.log(`${nome}\n   ` + Object.entries(s.porVia).sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${k}=${n}`).join('  '));
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
