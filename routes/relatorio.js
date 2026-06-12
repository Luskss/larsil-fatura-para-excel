'use strict';

/**
 * GET  /api/relatorio?tipo=D|M&data=DD.MM.YYYY|MM.YYYY
 *   → { rows: [...], filename: "D-04.06.2026.csv" }
 *
 * POST /api/relatorio  body: { tipo, data, rows: [...], deletions?: [...] }
 *   → { success: true, filename, total: N }
 *
 * Armazenamento: tabela nfs.RELATORIOS_CONFERENCIA (NVARCHAR(MAX) como CSV).
 * Mensal (M): upsert por (arquivo + pasta) — preserva entradas antigas.
 * Diário (D): sobrescreve completamente o registro do período.
 */

const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');

const COLS = ['arquivo', 'pasta', 'paginas', 'conteudo', 'tipo', 'evidencia', 'origem', 'ocr_usado', 'dados_parser', 'cnpj'];

// ── helpers CSV ──────────────────────────────────────────────────────────────

function csvEscape(val) {
    const s = String(val ?? '');
    return (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
}

function rowsToCsv(rows) {
    const lines = rows.map(row => COLS.map(col => csvEscape(row[col] ?? '')).join(';'));
    return '﻿' + [COLS.join(';'), ...lines].join('\r\n'); // UTF-8 BOM para Excel
}

function parseCsvLine(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQ = false;
            else cur += ch;
        } else {
            if (ch === '"') inQ = true;
            else if (ch === ';') { fields.push(cur); cur = ''; }
            else cur += ch;
        }
    }
    fields.push(cur);
    return fields;
}

function csvToRows(csv) {
    const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
        const fields = parseCsvLine(line);
        const row = {};
        COLS.forEach((col, i) => { row[col] = fields[i] ?? ''; });
        return row;
    });
}

// Inverte a ordem de uma data pontilhada: DD.MM.YYYY ↔ YYYY.MM.DD e
// MM.YYYY ↔ YYYY.MM. Retorna null se o formato não bater.
function flipDateOrder(s) {
    let m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/); // DD.MM.YYYY
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    m = String(s).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);     // YYYY.MM.DD
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    m = String(s).match(/^(\d{2})\.(\d{4})$/);              // MM.YYYY
    if (m) return `${m[2]}.${m[1]}`;
    m = String(s).match(/^(\d{4})\.(\d{2})$/);              // YYYY.MM
    if (m) return `${m[2]}.${m[1]}`;
    return null;
}

// ── rota ─────────────────────────────────────────────────────────────────────

