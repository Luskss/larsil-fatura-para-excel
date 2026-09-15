/**
 * _medir/_validar-pipeline-valor.js — o pipeline INTEIRO grava o valor certo agora?
 *
 * As medições anteriores testaram a decisão em cima dos dados JÁ gravados. Esta roda
 * `analyzePdf` de verdade — o caminho que o scan usa — e confere o que sairia no banco.
 *
 * É a diferença entre "a regra acertaria" e "o sistema acerta": a regra pode estar
 * certa e ficar no lugar errado do pipeline, ser sobrescrita adiante, ou não receber o
 * texto. Só rodando a função de produção isso aparece.
 *
 * NÃO grava nada — chama `analyzePdf` e descarta o resultado.
 *
 * Uso: node _medir/_validar-pipeline-valor.js [quantos] [--local]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const QUANTOS = parseInt(process.argv[2], 10) || 25;
const SO_LOCAL = process.argv.includes('--local');
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
// A leitura do banco espelha o que o comparador lê: 'Valor total' primeiro.
const valorDaLinha = (pd) => j.num(pd && pd['Valor total']) ?? j.num(primeiro(pd, ROT_VALOR));

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    const doc = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;
            const base = path.basename(arq);
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            doc.set(base, { pd, gab: g.valor, base, pasta: x.pasta, tipo: x.tipo });
        }

    // Amostra aleatória com semente fixa — reprodutível e sem viés de dificuldade.
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const amostra = [...doc.values()].map(v => ({ v, r: rnd() })).sort((a, b) => a.r - b.r)
        .slice(0, QUANTOS).map(x => x.v);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    console.log(`amostra: ${amostra.length} documentos  (modo: ${SO_LOCAL ? 'LOCAL' : 'IA'})\n`);
    let antesOk = 0, depoisOk = 0, ganhou = 0, perdeu = 0, falhou = 0;
    const porOrigem = new Map();
    const mudancas = [];

    for (const l of amostra) {
        const abs = idx.get(l.base);
        if (!abs) continue;
        let rows;
        try {
            rows = await pf.analyzePdf({ path: abs, name: l.base, folder: l.pasta || '' },
                SO_LOCAL ? {} : { forceAI: true });
        } catch (e) { falhou++; console.log(`   FALHOU ${l.base.slice(0, 40)}: ${e.message}`); continue; }
        if (!rows || !rows.length) { falhou++; continue; }

        let novo = null; try { novo = JSON.parse(rows[0].dados_parser || 'null'); } catch (_) {}
        const vAntes = valorDaLinha(l.pd), vDepois = valorDaLinha(novo);
        const cA = j.jValor(vAntes, l.gab), cD = j.jValor(vDepois, l.gab);
        if (cA === 'ok') antesOk++;
        if (cD === 'ok') depoisOk++;
        if (cD === 'ok' && cA !== 'ok') { ganhou++; mudancas.push({ l, vAntes, vDepois, q: 'GANHOU' }); }
        if (cD !== 'ok' && cA === 'ok') { perdeu++; mudancas.push({ l, vAntes, vDepois, q: 'PERDEU' }); }

        const o = String((novo && novo['Origem do valor pago']) || '(não gravou)');
        porOrigem.set(o, (porOrigem.get(o) || 0) + 1);
    }

    const n = amostra.length - falhou;
    console.log(`RESULTADO sobre ${n} documentos`);
    console.log(`   valor certo ANTES:  ${antesOk}  (${(100 * antesOk / n).toFixed(0)}%)`);
    console.log(`   valor certo DEPOIS: ${depoisOk}  (${(100 * depoisOk / n).toFixed(0)}%)`);
    console.log(`   GANHOU ${ganhou}   PERDEU ${perdeu}   falhas ${falhou}`);

    console.log('\n`Origem do valor pago` gravada:');
    for (const [o, c] of [...porOrigem].sort((a, b) => b[1] - a[1]))
        console.log(`   ${String(c).padStart(4)}  ${o}`);

    if (mudancas.length) {
        console.log('\nMUDANÇAS:');
        for (const m of mudancas.slice(0, 20))
            console.log(`   ${m.q}  nome=${String(m.l.gab).padStart(10)}` +
                `  antes=${String(m.vAntes).padStart(11)} → depois=${String(m.vDepois).padStart(11)}` +
                `  ${m.l.base.slice(0, 32)}`);
    }
    process.exit(0);
})();
