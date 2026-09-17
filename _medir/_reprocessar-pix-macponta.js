/**
 * _medir/_reprocessar-pix-macponta.js — relê UM documento e limpa as parcelas que ele
 * deixou espalhadas por outros períodos.
 *
 * Caso: `004.DOC-430000,00-PIX ENVIADO Macponta.pdf` (04.2026, SANTANDER/2026.04.13)
 * foi lido como carnê e virou 45 parcelas de R$ 6.798,65 do DAYCOVAL, arquivadas de
 * 04.2026 a 12.2029 sob o nome da MACPONTA — ver [[carne-dentro-do-comprovante]].
 *
 * ── Por que `_reprocessar-arquivos.js` não serve ─────────────────────────────
 * Ele grava com `upsertRelatorio(pool, 'M', PERIODO, rows)`, e a limpeza de parcelas
 * do upsert ("ao gravar qualquer linha de um PDF, some TODAS as linhas antigas
 * daquele PDF") só alcança o período em que ele está gravando. As 45 parcelas deste
 * PDF estão em 45 períodos diferentes: gravar só 04.2026 deixaria 44 sobras
 * ([[parcelas-pn-sobram-no-upsert]] é o mesmo defeito, por outra via).
 *
 * Por isso aqui: primeiro remover o PDF de TODOS os períodos onde ele aparece,
 * depois gravar o que a releitura encontrar.
 *
 * ── Por que forceAI ─────────────────────────────────────────────────────────
 * É o modo de produção desde §16.1, e foi o modo que gravou o dado atual. Reler pelo
 * caminho local produziria um resultado que não é comparável com o que está lá.
 *
 * Uso:
 *   node _medir/_reprocessar-pix-macponta.js               (dry-run)
 *   node _medir/_reprocessar-pix-macponta.js --confirmar
 *   ... --arquivo "TRECHO"   outro documento com o mesmo problema
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

const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const args = process.argv.slice(2);
const CONFIRMAR = args.includes('--confirmar');
const iArq = args.indexOf('--arquivo');
const TRECHO = iArq >= 0 ? args[iArq + 1] : 'PIX ENVIADO Macponta';
const SUB = '2026.04.EXTRATOS CONTABILIDADE';

const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const campos = (row) => { try { return JSON.parse(row.dados_parser || '{}') || {}; } catch (_) { return {}; } };

(async () => {
    const pool = await getConnection();

    // ── 1. onde o PDF está hoje ──────────────────────────────────────────────
    const rs = await pool.request()
        .query("SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA");
    const ocorrencias = [];
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || !row.arquivo.includes(TRECHO)) continue;
            ocorrencias.push({ tipo: rec.TIPO, periodo: rec.PERIODO, row });
        }
    }
    const porTipo = {};
    for (const o of ocorrencias) porTipo[o.tipo] = (porTipo[o.tipo] || 0) + 1;

    console.log(`=== ANTES: "${TRECHO}" ===`);
    console.log(`  ocorrências: ${ocorrencias.length}  (${Object.entries(porTipo).map(([k, v]) => `${k}=${v}`).join(' ')})`);
    const periodosM = [...new Set(ocorrencias.filter(o => o.tipo === 'M').map(o => o.periodo))].sort();
    console.log(`  períodos M : ${periodosM.length} → ${periodosM.slice(0, 6).join(', ')}${periodosM.length > 6 ? ` ... ${periodosM[periodosM.length - 1]}` : ''}`);
    const amostra = ocorrencias.find(o => o.tipo === 'M');
    if (amostra) {
        const d = campos(amostra.row);
        console.log(`  emitente   : ${d['Emitente']}`);
        console.log(`  razão social: ${d['Razão social (nota)']}`);
        console.log(`  valor/parc : ${d['Valor total']}   (nome do arquivo diz 430.000,00)`);
        console.log(`  pasta      : ${amostra.row.pasta}`);
    }

    // ── 2. o arquivo no disco ────────────────────────────────────────────────
    const dir = path.join(process.env.ARQUIVO_PATH || process.env.MONITOR_PATH, SUB);
    const todos = await pf.collectPdfs(dir);
    const alvos = todos.filter(p => p.name.includes(TRECHO));
    console.log(`\n  no disco   : ${alvos.length} arquivo(s)`);
    for (const a of alvos) console.log(`     [${a.folder}] ${a.name}`);
    if (!alvos.length) { console.log('\nnada a fazer — arquivo não está no disco.'); process.exit(1); }

    if (!CONFIRMAR) {
        console.log(`\nO QUE SERIA FEITO:`);
        console.log(`  1. remover as ${ocorrencias.length} linhas de TODOS os ${periodosM.length} períodos M (e os D)`);
        console.log(`  2. reler o PDF com forceAI`);
        console.log(`  3. gravar o resultado no período de cada parcela`);
        console.log(`\nDRY-RUN — nada gravado. Acrescente --confirmar.`);
        process.exit(0);
    }

    // ── 3. relê ANTES de apagar: se a leitura falhar, o banco fica como está ─
    console.log(`\n── RELENDO (forceAI) ───────────────────────────────────────`);
    const novas = [];
    for (const a of alvos) {
        const rows = await pf.analyzePdf(a, { forceAI: true });
        console.log(`   ${a.name.slice(0, 56)} → ${rows ? rows.length : 0} row(s)`);
        for (const r of (rows || [])) novas.push({ pdf: a, row: r });
    }
    if (!novas.length) { console.log('\nleitura não devolveu nada — banco preservado.'); process.exit(1); }

    const d0 = campos(novas[0].row);
    console.log(`   agora: emitente=${d0['Emitente']}  razão=${d0['Razão social (nota)']}  valor=${d0['Valor total']}`);

    // ── 4. remove o PDF de todos os períodos onde aparecia ───────────────────
    console.log(`\n── LIMPANDO ${periodosM.length} período(s) M + diários ──────────────`);
    const periodosTocados = [...new Set(ocorrencias.map(o => `${o.tipo}|${o.periodo}`))];
    for (const chave of periodosTocados) {
        const [tipo, periodo] = chave.split('|');
        const atual = await pool.request()
            .input('t', sql.Char(1), tipo).input('p', sql.VarChar(20), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@p');
        if (!atual.recordset.length) continue;
        const mantidas = pf.csvToRows(atual.recordset[0].CONTEUDO)
            .filter(r => r.arquivo && !r.arquivo.includes(TRECHO));
        const csv = pf.rowsToCsv(mantidas);
        await pool.request()
            .input('t', sql.Char(1), tipo).input('p', sql.VarChar(20), periodo)
            .input('c', sql.NVarChar(sql.MAX), csv)
            .input('n', sql.Int, mantidas.length)
            .query(`UPDATE nfs.RELATORIOS_CONFERENCIA SET CONTEUDO=@c, TOTAL_ARQUIVOS=@n,
                    ATUALIZADO_EM=GETDATE() WHERE TIPO=@t AND PERIODO=@p`);
    }
    console.log(`   removidas as ${ocorrencias.length} linhas antigas`);

    // ── 5. grava o resultado novo, cada parcela no seu período ──────────────
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('function vencToDay');
    const fim = src.indexOf('// Chave do dados_parser onde o número');
    const mod = { exports: {} };
    new Function('module', `${src.slice(ini, fim)}\nmodule.exports={parcelaVenc,vencToDay};`)(mod);
    const { parcelaVenc, vencToDay } = mod.exports;

    const diaDaPasta = (f) => {
        const m = String(f || '').match(/(?:^|\/)(\d{4})\.(\d{2})\.(\d{2})(?:\/|$)/);
        return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
    };

    const porMes = new Map(), porDia = new Map();
    for (const { pdf, row } of novas) {
        let dia = diaDaPasta(pdf.folder), mes = '04.2026';
        const pv = parcelaVenc(row);
        if (pv) { const d = vencToDay(pv); if (d) { dia = d; mes = d.slice(3); } }
        if (!porMes.has(mes)) porMes.set(mes, []);
        porMes.get(mes).push(row);
        if (dia) { if (!porDia.has(dia)) porDia.set(dia, []); porDia.get(dia).push(row); }
    }
    console.log(`\n── GRAVANDO ───────────────────────────────────────────────`);
    for (const [mes, rows] of porMes) { await pf.upsertRelatorio(pool, 'M', mes, rows); console.log(`   M ${mes}: ${rows.length}`); }
    for (const [dia, rows] of porDia) await pf.upsertRelatorio(pool, 'D', dia, rows);
    console.log(`   D: ${porDia.size} dia(s)`);
    console.log(`\n✓ ${ocorrencias.length} linhas antigas → ${novas.length} novas em ${porMes.size} período(s)`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
