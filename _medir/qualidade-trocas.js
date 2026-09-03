/**
 * _medir/qualidade-trocas.js — as 50 trocas da inversão são melhora ou piora?
 *
 * "−1 par" não decide nada: a inversão troca 50 documentos de dono, e o que importa
 * é se o documento NOVO é mais parecido com o lançamento que o ANTIGO.
 *
 * Critério objetivo, sem opinião: para cada troca, conta quantos dos três sinais
 * (número, valor, entidade) o lançamento tem em comum com o documento antigo e com
 * o novo, usando o NÚMERO REAL DO NOME DO ARQUIVO como árbitro — o texto que o
 * arquivista leu do papel, independente de qual fonte o motor usou para casar.
 */
'use strict';
const h = require('./harness');
const par = require('../routes/_pareamento');
const v = require('./variantes');
const ocrMod = require('./ocr');

const soDig = s => String(s || '').replace(/\D/g, '');

(async () => {
    const c = h.carregar();
    const idx = await ocrMod.indexar();
    const OPT = { ocr: true, minDigitosNum: 1 };

    const base = v.rodar(c, idx, OPT);
    const nova = v.rodar(c, idx, { ...OPT, ocrPrimeiro: true });

    const mapa = linhas => {
        const m = new Map();
        for (const L of linhas)
            for (const p of (L.pares || []))
                m.set(`${L.periodo}|${p.lancamento.nf}|${p.lancamento.entidade}|${p.lancamento.valor}`,
                      { arq: p.documento.arquivo, l: p.lancamento });
        return m;
    };
    const mb = mapa(base), mn = mapa(nova);

    // Força "honesta" de um par: sinais concordantes olhando o que está no NOME do
    // arquivo (número e valor) mais o emitente do extrator — as duas evidências
    // brutas, sem a preferência que a variante aplicou.
    function forcaHonesta(l, arq) {
        const d = par.documentoDoArquivo(arq, arq);
        const o = idx[arq] || {};
        const numNome = soDig(d.numero), numOcr = soDig(o.numero);
        const alvo = l.nfDig;
        const num = !!(alvo && (alvo === numNome || alvo === numOcr ||
                       alvo === String(Number(numNome || '-1')) ||
                       alvo === String(Number(numOcr || '-1'))));
        const val = d.valor != null && l.valor > 0 && Math.abs(l.valor - d.valor) < 0.005
                 || (o.valor != null && l.valor > 0 && Math.abs(l.valor - o.valor) < 0.005);
        const tks = new Set([...d.tokens, ...(o.emitente ? par.tokens(o.emitente) : [])]);
        let ent = false;
        for (const t of l.tokens) if (tks.has(t)) { ent = true; break; }
        return (num ? 1 : 0) + (val ? 1 : 0) + (ent ? 1 : 0);
    }

    let melhor = 0, pior = 0, igual = 0;
    const exMelhor = [], exPior = [];
    for (const [k, novo] of mn) {
        const antigo = mb.get(k);
        if (!antigo || antigo.arq === novo.arq) continue;
        const fa = forcaHonesta(novo.l, antigo.arq);
        const fn = forcaHonesta(novo.l, novo.arq);
        if (fn > fa) { melhor++; if (exMelhor.length < 8) exMelhor.push(`  ${k}\n     ${antigo.arq} (força ${fa})\n  -> ${novo.arq} (força ${fn})`); }
        else if (fn < fa) { pior++; if (exPior.length < 8) exPior.push(`  ${k}\n     ${antigo.arq} (força ${fa})\n  -> ${novo.arq} (força ${fn})`); }
        else igual++;
    }

    console.log('=== AS TROCAS DA INVERSÃO: MELHORA OU PIORA? ===\n');
    console.log(`  documento novo é MAIS forte ... ${melhor}`);
    console.log(`  documento novo é MENOS forte .. ${pior}`);
    console.log(`  empate ........................ ${igual}`);

    if (exMelhor.length) console.log('\n  MELHORAS:\n' + exMelhor.join('\n'));
    if (exPior.length) console.log('\n  PIORAS:\n' + exPior.join('\n'));

    // As perdas: o par perdido era forte ou fraco?
    let perdaForte = 0, perdaFraca = 0;
    const exPerda = [];
    for (const [k, antigo] of mb) {
        if (mn.has(k)) continue;
        const f = forcaHonesta(antigo.l, antigo.arq);
        if (f >= 2) { perdaForte++; exPerda.push(`  FORTE (${f}) ${k}\n     ${antigo.arq}`); }
        else { perdaFraca++; if (exPerda.length < 12) exPerda.push(`  fraco (${f}) ${k}\n     ${antigo.arq}`); }
    }
    console.log(`\n=== AS PERDAS ===\n`);
    console.log(`  eram pares FORTES (2+ sinais) ... ${perdaForte}`);
    console.log(`  eram pares fracos (0-1 sinal) ... ${perdaFraca}`);
    console.log('\n' + exPerda.join('\n'));
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
