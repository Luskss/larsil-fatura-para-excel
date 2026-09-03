/**
 * _medir/acuracia-conserto.js — a correção do gravador (§16) prejudica a acurácia?
 *
 * A correção age no DIA gravado, e o pareamento usa a data em dois lugares:
 *   1. o mês do documento decide em que pasta ele é procurado (janela);
 *   2. a distância em dias veta o par sustentado só por valor (JANELA_DIAS = 15).
 *
 * Este script simula o efeito da correção sobre TODO o arquivo permanente —
 * reindexando os documentos com a data já consertada — e compara com o estado
 * atual, pelo critério de sempre: cobertura sobe (ou fica) E 2º campo não cai.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const v = require('./variantes');
const ocrMod = require('./ocr');

function internasDoGravador() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('function folderToDay');
    const fim = src.indexOf('function todayStr');
    return new Function(`${src.slice(ini, fim)}
        return { folderToDay, filenameToDay, consertarDataPelaPasta };`)();
}

(async () => {
    const g = internasDoGravador();
    const c = h.carregar();
    const idx = await ocrMod.indexar();

    // Reindexa a pasta aplicando o conserto do gravador a cada arquivo.
    // O nome do arquivo NÃO muda — só o mês sob o qual ele é indexado.
    const corrigido = {};
    let movidos = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes)) {
        for (const a of arqs) {
            const dir = a.rel.replace(/[/\\][^/\\]*$/, '').replace(/\\/g, '/');
            const dn = g.filenameToDay(a.nome), dp = g.folderToDay(dir);
            const novo = dn ? g.consertarDataPelaPasta(dn, dp) : dp;
            const mesNovo = novo ? novo.slice(3) : mes;
            (corrigido[mesNovo] || (corrigido[mesNovo] = [])).push(a);
            if (mesNovo !== mes) movidos++;
        }
    }
    console.log(`documentos que mudam de mês com o conserto: ${movidos}`);
    console.log('(o NOME do arquivo nunca muda — só o mês sob o qual é indexado)\n');

    const OPT = { ocr: true, minDigitosNum: 2 };
    const casos = [
        ['hoje (leitura §15 já aplicada)', c],
        ['com o conserto do gravador §16', { ...c, pasta: { ...c.pasta, arquivosPorMes: corrigido } }],
    ];

    console.log('variante                          confer   cob%   semDoc  2ºcampo  contrad  fracos');
    const res = [];
    for (const [nome, dados] of casos) {
        const linhas = v.rodar(dados, idx, OPT);
        const s = v.resumir(linhas), q = v.qualidade(linhas);
        res.push({ nome, s, q, linhas });
        console.log(`${nome.padEnd(33)} ${String(s.conferidos).padStart(5)}` +
            ` ${(s.cobertura * 100).toFixed(1).padStart(6)}` +
            ` ${String(s.semDocumento).padStart(7)}` +
            ` ${(q.pcConfirmado * 100).toFixed(1).padStart(7)}%` +
            ` ${String(q.contraditos).padStart(7)}` +
            ` ${String(s.fracos).padStart(6)}`);
    }

    const [a, b] = res;
    const dPares = b.s.conferidos - a.s.conferidos;
    const dQual = (b.q.pcConfirmado - a.q.pcConfirmado) * 100;
    console.log(`\nΔ  ${dPares >= 0 ? '+' : ''}${dPares} pares` +
        `   2º campo ${dQual >= 0 ? '+' : ''}${dQual.toFixed(2)}pp`);
    console.log(dPares >= 0 && dQual >= -0.05
        ? '✅ não prejudica: cobertura não cai e a precisão se mantém'
        : '⚠ REVER: a correção custou precisão ou pares');

    console.log('\n── por período (conferidos / semDoc) ──');
    for (const p of h.PERIODOS) {
        const la = a.linhas.find(x => x.periodo === p), lb = b.linhas.find(x => x.periodo === p);
        const marca = lb.conferidos !== la.conferidos ? `  <- ${lb.conferidos > la.conferidos ? '+' : ''}${lb.conferidos - la.conferidos}` : '';
        console.log(`${p}   ${la.conferidos}/${la.semDocumento}  →  ${lb.conferidos}/${lb.semDocumento}${marca}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
