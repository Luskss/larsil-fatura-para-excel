/**
 * _medir/_tipo-desempate-veredito.js — o veredito final, com a ORDEM preservada.
 *
 * O QUE A ANATOMIA REVELOU (21/09/2026): dos 64 cenários, 54 "trocas reais" têm
 * uma assinatura que denuncia o simulador, não o conserto:
 *
 *     nº 24988  antes [score 3] NF ...  depois [score 3] FATURA ...
 *
 * MESMO score nos dois lados. Com `score > melhor.score` (estrito), empate
 * preserva o primeiro da lista — logo o vencedor NÃO poderia mudar. Ele mudou
 * porque `escolher()` aplica o GUARD DE ENTIDADE antes, e o guard usa
 * `M.valorBate`/`M.entidadeBate` de cada versão: como os dois motores são objetos
 * distintos, o `filter` devolve arrays com ORDEM/CONTEÚDO possivelmente diferentes,
 * e o "primeiro da lista" deixa de ser o mesmo.
 *
 * Ou seja: eu comparava duas listas montadas separadamente, e atribuía ao conserto
 * uma diferença de ordenação que ele não causa.
 *
 * ── O teste correto ─────────────────────────────────────────────────────────
 * Montar a lista de candidatos UMA vez (com o motor ANTES, que é o estado atual de
 * produção) e rodar SÓ o laço de desempate com as duas versões de `tipoBate`.
 * Assim a única variável é o conserto.
 *
 * Complemento: contar em quantos cenários os SCORES mudam de ordem relativa —
 * porque é isso, e só isso, que o conserto pode alterar.
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

    // guard de entidade — UMA vez, com o motor de produção (A)
    const filtrar = (cands, nota) => {
        if (!(cands.length > 0 && nota.entidade)) return cands;
        const compat = cands.filter(c =>
            (c.emitente || c.cnpj)
                ? A.entidadeBate(c.emitente, c.cnpj, nota.entidade, nota.cnpj)
                : (!(c.valor > 0) || A.valorBate(c.valor, nota).ok));
        return compat.length > 0 ? compat : cands.filter(c => A.valorBate(c.valor, nota).ok);
    };
    // o laço de desempate, variando APENAS tipoBate
    const desempatar = (cands, nota, tipoBate) => {
        let melhor = null;
        for (const c of cands) {
            const vOk = A.valorBate(c.valor, nota).ok;
            const tOk = tipoBate(c.tipo, nota, c);
            const score = (vOk ? 2 : 0) + (tOk ? 1 : 0);
            if (!melhor || score > melhor.score) melhor = { c, score };
        }
        return melhor;
    };

    const TIPOS_PLAN = ['NF', 'NFS', 'FATURA', 'IMPOSTO', '*', ''];
    let cenarios = 0, trocou = 0, subiuScore = 0;
    const exemplos = [];

    for (const [num, g] of porNumero) {
        if (g.length < 2) continue;
        const valores = [...new Set(g.map(c => c.valor).filter(v => v > 0))];
        if (!valores.length) valores.push(0);
        const entidades = [...new Set(g.map(c => c.emitente).filter(Boolean))];
        if (!entidades.length) continue;
        for (const tp of TIPOS_PLAN) for (const v of valores) for (const ent of entidades) {
            const nota = { tipoBanco: tp, valor: v, valorItem: 0, itens: [], entidade: norm(ent), cnpj: '' };
            const cands = filtrar(g, nota);          // ← lista ÚNICA, montada uma vez
            cenarios++;
            const a = desempatar(cands, nota, A.tipoBate);
            const d = desempatar(cands, nota, D.tipoBate);
            if (a && d && d.score > a.score) subiuScore++;
            const arqA = a && a.c.arquivo, arqD = d && d.c.arquivo;
            if (arqA !== arqD) {
                trocou++;
                if (exemplos.length < 10) exemplos.push({ num, tp, v, ent, arqA, arqD,
                    sa: a && a.score, sd: d && d.score });
            }
        }
    }

    console.log('── desempate com a LISTA DE CANDIDATOS FIXA ─────────────────');
    console.log('   (guard de entidade rodado UMA vez; só tipoBate varia)\n');
    console.log(`  cenários testados:                 ${cenarios}`);
    console.log(`  vencedor MUDOU de arquivo:         ${trocou}`);
    console.log(`  vencedor só GANHOU ponto de tipo:  ${subiuScore}  (mesmo documento, score maior)`);

    if (exemplos.length) {
        console.log('\n  trocas remanescentes:');
        for (const e of exemplos) {
            console.log(`    nº ${e.num} planilha=${e.tp || '(vazio)'} valor=${e.v}`);
            console.log(`      antes  [${e.sa}] ${String(e.arqA).slice(0, 50)}`);
            console.log(`      depois [${e.sd}] ${String(e.arqD).slice(0, 50)}`);
        }
    }

    console.log(trocou === 0
        ? '\n→ VEREDITO: o conserto NUNCA muda o documento escolhido.\n'
          + '  As 54 "trocas" de _tipo-desempate-fiel.js eram artefato do simulador:\n'
          + '  eu montava a lista de candidatos duas vezes, com motores diferentes,\n'
          + '  e a diferença de ORDEM virava "troca de vencedor".\n'
          + '  O conserto só eleva o score do MESMO vencedor — o par fica intacto.'
        : '\n→ ⚠ ainda troca; investigar.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
