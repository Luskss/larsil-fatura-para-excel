/**
 * routes/usuarios.js  → /api/usuarios.php
 * Gestão de usuários: GET (listar), POST (criar), DELETE (excluir),
 * PATCH (trocar senha). Espelha api/usuarios.php.
 */
'use strict';

const { getConnection, sql } = require('../config');
const { setFullSecurityHeaders, requireAuth, trimStr } = require('./_helpers');

module.exports = async function usuariosRoute(req, res) {
  setFullSecurityHeaders(res);

  if (!requireAuth(req, res)) return;

  const method = req.method;

  try {
    const pool = await getConnection();

    /* ── GET: listar ──────────────────────────────────────────────────── */
    if (method === 'GET') {
      const result = await pool
        .request()
        .query('SELECT LOGIN, NOME FROM nfs.CONV_USUARIOS ORDER BY NOME');
      return res.json({ success: true, usuarios: result.recordset });
    }

    const body = req.body || {};

    /* ── POST: criar ──────────────────────────────────────────────────── */
    if (method === 'POST') {
      const login = trimStr(body.login);
      const nome = trimStr(body.nome);
      const senha = body.senha ?? '';

      if (login === '' || nome === '' || senha === '') {
        return res.status(400).json({ success: false, message: 'Login, nome e senha são obrigatórios.' });
      }
      if (login.length > 100 || nome.length > 200 || String(senha).length > 256) {
        return res.status(400).json({ success: false, message: 'Dados muito longos.' });
      }

      const chk = await pool
        .request()
        .input('login', sql.NVarChar(100), login)
        .query('SELECT 1 AS x FROM nfs.CONV_USUARIOS WHERE LOGIN = @login');
      if (chk.recordset.length > 0) {
        return res.status(409).json({ success: false, message: 'Login já cadastrado.' });
      }

      await pool
        .request()
        .input('login', sql.NVarChar(100), login)
        .input('nome', sql.NVarChar(200), nome)
        .input('senha', sql.NVarChar(256), String(senha))
        .query('INSERT INTO nfs.CONV_USUARIOS (LOGIN, NOME, SENHA) VALUES (@login, @nome, @senha)');

      return res.json({ success: true, message: 'Usuário criado com sucesso.' });
    }

    /* ── DELETE: excluir ──────────────────────────────────────────────── */
    if (method === 'DELETE') {
      const login = trimStr(body.login);

      if (login === '') {
        return res.status(400).json({ success: false, message: 'Login é obrigatório.' });
      }
      if (login === (req.session.cf_username || '')) {
        return res.status(403).json({ success: false, message: 'Você não pode excluir seu próprio usuário.' });
      }

      const del = await pool
        .request()
        .input('login', sql.NVarChar(100), login)
        .query('DELETE FROM nfs.CONV_USUARIOS WHERE LOGIN = @login');

      if (del.rowsAffected[0] === 0) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
      }
      return res.json({ success: true, message: 'Usuário excluído.' });
    }

    /* ── PATCH: trocar senha ──────────────────────────────────────────── */
    if (method === 'PATCH') {
      const login = trimStr(body.login);
      const nova_senha = body.nova_senha ?? '';

      if (login === '' || nova_senha === '') {
        return res.status(400).json({ success: false, message: 'Login e nova senha são obrigatórios.' });
      }
      if (String(nova_senha).length > 256) {
        return res.status(400).json({ success: false, message: 'Senha muito longa.' });
      }

      const upd = await pool
        .request()
        .input('senha', sql.NVarChar(256), String(nova_senha))
        .input('login', sql.NVarChar(100), login)
        .query('UPDATE nfs.CONV_USUARIOS SET SENHA = @senha WHERE LOGIN = @login');

      if (upd.rowsAffected[0] === 0) {
        return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
      }
      return res.json({ success: true, message: 'Senha atualizada.' });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido.' });
  } catch (e) {
    console.error('[usuarios] error:', e.message);
    return res.status(500).json({ success: false, message: 'Erro no servidor.' });
  }
};
