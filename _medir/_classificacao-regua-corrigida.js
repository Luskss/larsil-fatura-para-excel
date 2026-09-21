/**
 * _medir/_classificacao-regua-corrigida.js — a classificação, com a régua consertada.
 *
 * DUAS FALHAS DA RÉGUA, ambas medidas hoje (21/09/2026):
 *
 *  1. "NF" no nome não é tipo fiscal — o arquivista usa como sinônimo de NOTA.
 *     Em frete o papel é CT-e ([[nf-para-cte-nao-e-defeito]]).
 *  2. "RCB 901432" é o NÚMERO do comprovante, não o tipo. Medido em
 *     `_regua-rcb-e-o-numero.js`: 99,6% dos RCB vêm seguidos de número, e 77,3%
 *     dos casos "RECIBO→X" têm segundo sinal confirmando o X (GOVERNO-IPVA →
 *     IMPOSTO, CEMIG/EQUATORIAL → FATURA). O sistema acertou; a régua é que lia
 *     a referência como tipo.
 *
 * A régua corrigida:
 *   • ignora RCB/RC/REC quando vem seguido de NÚMERO (é referência)
 *   • ignora NF quando o emitente é transportadora (frete emite CT-e)
 *   • mantém o resto
 *
 * Isto NÃO é afrouxar a régua para o sistema passar — é parar de exigir que o
 * classificador concorde com um campo que não significa o que eu supunha. O teste
 * de que não afrouxei: as discordâncias que sobram continuam sendo listadas.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|\bRODONAVES\b|PRINCESA DOS CAMPOS|\bACITEL\b|\bCADORE\b/;

// Régua CORRIGIDA: devolve '' quando o nome não permite concluir o tipo.
function tipoDoNomeV2(nome, evidencia = '') {
    const t = norm(nome);
    const ctx = t + ' ' + norm(evidencia);

    // NFS é inequívoco
    if (/\bNFS-?E?\b/.test(t)) return 'NFS';
    if (/\bCT-?E\b|\bDACTE\b/.test(t)) return 'CTE';
    // guia de tributo escrita por extenso
    if (/\bDARF\b|\bGPS\b|\bFGTS\b|\bINSS\b|\bIPVA\b|\bGUIA\b/.test(t)) return 'IMPOSTO';
    if (/\bCONSORCIO\b|\bCOTA\b/.test(t)) return 'CONSORCIO';

    // "NF" só vale se NÃO for frete: transportadora emite CT-e e o arquivista
    // escreve "NF" assim mesmo.
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t)) {
        if (TRANSPORTADOR.test(ctx)) return '';
        return 'NF';
    }
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t)) return 'FATURA';

    // "RCB 901432" é REFERÊNCIA, não tipo. Só conta como RECIBO quando vier
    // SEM número colado (raro) ou escrito "RECIBO" por extenso.
    if (/\bRECIBO\b/.test(t)) return 'RECIBO';
    if (/\b(RCB|RC|REC)\s*\.?\s*\d{3,}/.test(t)) return '';   // referência
    if (/\bRCB\b|\bRC\b|\bREC\b/.test(t)) return 'RECIBO';
    return '';
}

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) if (!docs.has(base(arq))) docs.set(base(arq), info);

    let comMarcador = 0, concorda = 0, discorda = 0, semMarcador = 0, naoIdent = 0;
    const disc = new Map();
    for (const [arq, info] of docs) {
        const tb = String(info.tipo || '').trim();
        if (!tb || tb === 'Não identificado') { naoIdent++; continue; }
        const tn = tipoDoNomeV2(arq, info.evidencia);
        if (!tn) { semMarcador++; continue; }
        comMarcador++;
        if (tn === tb) { concorda++; continue; }
        discorda++;
        const k = `${tn}→${tb}`;
        if (!disc.has(k)) disc.set(k, []);
        disc.get(k).push({ arq, ev: info.evidencia, org: info.origem });
    }

    console.log(`documentos: ${docs.size}\n`);
    console.log('── CONCORDÂNCIA, com a régua corrigida ─────────────────────');
    console.log(`  avaliáveis (nome diz o tipo): ${comMarcador}`);
    console.log(`    CONCORDAM: ${String(concorda).padStart(5)}  ${pct(concorda, comMarcador)}`);
    console.log(`    discordam: ${String(discorda).padStart(5)}  ${pct(discorda, comMarcador)}`);
    console.log(`  não avaliáveis (nome não diz):  ${semMarcador}`);
    console.log(`  'Não identificado':             ${naoIdent}  ${pct(naoIdent, docs.size)}`);

    console.log('\n── as discordâncias que SOBRAM ─────────────────────────────');
    const ord = [...disc].sort((a, b) => b[1].length - a[1].length);
    for (const [k, v] of ord)
        console.log(`  ${k.padEnd(20)} ${String(v.length).padStart(5)}`);

    console.log('\n── amostra das 3 maiores ───────────────────────────────────');
    for (const [k, v] of ord.slice(0, 3)) {
        console.log(`\n  ${k}  (${v.length})`);
        for (const e of v.slice(0, 6))
            console.log(`     [${String(e.org).slice(0, 16)}] "${String(e.ev).slice(0, 26)}"  ${e.arq.slice(0, 44)}`);
    }

    console.log(`\n${'═'.repeat(68)}`);
    console.log('COMPARAÇÃO');
    console.log('═'.repeat(68));
    console.log('\n  régua ingênua ("RCB"=tipo, "NF"=NF):  65,2% de concordância');
    console.log(`  régua corrigida:                      ${pct(concorda, comMarcador)}`);
    console.log('\n  A diferença NÃO é o classificador melhorando — é a régua parando de');
    console.log('  exigir que ele concorde com um campo que não significa tipo.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
