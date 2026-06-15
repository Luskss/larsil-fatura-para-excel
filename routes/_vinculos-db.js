'use strict';
const ENSURE_SQL = `
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'nfs' AND TABLE_NAME = 'VINCULOS_NOTAS'
)
BEGIN
    CREATE TABLE nfs.VINCULOS_NOTAS (
        ID         int          IDENTITY(1,1) PRIMARY KEY,
        PERIODO    varchar(20)  NOT NULL,
        CHAVE      varchar(500) NOT NULL,
        ENTRADA    varchar(500),
        OBSERVACAO varchar(500),
        CRIADO_EM  datetime2    NOT NULL DEFAULT GETDATE(),
        CRIADO_POR varchar(100),
        CONSTRAINT UQ_VINCULOS_NOTAS UNIQUE (PERIODO, CHAVE)
    )
END`;

let tableEnsured = false;

async function ensureTable(pool) {
    if (tableEnsured) return;
    await pool.request().query(ENSURE_SQL);
    tableEnsured = true;
}

async function getVinculos(pool, periodo) {
    await ensureTable(pool);
    const result = await pool.request()
        .input('periodo', periodo)
        .query('SELECT CHAVE, ENTRADA, OBSERVACAO, CRIADO_POR, CRIADO_EM FROM nfs.VINCULOS_NOTAS WHERE PERIODO = @periodo');
    const mapa = new Map();
    for (const r of result.recordset) {
        mapa.set(r.CHAVE, {
            entrada:   r.ENTRADA    || '',
            obs:       r.OBSERVACAO || '',
            criadoPor: r.CRIADO_POR || '',
            criadoEm:  r.CRIADO_EM,
        });
    }
    return mapa;
}

module.exports = { ensureTable, getVinculos };
