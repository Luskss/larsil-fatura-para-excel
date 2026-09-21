/**
 * _medir/_tipo-desempate-anatomia.js — os 64 casos, um a um: o que são?
 *
 * `_tipo-desempate-fiel.js` (com guard de entidade e motor do fonte) manteve 64
 * cenários em que o vencedor muda. Antes de reverter o conserto, é preciso saber
 * o que são — o primeiro exemplo impresso já sugere artefato:
 *
 *     antes : NF     012.DOC- 897,20-2026.12.02.COMERCIAL . NF 1687
 *     depois: FATURA 012.DOC- 897,20-2026.12.02.COMERCIAL . NF 1687
 *
 * É o MESMO ARQUIVO nos dois lados. O "vencedor" não trocou de documento: trocou
 * de LINHA do CSV (o mesmo PDF aparece mais de uma vez no banco, com tipos
 * diferentes) ou o desempate 2↔2 se resolveu por ordem. Nenhum dos dois muda o
 * par que o usuário vê.
 *
 * ── A classificação ─────────────────────────────────────────────────────────
 *   MESMO ARQUIVO    → artefato: o par não muda
 *   ARQUIVO DIFERENTE, mesmo valor, mesma entidade → empate real; qual é melhor?
 *   ARQUIVO DIFERENTE, valores/entidades distintos → troca de verdade (grave)
 *
 * E, para os que trocam mesmo: o cenário é REAL? Esta simulação varre TODOS os
 * tipos de planilha × TODOS os valores × TODAS as entidades do grupo, inclusive
 * combinações que a planilha nunca produz. O teste final é se o par existe no
 * acervo de verdade.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function motorDe(src, rotulo) {
    const corte = src.indexOf('module.exports');
    if (corte < 0) throw new Error(`não achei module.exports em ${rotulo}`);
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    return new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return { tipoBate, valorBate, entidadeBate };
    `)(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

(async () => {
    const antesSrc = execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const depoisSrc = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const A = motorDe(antesSrc, 'HEAD'), D = motorDe(depoisSrc, 'disco');

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

    const escolher = (cands0, nota, M) => {
        let candidatos = cands0;
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
    const cls = { mesmoArquivo: 0, trocaReal: 0 };
    const trocas = [];

    for (const [num, g] of porNumero) {
        if (g.length < 2) continue;
        const valores = [...new Set(g.map(c => c.valor).filter(v => v > 0))];
        if (!valores.length) valores.push(0);
        const entidades = [...new Set(g.map(c => c.emitente).filter(Boolean))];
        if (!entidades.length) continue;
        for (const tp of TIPOS_PLAN) for (const v of valores) for (const ent of entidades) {
            const nota = { tipoBanco: tp, valor: v, valorItem: 0, itens: [], entidade: norm(ent), cnpj: '' };
            const a = escolher(g, nota, A), d = escolher(g, nota, D);
            const arqA = a && a.c.arquivo, arqD = d && d.c.arquivo;
            if (arqA === arqD) continue;
            if (String(arqA).replace(/#p\d+$/i, '') === String(arqD).replace(/#p\d+$/i, '')) {
                cls.mesmoArquivo++;   // mesma origem, linha/página diferente
                continue;
            }
            cls.trocaReal++;
            trocas.push({ num, tp, v, ent, arqA, arqD,
                          scoreA: a && a.score, scoreD: d && d.score,
                          tipoA: a && a.c.tipo, tipoD: d && d.c.tipo,
                          valA: a && a.c.valor, valD: d && d.c.valor });
        }
    }

    console.log('── anatomia dos cenários com vencedor diferente ──────────────');
    console.log(`  MESMO arquivo (outra linha/página do mesmo PDF): ${cls.mesmoArquivo}  → o par não muda`);
    console.log(`  ARQUIVO REALMENTE diferente:                     ${cls.trocaReal}`);

    if (trocas.length) {
        console.log('\n── as trocas reais ──────────────────────────────────────────');
        for (const t of trocas.slice(0, 14)) {
            console.log(`\n  nº ${t.num}  planilha=${t.tp || '(vazio)'}  valor=${t.v}  entidade=${String(t.ent).slice(0, 30)}`);
            console.log(`    antes  [score ${t.scoreA}] ${t.tipoA} R$${t.valA}  ${String(t.arqA).slice(0, 52)}`);
            console.log(`    depois [score ${t.scoreD}] ${t.tipoD} R$${t.valD}  ${String(t.arqD).slice(0, 52)}`);
            const mesmoValor = Math.abs((t.valA || 0) - (t.valD || 0)) < 0.01;
            console.log(`    → valores ${mesmoValor ? 'IGUAIS (empate real, decidido por ordem)' : 'DIFERENTES'}`);
        }
        // quantas trocas são entre candidatos de MESMO valor (empate puro)?
        const empate = trocas.filter(t => Math.abs((t.valA || 0) - (t.valD || 0)) < 0.01).length;
        console.log(`\n  trocas entre candidatos de MESMO valor: ${empate} de ${trocas.length}`);
        console.log('  (nessas o motor já era arbitrário: dois documentos igualmente válidos)');
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
