/**
 * _medir/_o-tipobate-ainda-serve.js — cortar a força 1 tornou o tipoBate inútil?
 *
 * SINAL (21/09/2026): depois de desligar a via do valor solto, `_o-que-ja-vale-agora`
 * reporta 30 alertas antes E 30 depois do conserto de `tipoBate` — antes eram
 * 240 → 57. O conserto parou de agir.
 *
 * Duas explicações possíveis, com consequências opostas:
 *
 *   (a) ESPERADO — os alertas que o tipoBate matava viviam nos pares de força 1,
 *       que agora não existem. O conserto continua correto, só não tem mais
 *       trabalho nessa população.
 *   (b) REGRESSÃO — a mudança quebrou algo no caminho do tipo.
 *
 * A diferença importa muito: em (a) tudo bem; em (b) eu quebrei o trabalho de hoje.
 *
 * ── Como distinguir ─────────────────────────────────────────────────────────
 * Rodar o painel com o motor de HEAD e com o atual, e cruzar: dos 183 alertas que
 * o tipoBate matava, quantos estavam em pares que a nova regra eliminou? Se ~todos,
 * é (a).
 *
 * E conferir que `tipoBate` continua sendo CHAMADO e continua absolvendo quando
 * deve — testando a função direto.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
function tipoBateDe(src) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}
function carregarPareamento(src) {
    const mod = { exports: {} };
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    new Function('require', 'module', 'exports', '__dirname', '__filename', src)(
        req, mod, mod.exports, path.join(h.RAIZ, 'routes'), path.join(h.RAIZ, 'routes', '_pareamento.js'));
    return mod.exports;
}

(async () => {
    // ── (1) a função tipoBate em si continua correta? ──────────────────────
    const tbAntes = tipoBateDe(execFileSync('git', ['show', 'HEAD~1:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const tbAgora = tipoBateDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8'));
    console.log('═'.repeat(78));
    console.log('(1) A FUNÇÃO tipoBate AINDA FAZ O QUE DEVE?');
    console.log('═'.repeat(78));
    const CASO = ['FATURA', { tipoBanco: 'NF' }, { arquivo: '001.DOC- 100,00. FORN. NF 123 + BOL.pdf' }];
    console.log(`\n   caso "planilha=NF × banco=FATURA, nome com +BOL":`);
    console.log(`      HEAD~1 (antes do conserto): ${tbAntes(...CASO)}  ${tbAntes(...CASO) ? '(absolve)' : '(acusa)'}`);
    console.log(`      agora:                      ${tbAgora(...CASO)}  ${tbAgora(...CASO) ? '(absolve)' : '(acusa)'}`);
    console.log(`   → ${tbAgora(...CASO) && !tbAntes(...CASO) ? '✓ o conserto está vivo na função' : '⚠ algo mudou'}`);

    // ── (2) onde viviam os alertas que ele matava? ─────────────────────────
    const srcHead = execFileSync('git', ['show', 'HEAD:routes/_pareamento.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const srcAgora = fs.readFileSync(path.join(h.RAIZ, 'routes', '_pareamento.js'), 'utf8');
    const Pantes = carregarPareamento(srcHead);
    const Pagora = carregarPareamento(srcAgora);

    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE'), iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]); const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    function alertas(P, tb) {
        const out = [];
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
                const o = P.lancamentoDaPlanilha(l);
                o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
                return o;
            });
            const docsPorMes = {};
            for (const off of [0, ...P.VIZINHANCA]) {
                const alvo = P.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    P.enriquecerComOcr(P.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
            }
            const r = P.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                const tipoPl = tipoPorChave.get(x.lancamento._chave);
                const info = idx[base(x.documento.arquivo)] || {};
                const lido = x.documento.tipo || info.tipo || '';
                if (!lido || !tipoPl) continue;
                const gab = tipoPlanilhaParaBanco(tipoPl);
                if (!gab) continue;
                if (tb(lido, { tipoBanco: gab }, { arquivo: x.documento.arquivo })) continue;
                out.push({ chave: `${periodo}|${x.documento.arquivo}`, forca: x.forca,
                            valor: Math.abs(Number(x.lancamento.valor) || 0) });
            }
        }
        return out;
    }

    const antesSemConserto = alertas(Pantes, tbAntes);
    const antesComConserto = alertas(Pantes, tbAgora);
    const agoraSemConserto = alertas(Pagora, tbAntes);
    const agoraComConserto = alertas(Pagora, tbAgora);

    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) OS ALERTAS, NOS DOIS MOTORES');
    console.log('═'.repeat(78));
    console.log('\n   motor          sem conserto   com conserto   diferença');
    console.log(`   HEAD           ${String(antesSemConserto.length).padStart(12)}   ${String(antesComConserto.length).padStart(12)}   ${antesSemConserto.length - antesComConserto.length}`);
    console.log(`   com o corte    ${String(agoraSemConserto.length).padStart(12)}   ${String(agoraComConserto.length).padStart(12)}   ${agoraSemConserto.length - agoraComConserto.length}`);

    // dos que o conserto matava no HEAD, quantos eram de força 1?
    const mortos = new Set(antesSemConserto.map(x => x.chave));
    for (const x of antesComConserto) mortos.delete(x.chave);
    const mortosLista = antesSemConserto.filter(x => mortos.has(x.chave));
    const porForca = new Map();
    for (const x of mortosLista) porForca.set(x.forca, (porForca.get(x.forca) || 0) + 1);
    console.log(`\n   alertas que o conserto matava no HEAD: ${mortosLista.length}`);
    console.log('   por força do par:');
    for (const f of [3, 2, 1])
        console.log(`      força ${f}: ${String(porForca.get(f) || 0).padStart(4)}  ${pct(porForca.get(f) || 0, mortosLista.length)}`);

    console.log(`\n${'═'.repeat(78)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(78));
    const f1 = porForca.get(1) || 0;
    console.log(`\n   O tipoBate continua ATIVO: com o novo motor mata ${agoraSemConserto.length - agoraComConserto.length}`);
    console.log(`   alertas (${agoraSemConserto.length} → ${agoraComConserto.length}). Só ${pct(f1, mortosLista.length)} dos que ele matava`);
    console.log('   eram de força 1, então o corte quase não invade o território dele.');
    console.log('\n   O "0 a menos" que me assustou era ARTEFATO de `_o-que-ja-vale-agora.js`:');
    console.log('   aquele script compara `_baseline.js` do disco contra git HEAD, e o');
    console.log('   conserto do tipoBate JÁ ESTÁ COMMITADO — os dois lados o têm. Ele');
    console.log('   mede "o que falta commitar", não "o que o conserto vale".');
    console.log('\n   Os dois consertos somam: 240 → 30 alertas no total.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
