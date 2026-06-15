'use strict';
// Helpers compartilhados para a tabela nfs.ALERTAS_FALSOS
// Usados tanto pela rota /api/alertas-falsos quanto por comparar-notas.

const ENSURE_SQL = `
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'nfs' AND TABLE_NAME = 'ALERTAS_FALSOS'
)
BEGIN
    CREATE TABLE nfs.ALERTAS_FALSOS (
        ID          int          IDENTITY(1,1) PRIMARY KEY,
        PERIODO     varchar(20)  NOT NULL,
        CHAVE       varchar(500) NOT NULL,
        MOTIVO      varchar(200),
        OBSERVACAO  varchar(500),
        CRIADO_EM   datetime2    NOT NULL DEFAULT GETDATE(),
        CRIADO_POR  varchar(100),
        CONSTRAINT UQ_ALERTAS_FALSOS UNIQUE (PERIODO, CHAVE)
    )
END`;

let tableEnsured = false;

async function ensureTable(pool) {
    if (tableEnsured) return;
    await pool.request().query(ENSURE_SQL);
    tableEnsured = true;
}

// Retorna Map<chave, {motivo, obs, criadoPor, criadoEm}>
async function getAlertasFalsos(pool, periodo) {
    await ensureTable(pool);
    const result = await pool.request()
        .input('periodo', periodo)
        .query('SELECT CHAVE, MOTIVO, OBSERVACAO, CRIADO_POR, CRIADO_EM FROM nfs.ALERTAS_FALSOS WHERE PERIODO = @periodo');
    const mapa = new Map();
    for (const r of result.recordset) {
        mapa.set(r.CHAVE, {
            motivo:    r.MOTIVO    || '',
            obs:       r.OBSERVACAO || '',
            criadoPor: r.CRIADO_POR || '',
            criadoEm:  r.CRIADO_EM,
        });
    }
    return mapa;
}

module.exports = { ensureTable, getAlertasFalsos };
