/**
 * _medir/_v1-v2-custo-no-acervo.js — V1/V2 cegam algo no ACERVO INTEIRO?
 *
 * `_sobra-tem-conserto.js` mediu o ganho sobre os 57 alertas ATUAIS e achou 0
 * cegados. Mas isso mede a variante só onde ela já dispara hoje. A regra vai agir
 * em TODO par futuro, e o acervo tem 4.844 documentos contra os 1.775 pareados.
 *
 * Foi exatamente aqui que a simetria IRRESTRITA se perdeu na medição de ontem: ela
 * parecia ótima até contarmos os 8 procedentes que cegava.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Sobre o ACERVO inteiro, quantos documentos:
 *   (a) têm acessório no nome E tipo RECIBO/CTE   → V1/V2 dispararia
 *   (b) desses, quantos têm marcador FORTE no papel CONTRADIZENDO o tipo gravado
 *       → seriam defeito real, e a variante os cegaria
 *
 * Um documento com ev="DANFE" classificado como RECIBO é defeito; se o nome tiver
 * "+BOL", V1 o silenciaria para sempre. Contar isso é o custo verdadeiro.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const ACESSORIO_NO_NOME_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = a => ACESSORIO_NO_NOME_RE.test(norm(a));

const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
function marcadorDoPapel(ev) {
    const e = norm(ev);
    if (/^IA:/.test(e)) return '';
    return MARCADOR_FORTE[e] || '';
}

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) if (!docs.has(base(arq))) docs.set(base(arq), info);

    console.log('═'.repeat(74));
    console.log(`CUSTO DE V1/V2 SOBRE O ACERVO (${docs.size} documentos)`);
    console.log('═'.repeat(74));

    for (const [nome, alvo] of [['V1', 'RECIBO'], ['V2', 'CTE']]) {
        // documentos onde a variante PODE disparar: tipo = alvo E acessório no nome
        const zona = [];
        for (const [arq, info] of docs) {
            const tb = norm(info.tipo);
            if (tb !== alvo) continue;
            if (!temAcessorio(arq)) continue;
            zona.push({ arq, tb, papel: marcadorDoPapel(info.evidencia),
                        evid: String(info.evidencia || '').trim() });
        }
        const confirma  = zona.filter(z => z.papel && z.papel === z.tb);
        const contradiz = zona.filter(z => z.papel && z.papel !== z.tb);
        const mudo      = zona.filter(z => !z.papel);

        console.log(`\n── ${nome}: documentos tipo=${alvo} COM acessório no nome ──`);
        console.log(`   na zona de ação da variante:     ${String(zona.length).padStart(4)}`);
        console.log(`     papel CONFIRMA o tipo gravado: ${String(confirma.length).padStart(4)}  (absolver é correto)`);
        console.log(`     papel CONTRADIZ:               ${String(contradiz.length).padStart(4)}  ← CUSTO: defeitos cegados`);
        console.log(`     papel mudo (IA/vazio):         ${String(mudo.length).padStart(4)}`);
        if (contradiz.length) {
            console.log('\n   os que seriam CEGADOS:');
            for (const z of contradiz.slice(0, 12))
                console.log(`      papel=${z.papel.padEnd(7)} banco=${z.tb.padEnd(7)} ev="${z.evid.slice(0, 12)}"  ${z.arq.slice(0, 48)}`);
            if (contradiz.length > 12) console.log(`      … e mais ${contradiz.length - 12}`);
        }
    }

    // ── contraprova: a variante C atual, medida do mesmo jeito ─────────────
    console.log('\n── CONTRAPROVA: a variante C já implantada, mesma métrica ──');
    const zonaC = [];
    for (const [arq, info] of docs) {
        if (norm(info.tipo) !== 'FATURA') continue;
        if (!temAcessorio(arq)) continue;
        zonaC.push({ arq, tb: 'FATURA', papel: marcadorDoPapel(info.evidencia),
                     evid: String(info.evidencia || '').trim() });
    }
    const cContradiz = zonaC.filter(z => z.papel && z.papel !== z.tb);
    console.log(`   zona de ação: ${zonaC.length}   papel contradiz: ${cContradiz.length}`);
    console.log('   (a variante C foi APROVADA com 147 falsos mortos por 1 cegado —');
    console.log('    serve de régua para julgar se V1/V2 são comparáveis)');
    if (cContradiz.length) for (const z of cContradiz.slice(0, 6))
        console.log(`      papel=${z.papel.padEnd(7)} ev="${z.evid.slice(0, 12)}"  ${z.arq.slice(0, 48)}`);

    console.log(`\n${'═'.repeat(74)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
