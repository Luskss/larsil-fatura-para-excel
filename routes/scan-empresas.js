/**
 * routes/scan-empresas.js
 * POST /api/scan-empresas
 *
 * Varre os relatórios mensais (M) já processados, casa cada nota com as empresas
 * cadastradas em nfs.EMPRESAS_CONTAS (por CNPJ, nome do emitente ou nome do
 * arquivo) e (re)gera um único relatório tipo C por mês com as linhas filtradas
 * (mesmas colunas do M, sem colunas extras).
 */
'use strict';

const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { matchEmpresa, upsertRelatorio, csvToRows } = require('./process-folder');

module.exports = async function scanEmpresasRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const pool = await getConnection();

        // Empresas cadastradas
        const empResult = await pool.request()
            .query('SELECT ID, NOME, CNPJ FROM nfs.EMPRESAS_CONTAS');
        const empresas = empResult.recordset;
        if (!empresas.length) {
            return res.json({ success: true, encontradas: 0, relatorios: 0, message: 'Nenhuma empresa cadastrada.' });
        }

        // Todos os relatórios mensais (M)
        const mResult = await pool.request()
            .input('tipo', sql.Char(1), 'M')
            .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');

        // Agrupa as notas casadas por MM.YYYY (um único C por mês)
        const rowsPorMes = new Map();
        let encontradas = 0;

        for (const rec of mResult.recordset) {
            const periodo = rec.PERIODO; // MM.YYYY
            for (const row of csvToRows(rec.CONTEUDO)) {
                const empId = matchEmpresa(row, empresas);
                if (empId === null) continue;
                encontradas++;
                if (!rowsPorMes.has(periodo)) rowsPorMes.set(periodo, []);
                rowsPorMes.get(periodo).push(row);
            }
        }

        // Remove entradas C antigas (com formato ID-MM.YYYY) e regrava por MM.YYYY
        await pool.request()
            .input('tipo', sql.Char(1), 'C')
            .query("DELETE FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO LIKE '%-%'");

        for (const [mes, rows] of rowsPorMes) {
            await upsertRelatorio(pool, 'C', mes, rows);
        }

        const relatorios = rowsPorMes.size;
        console.log(`[scan-empresas] ${encontradas} nota(s) casada(s) → ${relatorios} relatório(s) C`);

        return res.json({
            success: true,
            encontradas,
            relatorios,
            message: relatorios
                ? `${encontradas} nota(s) encontrada(s), ${relatorios} mês(es) atualizado(s).`
                : 'Nenhuma nota das empresas cadastradas foi encontrada.',
        });

    } catch (e) {
        console.error('[scan-empresas] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
