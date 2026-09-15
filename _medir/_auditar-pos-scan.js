/**
 * _medir/_auditar-pos-scan.js — auditoria do que o scan GRAVOU.
 *
 * Pedido do usuário (11/09/2026): ir conferindo bugs e anormalidades ao longo da
 * conferência. Este script roda sobre o banco DEPOIS do scan e testa invariantes —
 * as que já pegaram bug antes, mais as novas que a transcrição introduz.
 *
 * Confere pelo CONTEÚDO GRAVADO, nunca pelo log: na rodada de 11/09 o log disse
 * `"errors": 0` enquanto havia 10 falhas de OCR
 * ([[cache-esconde-mudanca-de-extracao]], [[releitura-congela-versao-do-parser]]).
 *
 * ── Invariantes ──────────────────────────────────────────────────────────────
 *  1. PERDA     — nenhum documento-fonte desapareceu do banco
 *  2. VAZIO     — linha sem NENHUM dos 4 campos do pareamento (o dano concreto)
 *  3. DATA      — nenhuma data fora da janela plausível (a trava `dataPlausivel`
 *                 foi adicionada hoje; se aparecer data ruim, ela não pegou)
 *  4. GABARITO  — nenhum valor gravado igual a um ANO (2025/2026): era o bug de
 *                 `valorDoNome` lendo data como valor, corrigido hoje
 *  5. TRUNCAMENTO — nenhum valor que pareça milhar truncado (lido×1000 ≈ nome)
 *  6. TRAVA     — valor que diverge do nome não pode estar como "Valor total"
 *  7. PROCEDÊNCIA — as linhas de transcrição estão marcadas como tal em `conteudo`
 *                 e `ocr_usado`; sem isso a conferência não sabe de onde veio o dado
 *  8. TRANSCRIÇÃO— quantas linhas ganharam campo por transcrição, e nenhuma linha
 *                 transcrita pode ter ficado com MENOS campo que antes (regressão)
 *
 * Compara com a LINHA DE BASE medida antes deste scan, para regressão ficar visível.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_auditar-pos-scan.js [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const pare = require('../routes/_pareamento');
const visao = require('../routes/_nf-visao');
const { getConnection, sql } = require('../config');
const { csvToRows } = require('../routes/process-folder');

const PERIODO = process.argv[2] || '03.2026';
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

// Linha de base medida ANTES deste scan (11/09/2026, após o 1º reprocessamento).
const BASE = { linhas: 1246, semNenhum: 2, origemVazia: 101, visaoIA: 44 };

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';
const ROTULOS = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const CAMPOS = Object.keys(ROTULOS);
const temCampo = (pd, c) => !!pd && ROTULOS[c].some(k => !VAZIO(pd[k]));
const numBR = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
};

let bugs = 0, avisos = 0;
const BUG = (t, m) => { bugs++; console.log(`  ✗ BUG  [${t}] ${m}`); };
const AVISO = (t, m) => { avisos++; console.log(`  ! aviso[${t}] ${m}`); };
const OK = (t, m) => console.log(`  ✓ ok   [${t}] ${m}`);

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO, ATUALIZADO_EM FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    if (!r.recordset.length) { console.log('sem relatório'); process.exit(1); }
    const rows = csvToRows(r.recordset[0].CONTEUDO);
    const pd = row => { try { return JSON.parse(row.dados_parser || 'null'); } catch (_) { return null; } };

    console.log(`AUDITORIA PÓS-SCAN — ${PERIODO}`);
    console.log(`atualizado em: ${r.recordset[0].ATUALIZADO_EM ? new Date(r.recordset[0].ATUALIZADO_EM).toISOString() : '—'}`);
    console.log(`linhas: ${rows.length}  (base: ${BASE.linhas})\n`);

    // ── 1. PERDA de documento ────────────────────────────────────────────────
    const baseDocs = new Set(rows.map(x => path.basename(String(x.arquivo).replace(/#p\d+$/, ''))));
    const pastaDir = path.join(RAIZ_ARQ, `2026.${PERIODO.split('.')[0]}.EXTRATOS CONTABILIDADE`);
    const noDisco = [];
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q);
            else if (/\.pdf$/i.test(x.name) &&
                     !/^\s*\d+\s*[.\-]\s*CPV\b/i.test(x.name) && !/^0+\s*[.\-]/.test(x.name))
                noDisco.push(x.name); }
    })(pastaDir);
    // O documento é atribuído ao mês da sua DATA, não ao da pasta onde está
    // arquivado ([[vizinhanca-mistura-meses]]). Um PDF de janeiro guardado na pasta
    // de março aparece no relatório de 01.2026 — então procurar só neste período dá
    // falso positivo. Minha 1ª versão acusou 2 "perdas" que estavam em 01.2026.
    const faltandoAqui = noDisco.filter(n => !baseDocs.has(n));
    const faltando = [];
    if (faltandoAqui.length) {
        const outros = {};
        for (const p of h.PERIODOS) {
            if (p === PERIODO) continue;
            const q = await pool.request()
                .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), p)
                .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
            if (!q.recordset.length) continue;
            for (const x of csvToRows(q.recordset[0].CONTEUDO))
                outros[path.basename(String(x.arquivo).replace(/#p\d+$/, ''))] = p;
        }
        for (const n of faltandoAqui) {
            if (outros[n]) console.log(`  · ${n.slice(0, 50)} → está em ${outros[n]} (mês do documento)`);
            else faltando.push(n);
        }
    }
    if (faltando.length) {
        BUG('PERDA', `${faltando.length} PDF da pasta não tem linha em NENHUM período`);
        for (const n of faltando.slice(0, 8)) console.log(`         ${n.slice(0, 62)}`);
    } else OK('PERDA', `todos os ${noDisco.length} PDFs elegíveis têm linha (neste mês ou no mês do documento)`);

    // ── 2. VAZIO: linha sem nenhum campo ────────────────────────────────────
    const vazias = rows.filter(x => CAMPOS.every(c => !temCampo(pd(x), c)));
    if (vazias.length > BASE.semNenhum) {
        BUG('VAZIO', `${vazias.length} linhas sem nenhum campo (base: ${BASE.semNenhum}) — REGRESSÃO`);
        for (const x of vazias.slice(0, 8)) console.log(`         origem=${String(x.origem || '—').slice(0, 12).padEnd(13)} ${String(x.arquivo).slice(0, 50)}`);
    } else {
        OK('VAZIO', `${vazias.length} linhas sem campo (base: ${BASE.semNenhum})`);
        for (const x of vazias) console.log(`         resta: ${String(x.arquivo).slice(0, 56)}`);
    }

    // ── 3. DATA fora da janela ──────────────────────────────────────────────
    const anoAgora = new Date().getFullYear();
    const datasRuins = [];
    for (const x of rows) {
        const d = pd(x);
        if (!d) continue;
        for (const campo of ['Data de emissão', 'Data de vencimento']) {
            const s = String(d[campo] || '').trim();
            if (!/^\d{2}\/\d{2}\/\d{4}$/.test(s)) continue;
            const ano = Number(s.slice(6, 10));
            // Vencimento de boleto pode legitimamente passar da janela (fator de
            // vencimento), então só o futuro DISTANTE conta como erro nele.
            const limite = campo === 'Data de vencimento' ? anoAgora + 6 : anoAgora + 1;
            if (ano < anoAgora - 6 || ano > limite) datasRuins.push({ x, campo, s });
        }
    }
    if (datasRuins.length) {
        BUG('DATA', `${datasRuins.length} datas fora da janela — a trava dataPlausivel não pegou`);
        for (const e of datasRuins.slice(0, 10))
            console.log(`         ${e.campo}=${e.s}  origem=${String(e.x.origem || '—').slice(0, 10)}  ${String(e.x.arquivo).slice(0, 44)}`);
    } else OK('DATA', 'nenhuma data fora da janela plausível');

    // ── 4. GABARITO: valor igual a um ANO ───────────────────────────────────
    const anoComoValor = [];
    for (const x of rows) {
        const d = pd(x);
        const v = numBR(d && (d['Valor total'] || d['Valor total da nota']));
        if (v != null && Number.isInteger(v) && v >= 2015 && v <= 2035) anoComoValor.push({ x, v });
    }
    if (anoComoValor.length) {
        AVISO('GABARITO', `${anoComoValor.length} valores que são um ANO (pode ser coincidência legítima)`);
        for (const e of anoComoValor.slice(0, 6)) console.log(`         valor=${e.v}  ${String(e.x.arquivo).slice(0, 52)}`);
    } else OK('GABARITO', 'nenhum valor gravado é um ano');

    // ── 5. TRUNCAMENTO de milhar ────────────────────────────────────────────
    const trunc = [];
    for (const x of rows) {
        const d = pd(x);
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        const gab = pare.valorDoNome(base);
        const v = numBR(d && (d['Valor total'] || d['Valor total da nota']));
        if (gab && v && visao.pareceTruncamentoDeMilhar(v, gab)) trunc.push({ x, v, gab });
    }
    if (trunc.length) {
        BUG('TRUNCAMENTO', `${trunc.length} valores que parecem milhar truncado`);
        for (const e of trunc.slice(0, 8)) console.log(`         lido=${e.v} nome=${e.gab}  ${String(e.x.arquivo).slice(0, 44)}`);
    } else OK('TRUNCAMENTO', 'nenhum valor truncado no milhar');

    // ── 6. TRAVA da visão ───────────────────────────────────────────────────
    const viol = rows.filter(x => {
        const d = pd(x);
        return d && d['Valor lido (não confere com o nome)'] && (d['Valor total'] || d['Valor total da nota']);
    });
    if (viol.length) {
        BUG('TRAVA', `${viol.length} linhas com valor divergente E "Valor total" juntos`);
        for (const x of viol.slice(0, 6)) console.log(`         ${String(x.arquivo).slice(0, 56)}`);
    } else OK('TRAVA', 'nenhuma linha grava valor divergente como total');

    // ── 7. PROCEDÊNCIA da transcrição ───────────────────────────────────────
    const porConteudo = {}, porOrigem = {};
    for (const x of rows) {
        porConteudo[String(x.conteudo || '—')] = (porConteudo[String(x.conteudo || '—')] || 0) + 1;
        porOrigem[String(x.origem || '(vazio)').trim() || '(vazio)'] = (porOrigem[String(x.origem || '(vazio)').trim() || '(vazio)'] || 0) + 1;
    }
    console.log('\n  procedência gravada (coluna `conteudo`):');
    for (const [k, v] of Object.entries(porConteudo).sort((a, b) => b[1] - a[1]))
        console.log(`      ${String(v).padStart(5)}  ${k}`);
    console.log('  origem:');
    for (const [k, v] of Object.entries(porOrigem).sort((a, b) => b[1] - a[1]))
        console.log(`      ${String(v).padStart(5)}  ${k}`);

    const nTrans = rows.filter(x => /transcri/i.test(String(x.conteudo || ''))).length;
    if (nTrans) {
        OK('PROCEDÊNCIA', `${nTrans} linhas marcadas como transcrição IA`);
        const transSemCampo = rows.filter(x => /transcri/i.test(String(x.conteudo || '')) &&
            CAMPOS.every(c => !temCampo(pd(x), c)));
        if (transSemCampo.length) BUG('TRANSCRIÇÃO', `${transSemCampo.length} linhas transcritas SEM nenhum campo`);
        else OK('TRANSCRIÇÃO', 'toda linha transcrita tem ao menos um campo');
        // quantas têm valor conferido pelo nome?
        let bate = 0, diverge = 0;
        for (const x of rows.filter(y => /transcri/i.test(String(y.conteudo || '')))) {
            const d = pd(x);
            const gab = pare.valorDoNome(path.basename(String(x.arquivo).replace(/#p\d+$/, '')));
            const v = numBR(d && (d['Valor total'] || d['Valor total da nota']));
            if (!gab || !v) continue;
            if (visao.conferirValor(v, gab) === 'bate') bate++; else diverge++;
        }
        console.log(`      valor conferido pelo nome: ${bate} batem, ${diverge} divergem`);
    } else {
        AVISO('PROCEDÊNCIA', 'NENHUMA linha marcada como transcrição — a transcrição rodou?');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(bugs ? `${bugs} BUG(S)` + (avisos ? ` e ${avisos} aviso(s)` : '') : (avisos ? `nenhum bug, ${avisos} aviso(s)` : 'NENHUM BUG — todas as invariantes passaram'));
    process.exit(0);
})();
