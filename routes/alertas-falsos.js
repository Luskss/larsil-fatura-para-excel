'use strict';
/**
 * routes/alertas-falsos.js
 * GET    /api/alertas-falsos?periodo=MM.AAAA  → lista alertas do período
 * POST   /api/alertas-falsos  { periodo, chave, motivo, obs }  → upsert
 * DELETE /api/alertas-falsos  { periodo, chave }               → remove
 */
const { getConnection } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const { ensureTable, getAlertasFalsos } = require('./_alertas-falsos-db');

module.exports = async function alertasFalsosRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    let pool;
    try {
        pool = await getConnection();
        await ensureTable(pool);
    } catch(e) {
        console.error('[alertas-falsos] erro ao conectar/criar tabela:', e.message);
        return res.status(500).json({ success: false, message: 'Erro ao acessar banco: ' + e.message });
    }

    // ── GET: lista alertas do período ────────────────────────────────────────
    if (req.method === 'GET') {
        const periodo = req.query.periodo;
        if (!periodo) return res.status(400).json({ success: false, message: 'periodo obrigatório' });
        const mapa = await getAlertasFalsos(pool, periodo);
        const alertas = {};
        mapa.forEach((v, k) => { alertas[k] = v; });
        return res.json({ success: true, alertas });
    }

    // ── POST: upsert alerta falso ────────────────────────────────────────────
    if (req.method === 'POST') {
        const { periodo, chave, motivo, obs } = req.body || {};
        if (!periodo || !chave) {
            return res.status(400).json({ success: false, message: 'periodo e chave obrigatórios' });
        }
        const criadoPor = req.session?.cf_username || 'sistema';
        await pool.request()
            .input('periodo',  periodo)
            .input('chave',    chave)
            .input('motivo',   motivo   || '')
            .input('obs',      obs      || '')
            .input('usuario',  criadoPor)
            .query(`
                MERGE nfs.ALERTAS_FALSOS AS T
                USING (SELECT @periodo AS P, @chave AS C) AS S ON T.PERIODO = S.P AND T.CHAVE = S.C
                WHEN MATCHED THEN
                    UPDATE SET MOTIVO = @motivo, OBSERVACAO = @obs,
                               CRIADO_POR = @usuario, CRIADO_EM = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (PERIODO, CHAVE, MOTIVO, OBSERVACAO, CRIADO_POR)
                    VALUES (@periodo, @chave, @motivo, @obs, @usuario);
            `);
        return res.json({ success: true });
    }

    // ── DELETE: remove alerta falso ──────────────────────────────────────────
    if (req.method === 'DELETE') {
        const { periodo, chave } = req.body || {};
        if (!periodo || !chave) {
            return res.status(400).json({ success: false, message: 'periodo e chave obrigatórios' });
        }
        await pool.request()
            .input('periodo', periodo)
            .input('chave',   chave)
            .query('DELETE FROM nfs.ALERTAS_FALSOS WHERE PERIODO = @periodo AND CHAVE = @chave');
        return res.json({ success: true });
    }

    return res.status(405).json({ success: false, message: 'Método não permitido' });
};