module.exports = async function relatorioRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    const params   = req.method === 'GET' ? req.query : (req.body || {});
    const { tipo, data } = params;

    if (!tipo || !data) {
        console.error('[relatorio] 400 — body recebido:', JSON.stringify(params).slice(0, 300));
        return res.status(400).json({ error: 'Parâmetros tipo e data obrigatórios.' });
    }

    const pool = await getConnection();

    // tipo=dias: lista dias com registros diários num mês (data = MM.YYYY)
    if (tipo === 'dias' && req.method === 'GET') {
        const m = String(data).match(/^(\d{2})\.(\d{4})$/); // MM.YYYY
        if (!m) return res.json({ dias: [] });
        const mm = m[1], yyyy = m[2];
        // PERIODO pode estar em DD.MM.YYYY (terminando em .MM.YYYY)
        // ou YYYY.MM.DD (começando em YYYY.MM.). Busca ambos.
        const result = await pool.request()
            .input('tipo',   sql.Char(1),     'D')
            .input('sufixo', sql.VarChar(10), `%.${mm}.${yyyy}`)   // DD.MM.YYYY
            .input('prefixo', sql.VarChar(10), `${yyyy}.${mm}.%`)  // YYYY.MM.DD
            .query(`SELECT PERIODO FROM nfs.RELATORIOS_CONFERENCIA
                    WHERE TIPO = @tipo AND (PERIODO LIKE @sufixo OR PERIODO LIKE @prefixo)`);
        const dias = [];
        for (const r of result.recordset) {
            const p = r.PERIODO;
            let dm = p.match(/^(\d{2})\.\d{2}\.\d{4}$/);      // DD.MM.YYYY → dia = grupo 1
            if (dm) { dias.push(parseInt(dm[1], 10)); continue; }
            dm = p.match(/^\d{4}\.\d{2}\.(\d{2})$/);          // YYYY.MM.DD → dia = grupo 1
            if (dm) dias.push(parseInt(dm[1], 10));
        }
        return res.json({ dias: [...new Set(dias)] });
    }

    if (!['D', 'M'].includes(tipo)) {
        console.error('[relatorio] 400 — tipo inválido:', tipo);
        return res.status(400).json({ error: 'tipo deve ser D ou M.' });
    }

    const filename = `${tipo}-${data}.csv`;

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
        const lookup = async periodo => pool.request()
            .input('tipo',    sql.Char(1),     tipo)
            .input('periodo', sql.VarChar(10), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO = @periodo');

        let result = await lookup(data);
        // Fallback: períodos podem ter sido salvos com a ordem de data invertida
        // (DD.MM.YYYY ↔ YYYY.MM.DD, MM.YYYY ↔ YYYY.MM).
        if (!result.recordset.length) {
            const alt = flipDateOrder(data);
            if (alt && alt !== data) result = await lookup(alt);
        }

        if (!result.recordset.length) return res.json({ rows: [], filename });

        return res.json({ rows: csvToRows(result.recordset[0].CONTEUDO), filename });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
        const { rows, deletions = [] } = req.body || {};
        if (!Array.isArray(rows)) {
            console.error('[relatorio] 400 — rows não é array, tipo:', typeof rows, '| body keys:', Object.keys(req.body || {}));
            return res.status(400).json({ error: 'rows deve ser um array.' });
        }

        let finalRows = rows;

        if (tipo === 'M') {
            // Mensal: carrega existente, remove renomeados, aplica upsert por (arquivo + pasta)
            const existing = await pool.request()
                .input('tipo',    sql.Char(1),     tipo)
                .input('periodo', sql.VarChar(10), data)
                .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO = @periodo');

            if (existing.recordset.length) {
                const deleteSet = new Set((deletions || []).map(d => `${d.oldName}|${d.oldFolder ?? ''}`));
                const base      = csvToRows(existing.recordset[0].CONTEUDO)
                                    .filter(r => !deleteSet.has(`${r.arquivo}|${r.pasta}`));
                const map       = new Map(base.map(r => [`${r.arquivo}|${r.pasta}`, r]));
                for (const row of rows) map.set(`${row.arquivo}|${row.pasta}`, row);
                finalRows = Array.from(map.values());
            }
        }

        const csvContent = rowsToCsv(finalRows);

        await pool.request()
            .input('tipo',     sql.Char(1),             tipo)
            .input('periodo',  sql.VarChar(10),         data)
            .input('conteudo', sql.NVarChar(sql.MAX),   csvContent)
            .input('total',    sql.Int,                 finalRows.length)
            .query(`
                MERGE nfs.RELATORIOS_CONFERENCIA WITH (HOLDLOCK) AS tgt
                USING (SELECT @tipo AS TIPO, @periodo AS PERIODO) AS src
                   ON tgt.TIPO = src.TIPO AND tgt.PERIODO = src.PERIODO
                WHEN MATCHED THEN
                    UPDATE SET CONTEUDO       = @conteudo,
                               TOTAL_ARQUIVOS = @total,
                               ATUALIZADO_EM  = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (TIPO, PERIODO, CONTEUDO, TOTAL_ARQUIVOS)
                    VALUES (@tipo, @periodo, @conteudo, @total);
            `);

        return res.json({ success: true, filename, total: finalRows.length });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
};
