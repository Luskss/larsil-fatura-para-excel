/**
 * _medir/ocr-cache.js — regrava `.cache/ocr.json` usando o `contarNoCsv` DE
 * PRODUÇÃO, e não a reimplementação de `ocr.js`.
 *
 * Precisa do SQL uma vez; depois `verificar-cache.js` roda offline sobre o
 * resultado. Rode-o de novo sempre que `contarNoCsv` mudar de esquema — foi o
 * caso em 08/09/2026, quando o índice passou a ter a chave composta
 * `pasta|arquivo` além do nome sozinho (§22.3).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

(async () => {
    const rota = h.internasDaRota();
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const b = rota.contarNoCsv(rs.recordset.map(r => r.CONTEUDO));
    const idx = b.ocrPorArquivo || {};

    const chaves = Object.keys(idx);
    const compostas = chaves.filter(k => k.includes('|')).length;
    const destino = path.join(h.CACHE, 'ocr.json');
    fs.writeFileSync(destino, JSON.stringify(idx));
    console.log(`gravado ${destino}`);
    console.log(`  entradas: ${chaves.length}  (compostas ${compostas}, por nome ${chaves.length - compostas})`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
