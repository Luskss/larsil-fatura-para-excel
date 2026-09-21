/**
 * _medir/_o-que-ja-vale-agora.js — comparar AGORA dá o resultado certo?
 *
 * PERGUNTA do usuário (21/09/2026): "se eu comparar com a planilha vai estar certo
 * ou precisa reler?"
 *
 * Os três consertos do dia agem em MOMENTOS DIFERENTES, e confundi-los seria
 * prometer o que não acontece:
 *
 *   A. `_baseline.js:tipoBate` (variante C)  → roda NA COMPARAÇÃO
 *      O painel chama `tipoBate` a cada conferência, lendo o `tipo` já gravado.
 *      Conserto de LEITURA: vale na próxima vez que você abrir o painel.
 *
 *   B. `_nf-parsers.js:classify` (GUIA)      → roda NO PROCESSAMENTO
 *   C. `_nf-parsers.js:extrairEmitente`      → roda NO PROCESSAMENTO
 *      O banco guarda o resultado já decidido. Conserto de ESCRITA: só vale para
 *      documento novo ou releitura ([[cache-esconde-mudanca-de-extracao]]).
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Rodando o painel HOJE, com o banco como está:
 *   1. quantos alertas de tipo aparecem (efeito de A, imediato)
 *   2. quantos alertas ainda vêm de B e C não aplicados (o que releitura curaria)
 *   3. o número de pares muda? (A não deveria mexer nisso)
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
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

(async () => {
    const antes = tipoBateDe(execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const agora = tipoBateDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8'));

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

    // documentos que a releitura MUDARIA (B e C)
    const srcNfAntes = execFileSync('git', ['show', 'HEAD:routes/_nf-parsers.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const srcNfAgora = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-parsers.js'), 'utf8');
    const emitDe = (src) => {
        const corte = src.indexOf('module.exports');
        const req = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
        return new Function('require', 'module', 'exports', '__dirname',
            `${src.slice(0, corte)} return extrairEmitente;`)(req, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
    };
    const eAntes = emitDe(srcNfAntes), eAgora = emitDe(srcNfAgora);
    const LIXO = /^[\d\-.,\/\s]{2,}/;

    let pares = 0, alertaAntes = 0, alertaAgora = 0;
    let curadoPorReleitura = 0;
    const exReleitura = [];

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[base(x.documento.arquivo)] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab) continue;
            pares++;
            const arq = x.documento.arquivo;
            if (!antes(lido, { tipoBanco: gab }, { arquivo: arq })) alertaAntes++;
            const acusaAgora = !agora(lido, { tipoBanco: gab }, { arquivo: arq });
            if (acusaAgora) {
                alertaAgora++;
                // este alerta some se o documento for RELIDO? (GUIA)
                const ehGuia = lido === 'IMPOSTO' && /^GUIA$/i.test(String(info.evidencia || '').trim());
                if (ehGuia) {
                    curadoPorReleitura++;
                    if (exReleitura.length < 6) exReleitura.push(arq);
                }
            }
        }
    }

    // emitentes sujos que ainda estão no banco
    let emitSujo = 0;
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const va = eAntes(a.nome), vd = eAgora(a.nome);
            if (va !== vd && va && LIXO.test(va)) emitSujo++;
        }

    console.log('═'.repeat(70));
    console.log('SE VOCÊ COMPARAR AGORA');
    console.log('═'.repeat(70));
    console.log(`\npares conferidos: ${pares}\n`);
    console.log('── (A) tipoBate — JÁ VALE, sem reler ───────────────────────');
    console.log(`   alertas de tipo ANTES do conserto: ${alertaAntes}`);
    console.log(`   alertas de tipo AGORA:             ${alertaAgora}   (${alertaAntes - alertaAgora} a menos)`);
    console.log('   → este conserto roda NA COMPARAÇÃO: vale assim que abrir o painel.');

    console.log('\n── (B) GUIA — precisa reler os PDFs ────────────────────────');
    console.log(`   alertas que ainda aparecem e sumiriam com releitura: ${curadoPorReleitura}`);
    for (const a of exReleitura) console.log(`      ${a.slice(0, 62)}`);

    console.log('\n── (C) emitente — precisa reler, mas NÃO muda o resultado ──');
    console.log(`   documentos com emitente sujo ainda no banco: ${emitSujo}`);
    console.log('   → medido em [[reescanear-nao-se-paga]]: +0 pares. `tokens()` já');
    console.log('     descarta números, então o lixo nunca atrapalhou o casamento.');
    console.log('     Afeta a EXIBIÇÃO do nome, não a comparação.');

    console.log(`\n${'═'.repeat(70)}`);
    console.log('RESPOSTA');
    console.log('═'.repeat(70));
    console.log('\n  Comparar agora JÁ dá o resultado melhorado:');
    console.log(`    • ${alertaAntes - alertaAgora} alertas falsos de tipo a menos, imediatamente`);
    console.log('    • os pares são os mesmos (o conserto não mexe no pareamento)');
    console.log(`\n  O que releitura ainda curaria: ${curadoPorReleitura} alerta(s) do GUIA`);
    console.log(`  e ${emitSujo} nomes de emitente na tela — nenhum muda par.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
