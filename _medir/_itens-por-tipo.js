/**
 * _medir/_itens-por-tipo.js — quem tem itens gravados, e quem não tem?
 *
 * Achado no caso da NFS 886 (DALIANI): `extrairItens` exige NCM. `extrairItensDaLinha`
 * começa com `if (!RE_NCM.test(linha)) return null` (linha 489) e ainda tem uma
 * segunda trava em `if (!ncm) return null` (linha 513).
 *
 * NCM é o código de MERCADORIA (Nomenclatura Comum do Mercosul). Uma NFS-e é de
 * SERVIÇO — ela não traz NCM, traz código de serviço da LC 116. Se a exigência de
 * NCM for a causa, então NENHUMA NFS-e do acervo tem itens, e não é defeito deste
 * documento: é a regra do extrator, escrita para DANFE.
 *
 * Isso se confirma sem abrir PDF nenhum: basta cruzar `tipo` × presença de `Itens`
 * no relatório. Se a taxa for ~0% em NFS e alta em NF, a causa está isolada.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

(async () => {
    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');

    const porTipo = new Map();
    const vistos = new Set();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const nome = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            if (vistos.has(nome)) continue;
            vistos.add(nome);
            // Só documentos com TEXTO nativo: em imagem a ausência de item tem
            // outra causa e misturaria as duas perguntas.
            if (!/^Texto/i.test(String(x.conteudo || ''))) continue;
            const t = String(x.tipo || '(sem tipo)');
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const r = porTipo.get(t) || { n: 0, comItens: 0, comChave: 0, comCfop: 0 };
            r.n++;
            if (pd && Array.isArray(pd['Itens']) && pd['Itens'].length) r.comItens++;
            if (pd && !VAZIO(pd['Chave de acesso'])) r.comChave++;
            if (pd && !VAZIO(pd['CFOP'])) r.comCfop++;
            porTipo.set(t, r);
        }

    console.log('DOCUMENTOS COM TEXTO NATIVO — itens gravados por tipo\n');
    console.log('   tipo              docs   c/ Itens        c/ chave   c/ CFOP');
    for (const [t, r] of [...porTipo].sort((a, b) => b[1].n - a[1].n)) {
        if (r.n < 3) continue;
        console.log('   ' + t.padEnd(16) + String(r.n).padStart(6) +
            String(r.comItens).padStart(8) + ` (${(100 * r.comItens / r.n).toFixed(0).padStart(3)}%)` +
            String(r.comChave).padStart(11) + String(r.comCfop).padStart(10));
    }
    process.exit(0);
})();
