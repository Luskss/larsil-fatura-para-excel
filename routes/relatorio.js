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

const COLS = ['arquivo', 'pasta', 'paginas', 'conteudo', 'tipo', 'evidencia', 'origem', 'ocr_usado', 'dados_parser'];

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
    if (!['D', 'M'].includes(tipo)) {
        console.error('[relatorio] 400 — tipo inválido:', tipo);
        return res.status(400).json({ error: 'tipo deve ser D ou M.' });
    }

    const filename = `${tipo}-${data}.csv`;
    const pool     = await getConnection();

    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
        const result = await pool.request()
            .input('tipo',    sql.Char(1),     tipo)
            .input('periodo', sql.VarChar(10), data)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO = @periodo');

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
