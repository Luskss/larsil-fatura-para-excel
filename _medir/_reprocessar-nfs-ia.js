/**
 * _medir/_reprocessar-nfs-ia.js — manda para a IA as notas que ficaram sem itens.
 *
 * Pedido do usuário (11/09/2026): "pode mandar essas notas para IA".
 *
 * ── Por que estas notas ──────────────────────────────────────────────────────
 * `extrairItens` (`_nf-itens.js:489` e `:513`) exige NCM para reconhecer linha de
 * item. NCM é código de MERCADORIA; NFS-e é de SERVIÇO e não traz NCM. Medido em 542
 * NFS-e com texto nativo: o extrator local gravou itens em **0** delas; as 67 que
 * têm vieram todas da IA, a maioria com NCM vazio.
 *
 * Provado no caso da NFS 886 (DALIANI): a IA leu 3 itens somando exatamente 72,57,
 * o total da nota, onde o extrator local devolveu zero.
 *
 * ── Por que arquivo a arquivo, e não `forceAI` na pasta ──────────────────────
 * `processFolderAuto({forceAI})` releria TUDO que não tem origem "IA" — 2.836
 * documentos nos 6 períodos. O alvo são 294. Este script usa as mesmas peças da rota
 * (`analyzePdf` + `upsertRelatorio`) sobre a lista exata, como
 * `_reprocessar-arquivos.js` já fazia para o bug da TRAVA.
 *
 * `upsertRelatorio` faz merge por `arquivo|pasta` e preserva as linhas ausentes do
 * lote, tratando parcelas `#pN` como bloco ([[parcelas-pn-sobram-no-upsert]]).
 *
 * ── Segurança ────────────────────────────────────────────────────────────────
 * Dry-run por padrão. Com `--confirmar`, grava. Confere ANTES e DEPOIS de cada
 * documento e recusa a gravação de uma linha que PERCA o valor que já tinha —
 * sobrescrever leitura boa é o dano de [[ocr-cai-com-medicoes-em-paralelo]].
 *
 * Uso:
 *   node _medir/_reprocessar-nfs-ia.js                 (dry-run, todos os períodos)
 *   node _medir/_reprocessar-nfs-ia.js 03.2026         (um período)
 *   node _medir/_reprocessar-nfs-ia.js --confirmar     (grava)
 *   node _medir/_reprocessar-nfs-ia.js --limite 5      (teste curto)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const args = process.argv.slice(2);
const CONFIRMAR = args.includes('--confirmar');
const periodos = args.filter(a => /^\d{2}\.\d{4}$/.test(a));
const li = args.indexOf('--limite');
const LIMITE = li >= 0 ? parseInt(args[li + 1], 10) : Infinity;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

(async () => {
    const pool = await getConnection();
    const q = periodos.length
        ? await pool.request().input('t', sql.Char(1), 'M')
            .query(`SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO IN (${periodos.map(p => `'${p}'`).join(',')})`)
        : await pool.request().input('t', sql.Char(1), 'M')
            .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');

    // Alvos: NFS sem itens que ainda não passaram pela IA.
    const alvosPorPeriodo = new Map();
    for (const reg of q.recordset) {
        const lista = [];
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            if (String(x.tipo) !== 'NFS') continue;
            if (/\bIA\b/i.test(String(x.origem || ''))) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (pd && Array.isArray(pd['Itens']) && pd['Itens'].length) continue;
            lista.push(x);
        }
        if (lista.length) alvosPorPeriodo.set(reg.PERIODO, lista);
    }
    const total = [...alvosPorPeriodo.values()].reduce((s, a) => s + a.length, 0);
    console.log(`NFS sem itens e sem IA: ${total} em ${alvosPorPeriodo.size} período(s)`);
    for (const [p, a] of alvosPorPeriodo) console.log(`   ${p}: ${a.length}`);
    if (!total) process.exit(0);

    if (!CONFIRMAR) {
        console.log('\nDRY-RUN — nada será gravado. Acrescente --confirmar para executar.');
        console.log('Primeiros alvos:');
        let n = 0;
        for (const [p, a] of alvosPorPeriodo)
            for (const x of a) { if (n++ >= 12) break; console.log(`   [${p}] ${String(x.arquivo).slice(0, 62)}`); }
        process.exit(0);
    }

    // Índice do disco, por nome.
    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q2 = path.join(d, x.name);
            if (x.isDirectory()) anda(q2); else if (!idx.has(x.name)) idx.set(x.name, q2); }
    })(RAIZ_ARQ);

    let feitos = 0, comItens = 0, semMudanca = 0, recusados = 0, falhas = 0, naoAchados = 0;
    for (const [periodo, alvos] of alvosPorPeriodo) {
        const novas = [];
        for (const x of alvos) {
            if (feitos >= LIMITE) break;
            const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            const abs = idx.get(base);
            if (!abs) { naoAchados++; continue; }
            feitos++;

            let pdAntes = null; try { pdAntes = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const valorAntes = j.num(primeiro(pdAntes, ROT_VALOR));

            let rows;
            try {
                rows = await pf.analyzePdf(
                    { path: abs, name: base, folder: x.pasta || '' }, { forceAI: true });
            } catch (e) {
                console.warn(`   FALHOU ${base.slice(0, 46)}: ${e.message}`);
                falhas++; continue;
            }
            if (!rows || !rows.length) { falhas++; continue; }

            let pdDepois = null; try { pdDepois = JSON.parse(rows[0].dados_parser || 'null'); } catch (_) {}
            const valorDepois = j.num(primeiro(pdDepois, ROT_VALOR));
            const itensDepois = (pdDepois && pdDepois['Itens'] || []).length;

            // TRAVA: não gravar linha que perdeu o valor que já tinha.
            if (valorAntes != null && valorDepois == null) {
                console.warn(`   RECUSADO (perderia o valor ${valorAntes}) ${base.slice(0, 44)}`);
                recusados++; continue;
            }
            if (itensDepois) comItens++; else semMudanca++;
            for (const r of rows) novas.push(r);

            if (feitos % 20 === 0)
                console.log(`   ... ${feitos}/${Math.min(total, LIMITE)}  (${comItens} com itens)`);
        }
        if (novas.length) {
            await pf.upsertRelatorio(pool, 'M', periodo, novas);
            console.log(`   ✓ ${periodo}: ${novas.length} linha(s) gravadas`);
        }
        if (feitos >= LIMITE) break;
    }

    console.log('\n── RESULTADO ───────────────────────────────────────────────');
    console.log(`   relidos:            ${feitos}`);
    console.log(`   agora COM itens:    ${comItens}`);
    console.log(`   continuam sem:      ${semMudanca}`);
    console.log(`   recusados (trava):  ${recusados}`);
    console.log(`   falhas:             ${falhas}`);
    console.log(`   não achados:        ${naoAchados}`);
    process.exit(0);
})();
