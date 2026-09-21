/**
 * _medir/_tipo-um-caso-so.js — UM caso, todos os candidatos, score a score.
 *
 * As agregações se contradizem e eu já errei duas hipóteses seguidas:
 *   • "o conserto só concede ponto, o empate preserva a ordem" → refutado
 *   • "a lista era montada duas vezes" → refutado (persistiu com lista fixa)
 *
 * Em `_tipo-desempate-veredito.js` sobrou uma anomalia LÓGICA: casos com
 * score 3 antes e 3 depois, com o mesmo nome de arquivo impresso, contados como
 * troca. Isso ou é bug do meu contador, ou há candidatos distintos com nome
 * truncado igual. Parar de agregar e abrir UM caso resolve
 * ([[inspecao-anima-medicao-decide]] ao contrário: aqui a inspeção é que decide).
 *
 * Imprime, para os números problemáticos, TODOS os candidatos com seus scores nas
 * duas versões — sem escolher nada.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function motorDe(src) {
    const corte = src.indexOf('module.exports');
    const requireRotas = require('module').createRequire(path.join(h.RAIZ, 'routes', 'x.js'));
    return new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return { tipoBate, valorBate, entidadeBate };
    `)(requireRotas, { exports: {} }, {}, path.join(h.RAIZ, 'routes'));
}

const ALVOS = new Set(['16873', '24988', '728062', '430936']);

(async () => {
    const A = motorDe(execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const D = motorDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8'));

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
              iD = cols.indexOf('dados_parser'), iC = cols.indexOf('cnpj'),
              iP = cols.indexOf('pasta');
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
            if (!num || !ALVOS.has(num)) continue;
            if (!porNumero.has(num)) porNumero.set(num, []);
            porNumero.get(num).push({
                arquivo, pasta: iP >= 0 ? String(f[iP] || '').trim() : '',
                tipo: String(f[iT] || '').trim(), valor, emitente,
                cnpj: iC >= 0 ? String(f[iC] || '').trim() : '',
            });
        }
    }

    for (const [num, g] of porNumero) {
        console.log(`\n${'═'.repeat(76)}`);
        console.log(`nº ${num} — ${g.length} candidatos no banco`);
        console.log('═'.repeat(76));
        for (let i = 0; i < g.length; i++) {
            const c = g[i];
            console.log(`  [${i}] tipo=${(c.tipo || '—').padEnd(9)} valor=${String(c.valor).padStart(10)}  ${c.arquivo}`);
            console.log(`      pasta=${c.pasta}  emitente=${String(c.emitente).slice(0, 40)}`);
        }

        // um cenário típico: planilha=NF, valor do primeiro candidato, entidade do primeiro
        const ent = g.find(c => c.emitente);
        const v = g.find(c => c.valor > 0);
        if (!ent || !v) { console.log('  (sem emitente ou valor — cenário não montável)'); continue; }
        const nota = { tipoBanco: 'NF', valor: v.valor, valorItem: 0, itens: [], entidade: norm(ent.emitente), cnpj: '' };
        console.log(`\n  cenário: planilha tipo=NF valor=${nota.valor} entidade=${nota.entidade.slice(0, 34)}`);

        // guard
        const compat = g.filter(c => (c.emitente || c.cnpj)
            ? A.entidadeBate(c.emitente, c.cnpj, nota.entidade, nota.cnpj)
            : (!(c.valor > 0) || A.valorBate(c.valor, nota).ok));
        const cands = compat.length > 0 ? compat : g.filter(c => A.valorBate(c.valor, nota).ok);
        console.log(`  candidatos após o guard de entidade: ${cands.length} de ${g.length}`);

        console.log('\n  idx  vOk   tOk(antes) tOk(depois)  score antes → depois   arquivo');
        let mA = null, mD = null;
        for (let i = 0; i < cands.length; i++) {
            const c = cands[i];
            const vOk = A.valorBate(c.valor, nota).ok;
            const tA = A.tipoBate(c.tipo, nota, c), tD = D.tipoBate(c.tipo, nota, c);
            const sA = (vOk ? 2 : 0) + (tA ? 1 : 0), sD = (vOk ? 2 : 0) + (tD ? 1 : 0);
            if (!mA || sA > mA.s) mA = { i, s: sA, c };
            if (!mD || sD > mD.s) mD = { i, s: sD, c };
            console.log(`  ${String(i).padStart(3)}  ${String(vOk).padEnd(5)} ${String(tA).padEnd(10)} ${String(tD).padEnd(11)} ${sA} → ${sD}                  ${c.arquivo.slice(0, 30)}`);
        }
        console.log(`\n  vencedor ANTES : idx ${mA.i} (score ${mA.s})  ${mA.c.arquivo}`);
        console.log(`  vencedor DEPOIS: idx ${mD.i} (score ${mD.s})  ${mD.c.arquivo}`);
        console.log(`  → ${mA.c.arquivo === mD.c.arquivo ? 'MESMO documento' : '⚠ DOCUMENTO DIFERENTE'}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
