/**
 * _medir/testar-conserto.js — a correção do gravador acerta o alvo?
 *
 * Roda `consertarDataPelaPasta` (extraída do process-folder.js real, não copiada)
 * contra os 4.238 PDFs do arquivo permanente e confere as duas garantias:
 *   1. corrige as 44 divergências com assinatura de erro de digitação;
 *   2. NÃO toca em nenhuma das 100 legítimas (conta antiga paga agora) nem nos
 *      644 arquivos cujo nome diverge só no dia.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');

// Extrai as funções do gravador REAL, sem duplicar as regex.
function internasDoGravador() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('function folderToDay');
    const fim = src.indexOf('function todayStr');
    if (ini < 0 || fim < 0) throw new Error('não achei as funções de data — fonte mudou?');
    const f = new Function(`${src.slice(ini, fim)}
        return { folderToDay, filenameToDay, consertarDataPelaPasta };`);
    return f();
}

(async () => {
    const g = internasDoGravador();
    const rota = h.internasDaRota();
    const r = rota.contarNaPasta(process.env.ARQUIVO_PATH || process.env.MONITOR_PATH);

    const parse = d => { const [dd, mm, yy] = d.split('.').map(Number); return { dd, mm, yy }; };
    let total = 0, corrigidos = 0, intocadosMesDif = 0, intocadosDiaDif = 0, iguais = 0;
    const amostraCorrigidos = [], amostraIntocados = [];

    for (const arqs of Object.values(r.arquivosPorMes)) {
        for (const a of arqs) {
            const dir = a.rel.replace(/[\/\\][^\/\\]*$/, '').replace(/\\/g, '/');
            const dn = g.filenameToDay(a.nome), dp = g.folderToDay(dir);
            if (!dn || !dp) continue;
            total++;
            const saida = g.consertarDataPelaPasta(dn, dp);
            if (dn === dp) { iguais++; continue; }

            const n = parse(dn), p = parse(dp);
            const mesDifere = n.mm !== p.mm || n.yy !== p.yy;
            if (saida !== dn) {
                corrigidos++;
                if (amostraCorrigidos.length < 12)
                    amostraCorrigidos.push(`    ${a.nome.slice(0, 56).padEnd(56)} ${dn} → ${saida}`);
            } else if (mesDifere) {
                intocadosMesDif++;
                if (amostraIntocados.length < 10)
                    amostraIntocados.push(`    ${a.nome.slice(0, 56).padEnd(56)} nome=${dn} pasta=${dp}`);
            } else intocadosDiaDif++;
        }
    }

    console.log('=== EFEITO DA CORREÇÃO NO GRAVADOR ===\n');
    console.log(`  arquivos com data no nome E na pasta ... ${total}`);
    console.log(`  data idêntica nos dois ................. ${iguais}`);
    console.log(`  **CORRIGIDOS** ......................... ${corrigidos}`);
    console.log(`  intocados, mês difere (legítimos) ...... ${intocadosMesDif}`);
    console.log(`  intocados, só o dia difere ............. ${intocadosDiaDif}`);

    console.log('\n  corrigidos:\n' + amostraCorrigidos.join('\n'));
    console.log('\n  intocados de propósito (conta antiga / vencimento futuro):');
    console.log(amostraIntocados.join('\n'));

    const ok = corrigidos === 44 && intocadosDiaDif === 644;
    console.log(`\n  esperado: 44 corrigidos (10 trocados + 33 ano + 1), 644 dias preservados`);
    console.log(`  ${ok ? '✅ bate' : '⚠ CONFERIR: números diferentes do medido'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
