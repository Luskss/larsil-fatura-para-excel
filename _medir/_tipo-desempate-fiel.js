/**
 * _medir/_tipo-desempate-fiel.js — o desempate, com o FLUXO REAL, não o meu.
 *
 * ERRO ANTERIOR (21/09/2026): `_tipo-desempate-real.js` acusou 38 cenários com
 * troca de vencedor e me fez suspeitar do conserto. Mas o simulador daquele script
 * era infiel ao fluxo de `_baseline.js:925-964` em dois pontos decisivos:
 *
 *   1. OMITIU o GUARD DE ENTIDADE (linhas 935-953). No fluxo real, candidatos de
 *      emitente incompatível são REMOVIDOS antes do desempate. Meus grupos juntavam
 *      SANCOR com SANCOE, APÓLICE BRADESCO de janeiro com a de abril — documentos
 *      que a produção nunca põe na mesma disputa.
 *   2. USOU um `vOk` sintético (|dif| <= 0,02) em vez do `valorBate` real, que
 *      aceita soma de itens, parcela e fração total÷N.
 *
 * Um simulador mais frouxo que o código inventa disputas que não existem — a mesma
 * família de erro de [[gabarito-frouxo-inventa-erro]], agora no motor em vez da régua.
 *
 * Aqui os dois pontos vêm do FONTE, extraídos por recorte, e o veredito é refeito.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Avalia o CORPO INTEIRO do fonte (tudo antes do `module.exports`) e devolve as
// funções que o desempate usa. Recortar função por função é frágil — cada uma
// arrasta helpers (entidadeBate → entidadeMatch → ...) e o que falta vira
// ReferenceError ou, pior, um motor mais frouxo que o real. Mesma técnica de
// `harness.internasDaRota`.
function motorDe(src, rotulo) {
    const corte = src.indexOf('module.exports');
    if (corte < 0) throw new Error(`não achei module.exports em ${rotulo}`);
    const corpo = src.slice(0, corte);
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname', `
        ${corpo}
        return { tipoBate, valorBate, entidadeBate };
    `);
    return f(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');

    let A, D;
    try { A = motorDe(antesSrc, 'HEAD'); D = motorDe(depoisSrc, 'disco'); }
    catch (e) {
        console.log('não consegui recortar o motor do fonte:', e.message);
        console.log('\nsem isso a simulação seria MENOS fiel que o código — e foi exatamente');
        console.log('assim que _tipo-desempate-real.js produziu 38 falsos alarmes.');
        process.exit(1);
    }
    console.log('motor recortado do fonte: tipoBate + valorBate + entidadeBate (HEAD e disco)\n');

    // ── candidatos REAIS do banco ──────────────────────────────────────────
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

    const separar = (linha) => {
        const out = []; let atual = '', aspas = false;
        for (let i = 0; i < linha.length; i++) {
            const ch = linha[i];
            if (aspas) {
                if (ch === '"') { if (linha[i + 1] === '"') { atual += '"'; i++; } else aspas = false; }
                else atual += ch;
            } else if (ch === '"') aspas = true;
            else if (ch === ';') { out.push(atual); atual = ''; }
            else atual += ch;
        }
        out.push(atual); return out;
    };

    const porNumero = new Map();
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iT = cols.indexOf('tipo'),
              iD = cols.indexOf('dados_parser'), iC = cols.indexOf('cnpj');
        if (iA < 0 || iT < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = separar(ls[i]);
            const arquivo = String(f[iA] || '').trim();
            if (!arquivo) continue;
            let num = '', valor = 0, emitente = '';
            const bruto = iD >= 0 ? (f[iD] || '').trim() : '';
            if (bruto.startsWith('{')) {
                try {
                    const d = JSON.parse(bruto);
                    for (const k of ['Nº da NF-e', 'Nº do CT-e', 'Nº da NFS-e', 'Número do documento', 'Numero da NF'])
                        if (d[k] && d[k] !== '—') { num = String(d[k]).replace(/\D/g, ''); break; }
                    for (const k of ['Valor total da nota', 'Valor total', 'Valor da prestação', 'Valor do boleto'])
                        if (d[k] && d[k] !== '—') {
                            let s = String(d[k]).replace(/^R\$\s*/i, '').replace(/\s/g, '');
                            if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
                            const n = Number(s); if (isFinite(n) && n > 0) { valor = n; break; }
                        }
                    for (const k of ['Emitente', 'Razão social', 'Nome do emitente'])
                        if (d[k] && d[k] !== '—') { emitente = String(d[k]); break; }
                } catch (e) {}
            }
            if (!num) continue;
            if (!porNumero.has(num)) porNumero.set(num, []);
            porNumero.get(num).push({
                arquivo, tipo: String(f[iT] || '').trim(), valor, emitente,
                cnpj: iC >= 0 ? String(f[iC] || '').trim() : '',
            });
        }
    }

    const grupos = [...porNumero.entries()].filter(([, g]) => g.length >= 2);
    console.log(`números com 2+ candidatos: ${grupos.length}`);

    // ── o fluxo REAL: guard de entidade, depois desempate ───────────────────
    const escolher = (cands0, nota, M) => {
        let candidatos = cands0;
        // guard de entidade (linhas 935-953), idêntico ao fonte
        if (candidatos.length > 0 && nota.entidade) {
            const compat = candidatos.filter(c =>
                (c.emitente || c.cnpj)
                    ? M.entidadeBate(c.emitente, c.cnpj, nota.entidade, nota.cnpj)
                    : (!(c.valor > 0) || M.valorBate(c.valor, nota).ok));
            candidatos = compat.length > 0 ? compat
                                           : candidatos.filter(c => M.valorBate(c.valor, nota).ok);
        }
        let melhor = null;
        for (const c of candidatos) {
            const vOk = M.valorBate(c.valor, nota).ok;
            const tOk = M.tipoBate(c.tipo, nota, c);
            const score = (vOk ? 2 : 0) + (tOk ? 1 : 0);
            if (!melhor || score > melhor.score) melhor = { c, score };
        }
        return melhor;
    };

    const TIPOS_PLAN = ['NF', 'NFS', 'FATURA', 'IMPOSTO', '*', ''];
    let cenarios = 0, divergiram = 0, semGuard = 0;
    const exemplos = [];

    for (const [, g] of grupos) {
        const valores = [...new Set(g.map(c => c.valor).filter(v => v > 0))];
        if (!valores.length) valores.push(0);
        // o lançamento traz a ENTIDADE — no fluxo real ela sempre existe. Usamos o
        // emitente de cada candidato como entidade plausível do lançamento.
        const entidades = [...new Set(g.map(c => c.emitente).filter(Boolean))];
        if (!entidades.length) { semGuard += TIPOS_PLAN.length * valores.length; continue; }
        for (const tp of TIPOS_PLAN) {
            for (const v of valores) {
                for (const ent of entidades) {
                    const nota = { tipoBanco: tp, valor: v, valorItem: 0, itens: [], entidade: norm(ent), cnpj: '' };
                    cenarios++;
                    const a = escolher(g, nota, A), d = escolher(g, nota, D);
                    const arqA = a && a.c.arquivo, arqD = d && d.c.arquivo;
                    if (arqA !== arqD) {
                        divergiram++;
                        if (exemplos.length < 8) exemplos.push({
                            tp, v, ent: ent.slice(0, 26),
                            antes: `${a ? a.c.tipo : '—'} ${(arqA || '(nenhum)').slice(0, 46)}`,
                            depois: `${d ? d.c.tipo : '—'} ${(arqD || '(nenhum)').slice(0, 46)}`,
                        });
                    }
                }
            }
        }
    }

    console.log(`cenários testados (com guard de entidade): ${cenarios}`);
    console.log(`cenários pulados (nenhum candidato tem emitente): ${semGuard}`);
    console.log(`\ncenários em que o VENCEDOR muda: ${divergiram}\n`);
    for (const e of exemplos) {
        console.log(`  planilha=${e.tp || '(vazio)'} valor=${e.v} entidade=${e.ent}`);
        console.log(`    antes : ${e.antes}`);
        console.log(`    depois: ${e.depois}`);
    }
    console.log(divergiram === 0
        ? '→ CONFIRMADO: com o guard de entidade do fluxo real, o vencedor NUNCA muda.\n  Os 38 casos de _tipo-desempate-real.js eram disputas que a produção não faz.'
        : '→ ⚠ ainda há troca de vencedor; investigar caso a caso.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
