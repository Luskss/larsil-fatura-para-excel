/**
 * routes/empresas-contas.js
 * GET    /api/empresas-contas   → lista todas
 * POST   /api/empresas-contas   → cria   { nome, cnpj, tipo, estado }
 * DELETE /api/empresas-contas   → remove { id }
 */
'use strict';

const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

module.exports = async function empresasContasRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    try {
        const pool = await getConnection();

        if (req.method === 'GET') {
            const result = await pool.request()
                .query('SELECT ID, NOME, CNPJ, TIPO, ESTADO FROM nfs.EMPRESAS_CONTAS ORDER BY NOME');
            return res.json({ success: true, empresas: result.recordset });
        }

        const body = req.body || {};

        if (req.method === 'POST') {
            const nome   = trimStr(body.nome);
            const cnpj   = trimStr(body.cnpj   || '');
            const tipo   = trimStr(body.tipo   || '');
            const estado = trimStr(body.estado || '');

            if (!nome) {
                return res.status(400).json({ success: false, message: 'nome é obrigatório.' });
            }

            await pool.request()
                .input('nome',   sql.VarChar(255), nome)
                .input('cnpj',   sql.VarChar(18),  cnpj)
                .input('tipo',   sql.VarChar(20),  tipo)
                .input('estado', sql.VarChar(2),   estado)
                .query(`INSERT INTO nfs.EMPRESAS_CONTAS (NOME, CNPJ, TIPO, ESTADO)
                        VALUES (@nome, @cnpj, @tipo, @estado)`);

            return res.json({ success: true, message: 'Empresa cadastrada.' });
        }

        if (req.method === 'DELETE') {
            const id = parseInt(body.id, 10);
            if (!id) return res.status(400).json({ success: false, message: 'id obrigatório.' });

            await pool.request()
                .input('id', sql.Int, id)
                .query('DELETE FROM nfs.EMPRESAS_CONTAS WHERE ID = @id');

            return res.json({ success: true, message: 'Empresa removida.' });
        }

        return res.status(405).json({ success: false, message: 'Método não permitido.' });

    } catch (e) {
        console.error('[empresas-contas] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
