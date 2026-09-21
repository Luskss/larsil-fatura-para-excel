/**
 * _medir/_tipo-custo-real.js — os 152 erros de tipo CUSTAM alguma coisa?
 *
 * CONTEXTO (21/09/2026): medi 75,5% de acurácia no tipo e isolei a causa (a REGRA
 * DE PACOTE do FULL_PROMPT vira "NF + BOL" em FATURA — 152 erros, todos via IA).
 * Mas a memória [[ocp-no-numero-e-correto]] (18/09) já tinha investigado a mesma
 * queixa e concluído CUSTO ZERO. Antes de propor conserto, é preciso decidir quem
 * está certo — medir acurácia contra um gabarito NÃO é medir dano.
 *
 * ── As três portas por onde o tipo poderia custar ───────────────────────────
 *  1. PAREAMENTO: `_pareamento.js` consulta `d.tipo` para casar?
 *  2. PAINEL: `tipoBate` (_baseline.js:184) acusa divergência ao usuário?
 *  3. EXTRAÇÃO: `chaveNumeroPorTipo` (process-folder.js:408) grava o número numa
 *     chave diferente por tipo — se a chave gravada não for lida pelo índice, o
 *     número some e AÍ o tipo custa pareamento, indiretamente.
 *
 * A porta 3 é a que a memória de 18/09 não examinou.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';

(async () => {
    // ── PORTA 1: o pareamento lê `tipo`? ───────────────────────────────────
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_pareamento.js'), 'utf8');
    const usosTipo = src.split(/\r?\n/)
        .map((l, i) => ({ n: i + 1, l }))
        .filter(x => /\.tipo\b|\btipo\b/.test(x.l) && !/^\s*(\/\/|\*)/.test(x.l));
    console.log('── PORTA 1: o PAREAMENTO consulta o tipo? ────────────────────');
    console.log(`  linhas de _pareamento.js que tocam \`tipo\` (fora de comentário): ${usosTipo.length}`);
    for (const u of usosTipo) console.log(`    ${String(u.n).padStart(4)}: ${u.l.trim().slice(0, 78)}`);
    const decide = usosTipo.some(u => /if\s*\(.*tipo|tipo\s*[=!]==|tipoBate/.test(u.l));
    console.log(`  → o tipo DECIDE casamento? ${decide ? 'SIM' : 'NÃO — só é carregado para exibir'}`);

    // ── PORTA 2: tipoBate absolve a família NF/NFS→FATURA? ─────────────────
    const b = require('../routes/_baseline.js');
    console.log('\n── PORTA 2: o PAINEL acusa divergência nesses casos? ─────────');
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    const absolve = m && /tp === 'FATURA' && \(tb === 'NF' \|\| tb === 'NFS'\)/.test(m[0]);
    const absolveNfNfs = m && /\(tb === 'NF' \|\| tb === 'NFS'\) && \(tp === 'NF' \|\| tp === 'NFS'\)/.test(m[0]);
    console.log(`  regra "planilha FATURA × banco NF/NFS → não é divergência": ${absolve ? 'EXISTE' : 'ausente'}`);
    console.log(`  regra "NF ↔ NFS intercambiáveis":                          ${absolveNfNfs ? 'EXISTE' : 'ausente'}`);
    console.log('  ⚠ ATENÇÃO à direção: tipoBate(tipoBanco, nota) tem tb=BANCO, tp=PLANILHA.');
    console.log('    A regra absolve tp(planilha)=FATURA × tb(banco)=NF/NFS.');
    console.log('    Os meus erros são o INVERSO: planilha=NF/NFS × banco=FATURA.');

    // simula tipoBate nas duas direções, com o mapa real
    const tipoBate = new Function('norm', `${m[0]}; return tipoBate;`)(
        s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim());
    const casos = [
        ['banco=FATURA', 'planilha=NF  (NOTA FISCAL RFB)',     'FATURA', 'NF'],
        ['banco=FATURA', 'planilha=NFS (NOTA FISCAL SERVICO)', 'FATURA', 'NFS'],
        ['banco=NF',     'planilha=FATURA',                    'NF',     'FATURA'],
        ['banco=NF',     'planilha=NFS',                       'NF',     'NFS'],
        ['banco=IMPOSTO','planilha=FATURA',                    'IMPOSTO','FATURA'],
        ['banco=CTE',    'planilha=NF',                        'CTE',    'NF'],
        ['banco=RECIBO', 'planilha=NF',                        'RECIBO', 'NF'],
    ];
    console.log('\n  simulação de tipoBate (true = painel fica calado):');
    for (const [a, c, tb, tp] of casos) {
        const ok = tipoBate(tb, { tipoBanco: tp }, {});
        console.log(`    ${a.padEnd(15)} × ${c.padEnd(34)} → ${ok ? 'ok, calado' : 'ACUSA DIVERGÊNCIA'}`);
    }

    // ── PORTA 3: a chave do número muda com o tipo, e o índice lê? ─────────
    console.log('\n── PORTA 3: o tipo muda ONDE o número é gravado? ─────────────');
    const srcP = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const mk = srcP.match(/function chaveNumeroPorTipo[\s\S]*?\n\}/);
    console.log(mk ? mk[0].split(/\r?\n/).map(l => '  ' + l).join('\n') : '  (não achei)');

    const srcO = fs.readFileSync(path.join(h.RAIZ, '_medir', 'ocr.js'), 'utf8');
    const mo = srcO.match(/const numero = primeiro\(d, \[([^\]]*)\]/);
    console.log('\n  chaves que o ÍNDICE procura para o número:');
    console.log(`    ${mo ? mo[1].trim() : '(não achei)'}`);

    const srcC = fs.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const mc = srcC.match(/CHAVES_NUMERO\s*=\s*\[([^\]]*)\]/);
    if (mc) console.log(`\n  CHAVES_NUMERO (produção): ${mc[1].replace(/\s+/g, ' ').trim()}`);

    console.log('\n  → se a chave gravada por um tipo NÃO estiver nessas listas, o número');
    console.log('    some do índice e o tipo passa a custar PAREAMENTO, não só rótulo.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
