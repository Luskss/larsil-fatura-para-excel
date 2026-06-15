'use strict';
/**
 * routes/vinculos-notas.js
 * GET    /api/vinculos-notas?periodo=MM.AAAA  → lista vínculos do período
 * POST   /api/vinculos-notas  { periodo, chave, entrada, obs }  → upsert
 * DELETE /api/vinculos-notas  { periodo, chave }                → remove
 */
const { getConnection } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { ensureTable, getVinculos } = require('./_vinculos-db');

module.exports = async function vinculosNotasRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    let pool;
    try {
        pool = await getConnection();
        await ensureTable(pool);
    } catch(e) {
        console.error('[vinculos-notas] erro ao conectar/criar tabela:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao acessar banco: ' + e.message });
    }

    if (req.method === 'GET') {
        const periodo = req.query.periodo;
        if (!periodo) return res.status(400).json({ success: false, message: 'periodo obrigatório' });
        const mapa = await getVinculos(pool, periodo);
        const vinculos = {};
        mapa.forEach((v, k) => { vinculos[k] = v; });
        return res.json({ success: true, vinculos });
    }

    if (req.method === 'POST') {
        const { periodo, chave, entrada, obs } = req.body || {};
        if (!periodo || !chave) return res.status(400).json({ success: false, message: 'periodo e chave obrigatórios' });
        const criadoPor = req.session?.cf_username || 'sistema';
        await pool.request()
            .input('periodo',  periodo)
            .input('chave',    chave)
            .input('entrada',  entrada  || '')
            .input('obs',      obs      || '')
            .input('usuario',  criadoPor)
            .query(`
                MERGE nfs.VINCULOS_NOTAS AS T
                USING (SELECT @periodo AS P, @chave AS C) AS S ON T.PERIODO = S.P AND T.CHAVE = S.C
                WHEN MATCHED THEN
                    UPDATE SET ENTRADA = @entrada, OBSERVACAO = @obs,
                               CRIADO_POR = @usuario, CRIADO_EM = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (PERIODO, CHAVE, ENTRADA, OBSERVACAO, CRIADO_POR)
                    VALUES (@periodo, @chave, @entrada, @obs, @usuario);
            `);
        return res.json({ success: true });
    }

    if (req.method === 'DELETE') {
        const { periodo, chave } = req.body || {};
        if (!periodo || !chave) return res.status(400).json({ success: false, message: 'periodo e chave obrigatórios' });
        await pool.request()
            .input('periodo', periodo)
            .input('chave',   chave)
            .query('DELETE FROM nfs.VINCULOS_NOTAS WHERE PERIODO = @periodo AND CHAVE = @chave');
        return res.json({ success: true });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido' });
};
