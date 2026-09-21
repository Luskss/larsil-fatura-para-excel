/**
 * _medir/_forca1-conferir-implementado.js — o código editado faz o que medi?
 *
 * IMPLEMENTADO em 21/09/2026: `casa()` deixou de devolver `'valor'` quando só o
 * valor bate — a via que produzia a força 1.
 *
 * As variantes foram medidas FILTRANDO o resultado do pareamento. Agora a mudança
 * está DENTRO do motor, e isso não é a mesma coisa: cortar um candidato muda quem
 * consome cada documento, e um documento liberado pode virar par de outro
 * lançamento. O efeito real pode ser melhor OU pior que o simulado.
 *
 * Foi assim que a variante C do `tipoBate` surpreendeu no desempate 1↔N
 * ([[tipobate-mexe-no-desempate-1-para-n]]).
 *
 * Previsto: −142 falsos, −5 legítimos, força 3 = 1546, força 2 = 431.
 *
 * Compara o motor ATUAL com o de git HEAD.
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

const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|REC|VIA|COPIA|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A|EM|NA|NO)$/;
function meusTokens(txt, ehArquivo) {
    let t = norm(txt);
    if (ehArquivo) t = t.replace(/\.PDF$/i, '').replace(/\d{1,4}\.DOC-?/i, ' ')
                        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ');
    return t.replace(/[\d.,\/+#;&-]+/g, ' ').split(/\s+/)
            .filter(x => x.length >= 3 && !RUIDO.test(x));
}
function fornecedorConfere(ent, arq, emit) {
    const alvo = meusTokens(ent, false);
    const doDoc = [...new Set([...meusTokens(arq, true), ...meusTokens(emit, false)])];
    if (!alvo.length || !doDoc.length) return 'indecidivel';
    for (const a of alvo) for (const t of doDoc) {
        if (a === t) return 'bate';
        const n = Math.min(a.length, t.length, 5);
        if (n >= 4 && a.slice(0, n) === t.slice(0, n)) return 'bate';
    }
    return 'nao';
}

// carrega um _pareamento.js de uma FONTE arbitrária (HEAD ou disco)
function carregarPareamento(src, tag) {
    const mod = { exports: {} };
    const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    new Function('require', 'module', 'exports', '__dirname', '__filename', src)(
        req, mod, mod.exports, path.join(h.RAIZ, 'routes'), path.join(h.RAIZ, 'routes', '_pareamento.js'));
    if (typeof mod.exports.conferirPeriodo !== 'function')
        throw new Error(`${tag}: conferirPeriodo não exportado`);
    return mod.exports;
}

(async () => {
    const srcHead = execFileSync('git', ['show', 'HEAD:routes/_pareamento.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const srcAgora = fs.readFileSync(path.join(h.RAIZ, 'routes', '_pareamento.js'), 'utf8');
    const antes = carregarPareamento(srcHead, 'HEAD');
    const agora = carregarPareamento(srcAgora, 'disco');

    const c = h.carregar();
    const idx = await indexar();

    function rodar(P) {
        const pares = new Map();
        const forca = { 1: 0, 2: 0, 3: 0 };
        const vias = new Map();
        for (const periodo of h.PERIODOS) {
            const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
                const o = P.lancamentoDaPlanilha(l); o._id = `${periodo}#${i}`; return o;
            });
            const docsPorMes = {};
            for (const off of [0, ...P.VIZINHANCA]) {
                const alvo = P.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    P.enriquecerComOcr(P.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = P.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                if (forca[x.forca] != null) forca[x.forca]++;
                vias.set(x.via || '(?)', (vias.get(x.via || '(?)') || 0) + 1);
                const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
                pares.set(x.lancamento._id, {
                    arq: x.documento.arquivo, forca: x.forca, via: x.via,
                    valor: Math.abs(Number(x.lancamento.valor) || 0),
                    ent: String(x.lancamento.entidade || ''),
                    conf: fornecedorConfere(x.lancamento.entidade, x.documento.arquivo, o.emitente),
                });
            }
        }
        return { pares, forca, vias };
    }

    const A = rodar(antes), B = rodar(agora);

    console.log('═'.repeat(78));
    console.log('O MOTOR EDITADO × git HEAD');
    console.log('═'.repeat(78));
    console.log(`\n   pares: ${A.pares.size} → ${B.pares.size}   (${B.pares.size - A.pares.size})`);
    console.log('\n   força    antes   depois');
    for (const f of [3, 2, 1])
        console.log(`     ${f}    ${String(A.forca[f]).padStart(6)}  ${String(B.forca[f]).padStart(7)}   ${A.forca[f] === B.forca[f] ? '✓ igual' : (B.forca[f] - A.forca[f] > 0 ? '+' : '') + (B.forca[f] - A.forca[f])}`);

    console.log('\n   vias:');
    const todasVias = new Set([...A.vias.keys(), ...B.vias.keys()]);
    for (const v of todasVias)
        console.log(`      ${String(v).padEnd(24)} ${String(A.vias.get(v) || 0).padStart(5)} → ${String(B.vias.get(v) || 0).padStart(5)}`);

    // ── quem sumiu, quem apareceu, quem trocou ────────────────────────────
    let sumiram = 0, sumiuFalso = 0, sumiuBom = 0;
    let novos = 0, trocaram = 0, trocaMelhor = 0, trocaPior = 0;
    const exBom = [], exNovo = [];
    for (const [id, a] of A.pares) {
        const b = B.pares.get(id);
        if (!b) {
            sumiram++;
            if (a.conf === 'nao') sumiuFalso++;
            else { sumiuBom++; if (exBom.length < 8) exBom.push(a); }
            continue;
        }
        if (a.arq !== b.arq) {
            trocaram++;
            if (b.forca > a.forca) trocaMelhor++;
            else if (b.forca < a.forca) trocaPior++;
        }
    }
    for (const [id, b] of B.pares) if (!A.pares.has(id)) { novos++; if (exNovo.length < 8) exNovo.push(b); }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('O QUE MUDOU');
    console.log('═'.repeat(78));
    console.log(`\n   pares que SUMIRAM: ${sumiram}`);
    console.log(`      fornecedor NÃO batia (falso):  ${sumiuFalso}  ← ganho`);
    console.log(`      fornecedor batia/indecidível:  ${sumiuBom}  ← custo`);
    console.log(`   pares NOVOS:       ${novos}`);
    console.log(`   trocaram de documento: ${trocaram}   melhor: ${trocaMelhor}   pior: ${trocaPior}`);
    console.log(`\n   previsto: −142 falsos, −5 legítimos`);
    const bate = sumiuFalso === 142 && sumiuBom === 5;
    console.log(`   ${bate ? '✓ BATE com o previsto' : '⚠ divergiu — investigar'}`);

    if (exBom.length) {
        console.log('\n── os legítimos perdidos ───────────────────────────────────');
        for (const x of exBom) console.log(`   ${brl(x.valor).padStart(13)}  ${x.ent.slice(0, 32)}  ${x.arq.slice(0, 34)}`);
    }
    if (exNovo.length) {
        console.log('\n── pares NOVOS (documento liberado achou dono melhor) ──────');
        for (const x of exNovo) console.log(`   ${brl(x.valor).padStart(13)}  f${x.forca} ${x.via}  ${x.arq.slice(0, 40)}`);
    }

    // ── precisão ───────────────────────────────────────────────────────────
    const prec = m => {
        let b = 0, n = 0;
        for (const [, x] of m.pares) { if (x.conf === 'bate') b++; else if (x.conf === 'nao') n++; }
        return { b, n, p: pct(b, b + n) };
    };
    const pA = prec(A), pB = prec(B);
    console.log(`\n${'═'.repeat(78)}`);
    console.log('PRECISÃO DO PAINEL');
    console.log('═'.repeat(78));
    console.log(`\n   antes:  ${pA.b} batem / ${pA.n} não  →  ${pA.p}`);
    console.log(`   depois: ${pB.b} batem / ${pB.n} não  →  ${pB.p}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
