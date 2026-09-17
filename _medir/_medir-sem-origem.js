/**
 * _medir/_medir-sem-origem.js — os 2.228 sem `Origem do valor pago` são MESMO
 * documentos que não passaram por `decidirValorPago`?
 *
 * A medição de 17/09 concluiu que 78% do acervo "nunca passou pela função", porque a
 * coluna está vazia. Mas `decidirValorPago` É chamada no caminho local
 * (process-folder.js:976). Então a ausência da coluna tem outra explicação — e a
 * conclusão anterior pode estar errada.
 *
 * Hipóteses a separar:
 *   A. a linha é ANTIGA, gravada antes de a chamada existir no caminho local
 *   B. `parserData` era null/vazio → o `if` não entrou
 *   C. a visão marcou o valor como não-confiável → o `if` recusa de propósito
 *   D. a função entrou mas não achou candidato e devolveu `pd` sem tocar na origem
 *
 * Distinguir importa porque muda o conserto: (A) é só reler, (D) é a regra não ter o
 * que escolher, e nenhum dos dois se resolve "fazendo a função rodar".
 *
 * Uso: node _medir/_medir-sem-origem.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const { paraNumero, valorPorPrecedencia } = require('../routes/_valor-do-pagamento');

(async () => {
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT PERIODO, CONTEUDO, ATUALIZADO_EM FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    const c = { total: 0, comOrigem: 0, semOrigem: 0,
                b_vazio: 0, c_visaoDuvidou: 0, d_semCandidato: 0, restante: 0 };
    const porTipo = new Map();
    const restantes = [];

    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || /#p\d+$/i.test(row.arquivo)) continue;
            let pd = null;
            try { pd = JSON.parse(row.dados_parser || 'null'); } catch (_) {}
            c.total++;

            if (pd && pd['Origem do valor pago']) { c.comOrigem++; continue; }
            c.semOrigem++;

            if (!pd || !Object.keys(pd).length) { c.b_vazio++; continue; }
            if (pd['Valor lido (não confere com o nome)']) { c.c_visaoDuvidou++; continue; }

            // D: a função entraria, mas `valorPorPrecedencia` não acha candidato →
            // devolve `pd` intacto, sem gravar origem.
            const r = valorPorPrecedencia(pd);
            if (r.valor == null) { c.d_semCandidato++; continue; }

            c.restante++;
            const t = row.tipo || '(sem tipo)';
            porTipo.set(t, (porTipo.get(t) || 0) + 1);
            if (restantes.length < 10) restantes.push({ p: rec.PERIODO, a: row.arquivo, tipo: t, origem: r.origem, v: r.valor });
        }
    }

    console.log(`══ POR QUE A ORIGEM ESTÁ VAZIA ══════════════════════════`);
    console.log(`   linhas (sem #pN)          : ${c.total}`);
    console.log(`   COM origem gravada        : ${c.comOrigem}`);
    console.log(`   sem origem                : ${c.semOrigem}\n`);
    console.log(`   B. dados_parser vazio/null: ${c.b_vazio}`);
    console.log(`   C. visão duvidou do valor : ${c.c_visaoDuvidou}`);
    console.log(`   D. sem candidato de valor : ${c.d_semCandidato}`);
    console.log(`   → restante inexplicado    : ${c.restante}   ← só isto seria "não rodou"`);

    if (c.restante) {
        console.log(`\n   restante por tipo:`);
        for (const [t, n] of [...porTipo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
            console.log(`      ${String(t).slice(0, 34).padEnd(34)} ${n}`);
        }
        console.log(`\n   exemplos:`);
        for (const r of restantes) {
            console.log(`      ${r.p}  [${r.tipo}]  ${r.origem} = ${r.v}`);
            console.log(`         ${r.a.slice(0, 68)}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
