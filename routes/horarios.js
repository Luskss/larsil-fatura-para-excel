/**
 * routes/horarios.js
 * Gestão de horários de rotinas: GET (listar), POST (criar), DELETE (excluir).
 * Tabela: nfs.HORARIOS (ID_HORARIO int PK, HORARIO time)
 */
'use strict';

const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

module.exports = async function horariosRoute(req, res) {
  setFullSecurityHeaders(res);

  if (!requireAuth(req, res)) return;

  const method = req.method;

  try {
    const pool = await getConnection();

    /* ── GET: listar ──────────────────────────────────────────────────── */
    if (method === 'GET') {
      const result = await pool
        .request()
        .query('SELECT ID_HORARIO, CONVERT(varchar(5), HORARIO, 108) AS HORARIO FROM nfs.HORARIOS ORDER BY HORARIO');
      return res.json({ success: true, horarios: result.recordset });
    }

    const body = req.body || {};

    /* ── POST: criar ──────────────────────────────────────────────────── */
    if (method === 'POST') {
      const horario = trimStr(body.horario); // esperado "HH:MM"

      if (!/^\d{2}:\d{2}$/.test(horario)) {
        return res.status(400).json({ success: false, message: 'Horário inválido. Use o formato HH:MM.' });
      }

      // Verifica duplicata
      const chk = await pool
        .request()
        .input('h', sql.VarChar(5), horario)
        .query("SELECT 1 AS x FROM nfs.HORARIOS WHERE CONVERT(varchar(5), HORARIO, 108) = @h");
      if (chk.recordset.length > 0) {
        return res.status(409).json({ success: false, message: 'Esse horário já está cadastrado.' });
      }

      await pool
        .request()
        .input('h', sql.VarChar(5), horario)
        .query('INSERT INTO nfs.HORARIOS (HORARIO) VALUES (@h)');

      return res.json({ success: true, message: 'Horário adicionado.' });
    }

    /* ── DELETE: excluir ──────────────────────────────────────────────── */
    if (method === 'DELETE') {
      const id = parseInt(body.id, 10);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, message: 'ID inválido.' });
      }

      const del = await pool
        .request()
        .input('id', sql.Int, id)
        .query('DELETE FROM nfs.HORARIOS WHERE ID_HORARIO = @id');

      if (del.rowsAffected[0] === 0) {
        return res.status(404).json({ success: false, message: 'Horário não encontrado.' });
      }
      return res.json({ success: true, message: 'Horário removido.' });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  } catch (e) {
    console.error('[horarios] error:', e.message);
    return res.status(500).json({ success: false, message: 'Erro no servidor.' });
  }
};
