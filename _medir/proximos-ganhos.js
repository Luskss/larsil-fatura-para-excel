/**
 * _medir/proximos-ganhos.js — o que ainda dá para ganhar, medido.
 *
 * O diagnóstico pós-§17 mostra 22 recusas da regra com candidato óbvio na pasta.
 * Lendo caso a caso, aparecem dois padrões repetidos e um terceiro já conhecido:
 *
 *   (A) número TRUNCADO no nome do arquivo
 *       BOBIG   planilha NF 21650  ×  arquivo "NF 2165"   (faltou o último dígito)
 *   (B) NF de 1 dígito, barrada pelo piso MIN_DIGITOS_NUM = 2
 *       DARCI   planilha NF 2      ×  arquivo "NFS 2"
 *   (C) valor+entidade além da janela de 15 dias (o caminho fraco)
 *
 * Cada um é medido isoladamente, pelo critério de sempre: cobertura sobe E a
 * confirmação por 2º campo não cai.
 */
'use strict';
const h = require('./harness');
const v = require('./variantes');
const ocrMod = require('./ocr');

(async () => {
    const c = h.carregar();
    const idx = await ocrMod.indexar();
    const BASE = { ocr: true, minDigitosNum: 2 };

    const VARIANTES = [
        ['produção (§17)',                    BASE],
        ['(A) prefixo truncado',              { ...BASE, prefixoNum: true }],
        ['(B) piso de 1 dígito',              { ...BASE, minDigitosNum: 1 }],
        ['(A)+(B)',                           { ...BASE, prefixoNum: true, minDigitosNum: 1 }],
        ['(C) janela fraca 30 dias',          { ...BASE, janelaDias: 30 }],
        ['(C) janela fraca 45 dias',          { ...BASE, janelaDias: 45 }],
        ['(C) janela fraca 60 dias',          { ...BASE, janelaDias: 60 }],
    ];

    console.log('Critério: cobertura sobe E 2º campo não cai.\n');
    console.log('variante                       confer   cob%   semDoc  2ºcampo  contrad   Δpares  Δ2ºcampo');
    const res = [];
    for (const [nome, opt] of VARIANTES) {
        const linhas = v.rodar(c, idx, opt);
        const s = v.resumir(linhas), q = v.qualidade(linhas);
        res.push({ nome, s, q });
    }
    const base = res[0];
    for (const r of res) {
        const d = r.s.conferidos - base.s.conferidos;
        const dq = (r.q.pcConfirmado - base.q.pcConfirmado) * 100;
        console.log(
            `${r.nome.padEnd(30)} ${String(r.s.conferidos).padStart(5)}` +
            ` ${(r.s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(r.s.semDocumento).padStart(7)}` +
            ` ${(r.q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(r.q.contraditos).padStart(7)}` +
            `   ${(d >= 0 ? '+' : '') + d}`.padEnd(9) +
            `  ${dq >= 0 ? '+' : ''}${dq.toFixed(2)}pp`);
    }

    // ── (A) número truncado: quantos casos existem? ─────────────────────────
    // Prefixo: o número do documento é prefixo do da planilha (ou vice-versa),
    // com pelo menos 4 dígitos — abaixo disso a colisão é alta.
    const par = require('../routes/_pareamento');
    console.log('\n=== (A) NÚMERO TRUNCADO — levantamento ===\n');
    let achados = 0;
    const exemplos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(par.lancamentoDaPlanilha);
        const docs = [];
        for (const off of [0, ...par.VIZINHANCA]) {
            const alvo = par.deslocarPeriodo(periodo, off);
            for (const a of (c.pasta.arquivosPorMes[alvo] || []))
                docs.push(par.enriquecerComOcr(par.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        for (const l of lancs) {
            if (!l.nfDig || l.nfDig.length < 4) continue;
            for (const d of docs) {
                if (!d.numeroDig || par.numeroBate(l, d)) continue;
                const curto = d.numeroDig, longo = l.nfDig;
                const ehPrefixo = longo.startsWith(curto) && longo.length - curto.length === 1
                                  && curto.length >= 4;
                if (!ehPrefixo) continue;
                if (!par.entidadeBate(l, d) || !par.valorBate(l, d)) continue;
                achados++;
                if (exemplos.length < 12)
                    exemplos.push(`  ${periodo} ${l.entidade.slice(0, 32).padEnd(32)} ` +
                        `NF ${longo} × doc ${curto}\n     ${d.arquivo.slice(0, 68)}`);
                break;
            }
        }
    }
    console.log(`  casos com número truncado em 1 dígito, ENTIDADE e VALOR também batendo: ${achados}`);
    console.log(exemplos.join('\n') || '  (nenhum)');
    console.log('\n  Obs: exigir entidade E valor juntos é o que torna o prefixo seguro.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
