/**
 * _medir/_transcricao-vazios.js — por que 15 transcrições ficaram sem valor?
 *
 * `_transcricao-preencheu.js` mostrou que as 58 linhas transcritas trazem valor em
 * 37 dos 54 casos com gabarito, mas 15 ficaram VAZIAS e 2 erradas. A pergunta é se
 * esses 15 vazios são falha da transcrição ou da TRAVA — a regra que, quando a
 * visão marca o valor como não-confiável, move a leitura do parser para a coluna
 * `Valor lido do texto transcrito` em vez de gravar em `Valor total`.
 *
 * Se for a TRAVA, o dado EXISTE na linha — só não está na coluna que a conferência
 * lê. Isso é muito diferente de "não conseguiu ler", e muda o que fazer a respeito.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const PERIODO = process.argv[2] || '03.2026';
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO).filter(x => /transcri/i.test(String(x.conteudo || '')));

    // Todas as chaves que aparecem no dados_parser das linhas transcritas, para não
    // supor rótulo — [[chave-do-parser-e-em-portugues]].
    const chaves = new Map();
    for (const x of rows) {
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        for (const k of Object.keys(pd || {})) chaves.set(k, (chaves.get(k) || 0) + 1);
    }
    console.log('CHAVES presentes nas 58 linhas transcritas (nome × quantas linhas):');
    for (const [k, n] of [...chaves].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(n).padStart(3)}  ${k}`);

    const ROT_PRINCIPAL = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                           'Valor principal', 'Valor da prestação', 'Valor líquido'];
    const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

    console.log('\nOS QUE FICARAM SEM VALOR NA COLUNA PRINCIPAL:');
    let naTrava = 0, semNada = 0;
    for (const x of rows) {
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        const g = j.gabaritos(base);
        if (g.valor == null) continue;
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        const principal = j.num(primeiro(pd, ROT_PRINCIPAL));
        if (principal != null) continue;

        const trancado = pd && pd['Valor lido do texto transcrito'];
        const duvida   = pd && pd['Valor lido (não confere com o nome)'];
        const alt = j.num(trancado) ?? j.num(duvida);
        const veredito = alt == null ? 'SEM NADA'
            : (Math.abs(alt - g.valor) <= 0.02 ? 'NA TRAVA, e CONFERE' : 'NA TRAVA, mas diverge');
        if (alt == null) semNada++; else naTrava++;
        console.log(`   ${base.slice(0, 52)}`);
        console.log(`      gabarito=${g.valor}  trava=${JSON.stringify(trancado)}  duvida=${JSON.stringify(duvida)}  → ${veredito}`);
    }
    console.log(`\n   presos na TRAVA: ${naTrava}   sem nada: ${semNada}`);
    process.exit(0);
})();
