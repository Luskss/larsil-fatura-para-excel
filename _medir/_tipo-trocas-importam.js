/**
 * _medir/_tipo-trocas-importam.js — as 64 trocas mudam o que o usuário vê?
 *
 * A INSPEÇÃO (`_tipo-um-caso-so.js`) explicou o mecanismo, e ele é real: quando
 * vários candidatos empatam em valor e NENHUM tinha o ponto de tipo, o conserto
 * concede o ponto a UM deles (o que tem "+BOL" e está como FATURA) e esse passa
 * à frente. Exemplo nº 728062: 6 parcelas mensais do MESMO seguro, mesmo número,
 * mesmo valor R$ 684,63 — o vencedor pula de 003 (janeiro) para 059 (abril).
 *
 * Mas "documento diferente" não é o mesmo que "pior". Nesses grupos o motor JÁ era
 * arbitrário: os candidatos são indistinguíveis por valor e número, e a escolha
 * antiga vinha da ordem do CSV, não de mérito. É o caso 1↔N de
 * [[parcela-1-para-n-pendente]] — anterior ao conserto e não causado por ele.
 *
 * ── A pergunta que decide ───────────────────────────────────────────────────
 * Existe alguma troca em que o vencedor NOVO seja PIOR que o antigo por um
 * critério independente do tipo? Dois critérios:
 *
 *   a) VALOR: o novo bate o valor do lançamento tão bem quanto o antigo?
 *   b) MÊS: a pasta do novo é mais distante do mês do lançamento que a do antigo?
 *      (o painel confere um mês; trocar janeiro por abril importa)
 *
 * Se as trocas forem todas entre candidatos empatados em valor E o mês não piorar,
 * elas são ruído de desempate. Se o mês piorar, o conserto tem custo real.
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
// "2026.02.EXTRATOS.../SANTANDER/2026.02.18" → "02.2026"
function mesDaPasta(p) {
    const m = String(p || '').match(/(20\d{2})\.(\d{2})/);
    return m ? `${m[2]}.${m[1]}` : '';
}

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
            if (!num) continue;
            if (!porNumero.has(num)) porNumero.set(num, []);
            porNumero.get(num).push({
                arquivo, pasta: iP >= 0 ? String(f[iP] || '').trim() : '',
                tipo: String(f[iT] || '').trim(), valor, emitente,
                cnpj: iC >= 0 ? String(f[iC] || '').trim() : '',
            });
        }
    }

    const TIPOS_PLAN = ['NF', 'NFS', 'FATURA', 'IMPOSTO', '*', ''];
    let trocas = 0, valorIgual = 0, valorPior = 0, mesmoMes = 0, mesDiferente = 0;
    const grupoDeTroca = new Set();
    const piores = [];

    for (const [num, g] of porNumero) {
        if (g.length < 2) continue;
        const valores = [...new Set(g.map(c => c.valor).filter(v => v > 0))];
        if (!valores.length) continue;
        const entidades = [...new Set(g.map(c => c.emitente).filter(Boolean))];
        if (!entidades.length) continue;

        for (const tp of TIPOS_PLAN) for (const v of valores) for (const ent of entidades) {
            const nota = { tipoBanco: tp, valor: v, valorItem: 0, itens: [], entidade: norm(ent), cnpj: '' };
            const compat = g.filter(c => (c.emitente || c.cnpj)
                ? A.entidadeBate(c.emitente, c.cnpj, nota.entidade, nota.cnpj)
                : (!(c.valor > 0) || A.valorBate(c.valor, nota).ok));
            const cands = compat.length > 0 ? compat : g.filter(c => A.valorBate(c.valor, nota).ok);

            const pick = (tipoBate) => {
                let m = null;
                for (const c of cands) {
                    const vOk = A.valorBate(c.valor, nota).ok;
                    const score = (vOk ? 2 : 0) + (tipoBate(c.tipo, nota, c) ? 1 : 0);
                    if (!m || score > m.score) m = { c, score, vOk };
                }
                return m;
            };
            const a = pick(A.tipoBate), d = pick(D.tipoBate);
            if (!a || !d || a.c.arquivo === d.c.arquivo) continue;
            trocas++;
            grupoDeTroca.add(num);

            // (a) o novo bate o valor tão bem quanto o antigo?
            if (a.vOk === d.vOk) valorIgual++;
            else if (a.vOk && !d.vOk) { valorPior++; piores.push({ num, tp, v, a: a.c, d: d.c, motivo: 'valor' }); }

            // (b) o mês mudou?
            const mA = mesDaPasta(a.c.pasta), mD = mesDaPasta(d.c.pasta);
            if (mA === mD) mesmoMes++; else mesDiferente++;
        }
    }

    console.log('── as trocas, avaliadas por critério INDEPENDENTE do tipo ────');
    console.log(`  cenários com troca de documento: ${trocas}`);
    console.log(`  números (grupos) envolvidos:     ${grupoDeTroca.size}  → ${[...grupoDeTroca].join(', ')}`);
    console.log('\n  (a) VALOR:');
    console.log(`      novo bate o valor IGUAL ao antigo: ${valorIgual}`);
    console.log(`      novo bate o valor PIOR que o antigo: ${valorPior}`);
    console.log('\n  (b) MÊS da pasta:');
    console.log(`      mesmo mês:      ${mesmoMes}`);
    console.log(`      mês diferente:  ${mesDiferente}`);

    if (piores.length) {
        console.log('\n  ⚠ trocas em que o novo é PIOR no valor:');
        for (const p of piores.slice(0, 10))
            console.log(`    nº ${p.num}: ${p.a.arquivo.slice(0, 40)} → ${p.d.arquivo.slice(0, 40)}`);
    }

    console.log('\nLEITURA: se o valor nunca piora e a troca só ocorre entre candidatos');
    console.log('empatados, o conserto não degrada o par — ele reordena um empate que o');
    console.log('motor já resolvia arbitrariamente (caso 1↔N). Se o MÊS muda, porém, o');
    console.log('painel do mês conferido pode exibir outro documento: isso é visível.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
