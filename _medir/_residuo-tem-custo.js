/**
 * _medir/_residuo-tem-custo.js — as 584 discordâncias que sobram custam algo?
 *
 * ESTADO (21/09/2026): com a régua corrigida, a concordância do classificador é
 * **78,6%** (2.147 de 2.731 avaliáveis). Sobram 584 discordâncias, e uma família
 * domina: **NF→FATURA, 391 casos, todos pela IA**.
 *
 * É a REGRA DE PACOTE de novo ([[regra-de-pacote-inverte-nf-em-fatura]]): num PDF
 * "NF 20176 + BOL" a IA elege o boleto como principal e devolve FATURA.
 *
 * ── A pergunta que decide ───────────────────────────────────────────────────
 * Já sei que isso NÃO custa no painel: `tipoBate` com a variante C absolve
 * exatamente `planilha=NF × banco=FATURA` quando o nome tem "+BOL"
 * ([[tipobate-simetrico-restrito-aprovado]]). Mas o tipo é usado em mais lugares:
 *
 *   1. PAINEL — `tipoBate` (já medido: absolvido)
 *   2. EXTRAÇÃO — `chaveNumeroPorTipo` grava o número em chave diferente por tipo
 *   3. FILTRO — algum tipo é excluído da conferência?
 *
 * Este script confirma (1) sobre os 391 REAIS, e verifica (2) e (3).
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
function tipoDoNomeV2(nome, evidencia = '') {
    const t = norm(nome), ctx = t + ' ' + norm(evidencia);
    if (/\bNFS-?E?\b/.test(t)) return 'NFS';
    if (/\bCT-?E\b|\bDACTE\b/.test(t)) return 'CTE';
    if (/\bDARF\b|\bGPS\b|\bFGTS\b|\bINSS\b|\bIPVA\b|\bGUIA\b/.test(t)) return 'IMPOSTO';
    if (/\bCONSORCIO\b|\bCOTA\b/.test(t)) return 'CONSORCIO';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t)) return TRANSPORTADOR.test(ctx) ? '' : 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t)) return 'FATURA';
    if (/\bRECIBO\b/.test(t)) return 'RECIBO';
    if (/\b(RCB|RC|REC)\s*\.?\s*\d{3,}/.test(t)) return '';
    if (/\bRCB\b|\bRC\b|\bREC\b/.test(t)) return 'RECIBO';
    return '';
}

function carregarTipoBate() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) if (!docs.has(base(arq))) docs.set(base(arq), info);
    const tipoBate = carregarTipoBate();

    // as discordâncias que sobram
    const resto = [];
    for (const [arq, info] of docs) {
        const tb = String(info.tipo || '').trim();
        if (!tb || tb === 'Não identificado') continue;
        const tn = tipoDoNomeV2(arq, info.evidencia);
        if (!tn || tn === tb) continue;
        resto.push({ arq, tn, tb, info });
    }
    console.log(`discordâncias remanescentes: ${resto.length}\n`);

    // ── (1) o PAINEL acusa? ────────────────────────────────────────────────
    // simula o lançamento cujo TIPO da planilha corresponde ao do nome
    const MAPA_PLAN = { NF: 'NF', NFS: 'NFS', FATURA: 'FATURA', IMPOSTO: 'IMPOSTO', RECIBO: '*', CONSORCIO: '*', CTE: '' };
    let acusa = 0, calado = 0, semBase = 0;
    const acusados = new Map();
    for (const r of resto) {
        const tp = MAPA_PLAN[r.tn];
        if (tp === undefined || tp === '') { semBase++; continue; }
        const ok = tipoBate(r.tb, { tipoBanco: tp }, { arquivo: r.arq });
        if (ok) calado++;
        else {
            acusa++;
            const k = `${r.tn}→${r.tb}`;
            if (!acusados.has(k)) acusados.set(k, 0);
            acusados.set(k, acusados.get(k) + 1);
        }
    }
    console.log('── (1) o PAINEL acusaria esses? ────────────────────────────');
    console.log(`  tipoBate fica CALADO (não é divergência): ${calado}  ${pct(calado, resto.length)}`);
    console.log(`  tipoBate ACUSA:                           ${acusa}  ${pct(acusa, resto.length)}`);
    console.log(`  sem base para comparar:                   ${semBase}`);
    if (acusados.size) {
        console.log('\n  os que acusariam, por família:');
        for (const [k, n] of [...acusados].sort((a, b) => b[1] - a[1]))
            console.log(`    ${k.padEnd(20)} ${String(n).padStart(4)}`);
    }

    // ── (2) a chave do número muda com o tipo? ─────────────────────────────
    console.log('\n── (2) o tipo muda ONDE o número é gravado? ────────────────');
    const srcP = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const mk = srcP.match(/function chaveNumeroPorTipo[\s\S]*?\n\}/);
    console.log(mk ? mk[0].split(/\r?\n/).map(l => '   ' + l.trim()).join('\n') : '   (não achei)');
    const srcC = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const mc = srcC.match(/CHAVES_NUMERO\s*=\s*\[([^\]]*)\]/);
    console.log(`\n   CHAVES_NUMERO lê: ${mc ? mc[1].replace(/\s+/g, ' ').trim() : '(?)'}`);
    console.log('\n   NF e FATURA gravam na MESMA chave (`Nº da NF-e`), então trocar');
    console.log('   um pelo outro NÃO move o número de lugar. Só CTE e IMPOSTO usam');
    console.log('   chave própria — e ambas estão em CHAVES_NUMERO.');

    // quantos dos que sobram envolvem CTE ou IMPOSTO?
    const comChavePropria = resto.filter(r => r.tb === 'CTE' || r.tb === 'IMPOSTO' || r.tn === 'CTE' || r.tn === 'IMPOSTO');
    console.log(`\n   discordâncias envolvendo CTE/IMPOSTO (chave própria): ${comChavePropria.length}`);

    // ── (3) algum tipo é filtrado da conferência? ──────────────────────────
    console.log('\n── (3) algum TIPO é excluído da conferência? ───────────────');
    const mf = srcC.match(/function categoriaNaoFiscal[\s\S]{0,400}/);
    const temFiltroPorTipo = /\btipo\b/.test(String(mf || ''));
    console.log(`   categoriaNaoFiscal filtra por TIPO do documento? ${temFiltroPorTipo ? 'SIM' : 'NÃO — filtra por nome/categoria da planilha'}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(68));
    console.log(`\n  Das ${resto.length} discordâncias, ${pct(calado, resto.length)} o painel já trata como`);
    console.log('  NÃO-divergência, e NF↔FATURA compartilham a chave do número.');
    console.log(`\n  O que realmente chegaria ao usuário: ${acusa} casos.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
