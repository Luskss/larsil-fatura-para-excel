/**
 * _medir/_nfs-com-itens.js — as 67 NFS que TÊM itens: de onde saíram?
 *
 * A hipótese "NFS-e nunca tem item porque o extrator exige NCM" prevê 0%. O medido
 * foi 12% (67 de 542). Então ou a hipótese está errada, ou esses 67 chegaram por
 * outro caminho.
 *
 * Duas rotas gravam `Itens` no acervo:
 *   - `_nf-itens.js` (extrator local, exige NCM) via process-folder.js:724
 *   - `_nf-ai-full.js` (a IA lê a tabela) via process-folder.js:457
 * A segunda não exige NCM nenhum — o prompt manda ler "DISCRIMINAÇÃO DOS SERVIÇOS".
 *
 * Se as 67 vierem da IA e as 475 sem item forem as que a IA não leu, a hipótese se
 * mantém: o extrator LOCAL não sabe ler serviço, e só a IA cobre essa lacuna.
 * A coluna `origem` do relatório distingue as duas.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

(async () => {
    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');

    const vistos = new Set();
    const cruz = new Map();   // origem -> {comItens, semItens}
    const exemplos = [];
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const nome = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            if (vistos.has(nome)) continue;
            vistos.add(nome);
            if (String(x.tipo) !== 'NFS') continue;
            if (!/^Texto/i.test(String(x.conteudo || ''))) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const tem = pd && Array.isArray(pd['Itens']) && pd['Itens'].length;
            const o = String(x.origem || '(vazio)');
            const r = cruz.get(o) || { comItens: 0, semItens: 0 };
            r[tem ? 'comItens' : 'semItens']++;
            cruz.set(o, r);
            if (tem && exemplos.length < 6)
                exemplos.push({ nome, origem: o, itens: pd['Itens'], ncm: pd['Itens'][0]?.NCM });
        }

    console.log('NFS COM TEXTO NATIVO — itens × origem da leitura\n');
    console.log('   origem            com Itens   sem Itens    taxa');
    for (const [o, r] of [...cruz].sort((a, b) => (b[1].comItens + b[1].semItens) - (a[1].comItens + a[1].semItens))) {
        const t = r.comItens + r.semItens;
        console.log('   ' + o.padEnd(18) + String(r.comItens).padStart(7) + String(r.semItens).padStart(12) +
            (100 * r.comItens / t).toFixed(0).padStart(7) + '%');
    }

    console.log('\nEXEMPLOS DE NFS COM ITENS — o item tem NCM?');
    for (const e of exemplos) {
        console.log(`   ${e.nome.slice(0, 52)}`);
        console.log(`      origem=${e.origem}  NCM do 1º item=${JSON.stringify(e.ncm)}`);
        console.log(`      ${JSON.stringify(e.itens[0]).slice(0, 150)}`);
    }
    process.exit(0);
})();
