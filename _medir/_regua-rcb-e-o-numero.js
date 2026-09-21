/**
 * _medir/_regua-rcb-e-o-numero.js — "RCB" no nome é TIPO ou é NÚMERO?
 *
 * ACHADO (21/09/2026): a concordância de 65,2% do acervo tem duas famílias enormes
 * de "discordância", e ambas parecem a RÉGUA errando, não o sistema:
 *
 *   RECIBO→IMPOSTO (372)  nomes com GOVERNO / GOVERNO-IPVA / SECRETARIA DA FAZENDA
 *   RECIBO→FATURA  (208)  nomes com CEMIG / EQUATORIAL / SANESUL / COPASA
 *
 * A hipótese: no padrão de nome deste acervo, **"RCB 901432" é o número do
 * comprovante de pagamento**, não o tipo do documento. O arquivista escreve
 * "GOVERNO-IPVA. RCB 90xxxx" para uma guia de IPVA — o papel é IMPOSTO e o RCB é
 * só a referência interna. Mesma lógica de [[um-recibo-muitos-nomes]].
 *
 * Se for isso, minha régua `tipoDoNome` está contando ~580 acertos como erro, e a
 * concordância real é muito maior que 65,2%.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Para cada discordância RECIBO→X, o nome traz OUTRO sinal que confirma o X?
 *   • emitente de concessionária/governo no nome → confirma FATURA/IMPOSTO
 *   • a evidência da IA traz o nome do órgão/concessionária → idem
 * Se a maioria confirmar, a régua é que não sabe ler "RCB" como número.
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

// órgão público / tributo → IMPOSTO é plausível
const GOV = /\bGOVERNO\b|\bPREFEITURA\b|\bSECRETARIA\b|\bFAZENDA\b|\bIPVA\b|\bDETRAN\b|\bRECEITA\b|\bSEFAZ\b|\bMUNICIPIO\b|\bESTADO D/;
// concessionária de serviço contínuo → FATURA é plausível
const CONCESSIONARIA = /\bCEMIG\b|\bEQUATORIAL\b|\bSANESUL\b|\bCOPASA\b|\bSANEAGO\b|\bENERGISA\b|\bCELG\b|\bAGUAS D|\bSABESP\b|\bCOPEL\b|\bNET\b|\bTELECOM\b|\bVIVO\b|\bCLARO\b|\bTIM\b|\bOI\b|\bALGAR\b|\bINTERNET\b|\bFIBRA\b|\bBIOS\b/;

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) if (!docs.has(base(arq))) docs.set(base(arq), info);

    // só os nomes cujo ÚNICO marcador é RCB/RC/RECIBO
    const soRcb = [];
    for (const [arq, info] of docs) {
        const t = norm(arq);
        const temRcb = /\bRCB\b|\bRC\b|\bRECIBO\b|\bREC\b/.test(t);
        if (!temRcb) continue;
        const tb = String(info.tipo || '').trim();
        if (!tb || tb === 'RECIBO' || tb === 'Não identificado') continue;
        soRcb.push({ arq, info, tb });
    }

    console.log(`documentos com RCB/RC no nome mas tipo ≠ RECIBO: ${soRcb.length}\n`);

    // o RCB vem seguido de número? (é referência, não tipo)
    const comNumero = soRcb.filter(x => /\b(RCB|RC|REC)\s*\.?\s*\d{3,}/.test(norm(x.arq)));
    console.log(`  desses, com "RCB <número>" (padrão de REFERÊNCIA): ${comNumero.length}  ${pct(comNumero.length, soRcb.length)}`);

    // um segundo sinal no nome/evidência confirma o tipo do banco?
    let confirmado = 0, naoConfirmado = 0;
    const porTipo = new Map();
    const naoConf = [];
    for (const x of soRcb) {
        const txt = norm(x.arq) + ' ' + norm(x.info.evidencia || '');
        let ok = false;
        if (x.tb === 'IMPOSTO') ok = GOV.test(txt);
        else if (x.tb === 'FATURA') ok = CONCESSIONARIA.test(txt);
        else ok = false;
        if (!porTipo.has(x.tb)) porTipo.set(x.tb, { n: 0, ok: 0 });
        const o = porTipo.get(x.tb); o.n++; if (ok) o.ok++;
        if (ok) confirmado++; else { naoConfirmado++; if (naoConf.length < 14) naoConf.push(x); }
    }

    console.log(`\n── um SEGUNDO sinal no nome/evidência confirma o tipo? ─────`);
    console.log(`  CONFIRMADO (órgão público ou concessionária): ${confirmado}  ${pct(confirmado, soRcb.length)}`);
    console.log(`  não confirmado:                                ${naoConfirmado}  ${pct(naoConfirmado, soRcb.length)}`);

    console.log('\n  por tipo do banco:');
    for (const [k, v] of [...porTipo].sort((a, b) => b[1].n - a[1].n))
        console.log(`    ${k.padEnd(12)} ${String(v.n).padStart(4)} docs   confirmados ${pct(v.ok, v.n).padStart(7)}`);

    console.log('\n── os NÃO confirmados (suspeita que resta) ─────────────────');
    for (const x of naoConf)
        console.log(`  [${x.tb}] "${String(x.info.evidencia).slice(0, 30)}"  ${x.arq.slice(0, 46)}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(68));
    if (confirmado > soRcb.length * 0.7) {
        console.log(`\n  ${pct(confirmado, soRcb.length)} das "discordâncias RECIBO→X" têm um segundo sinal`);
        console.log('  no nome confirmando o tipo do BANCO. O "RCB" desses nomes é o NÚMERO');
        console.log('  do comprovante, não o tipo do papel — o sistema acertou.');
        console.log('\n  → minha régua `tipoDoNome` conta ~' + confirmado + ' acertos como erro.');
        console.log('    A concordância real do classificador é MUITO maior que 65,2%.');
    } else {
        console.log('\n  O segundo sinal não confirma a maioria: as discordâncias RECIBO→X');
        console.log('  merecem inspeção caso a caso.');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
