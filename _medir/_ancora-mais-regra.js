/**
 * _medir/_ancora-mais-regra.js — a âncora SOMA com a regra de campo, ou se sobrepõe?
 *
 * Duas melhorias na mesa, e elas podem estar consertando os MESMOS documentos:
 *   regra de campo  — prefere `Valor do boleto` (< nota) e depois `Valor total`
 *   âncora          — acha o nº da fatura do nome DENTRO do texto e pega o valor ao lado
 *
 * A âncora mede 93% de acerto quando age (GANHA 34 / PERDE 1 numa amostra de 200).
 * Mas ela só age em ~37% dos documentos (onde o número é achado), e a pergunta que
 * importa para decidir a ordem de aplicação é: quanto cada uma acrescenta SOBRE a outra?
 *
 * Mede 4 configurações nos mesmos documentos:
 *   hoje · só regra · só âncora · âncora depois regra (âncora tem prioridade)
 *
 * SOMENTE LEITURA — nada aplicado no código ainda.
 *
 * Uso: node _medir/_ancora-mais-regra.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const QUANTOS = parseInt(process.argv[2], 10) || 250;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const N = (pd, k) => j.num(pd[k]);
const hoje = (pd) => j.num(primeiro(pd, ROT_VALOR));
const regra = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};

// A âncora agora vem do MÓDULO DE PRODUÇÃO, não de uma cópia local. A cópia foi útil
// para explorar, mas mantê-la depois de o módulo existir faria a medição responder por
// um código que não é o que roda — e a regex de encargo mudou desde a 1ª medição.
const V = require('../routes/_valor-do-pagamento');
const ancora = (text, numero) => V.valorPelaAncora(text, numero);

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
            doc.set(base, { pd, gab: g.valor, num: g.numero, base, tipo: x.tipo });
        }

    // Amostra ALEATÓRIA (semente fixa) — as anteriores priorizavam os que erram, o que
    // serve para achar ganho mas distorce a taxa final.
    const todos = [...doc.values()];
    let s = 42;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const amostra = todos.map(v => ({ v, r: rnd() })).sort((a, b) => a.r - b.r)
        .slice(0, QUANTOS).map(x => x.v);
    console.log(`universo: ${todos.length} documentos · amostra aleatória: ${amostra.length}\n`);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    const R = { hoje: 0, regra: 0, anc: 0, combo: 0 };
    let agiu = 0, n = 0;
    for (const l of amostra) {
        const abs = idx.get(l.base);
        if (!abs) continue;
        let text = '';
        try {
            const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
            const res = await p.getText();
            try { await p.destroy(); } catch (_) {}
            text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        } catch (_) { continue; }
        n++;

        const a = l.num != null ? ancora(text, l.num) : null;
        if (a != null) agiu++;
        const vHoje = hoje(l.pd), vRegra = regra(l.pd);
        const vCombo = a != null ? a : vRegra;

        if (j.jValor(vHoje, l.gab) === 'ok') R.hoje++;
        if (j.jValor(vRegra, l.gab) === 'ok') R.regra++;
        if (a != null && j.jValor(a, l.gab) === 'ok') R.anc++;
        if (j.jValor(vCombo, l.gab) === 'ok') R.combo++;
    }

    const pc = v => (100 * v / n).toFixed(0) + '%';
    console.log(`documentos medidos: ${n}   (âncora pôde agir em ${agiu} = ${pc(agiu)})\n`);
    console.log('   configuração              acertos    taxa');
    console.log(`   hoje                      ${String(R.hoje).padStart(7)}   ${pc(R.hoje).padStart(5)}`);
    console.log(`   só regra de campo         ${String(R.regra).padStart(7)}   ${pc(R.regra).padStart(5)}`);
    console.log(`   só âncora (onde age)      ${String(R.anc).padStart(7)}   ${pc(R.anc).padStart(5)}`);
    console.log(`   ÂNCORA + regra            ${String(R.combo).padStart(7)}   ${pc(R.combo).padStart(5)}`);
    console.log(`\n   ganho da regra sobre hoje:      +${R.regra - R.hoje}`);
    console.log(`   ganho do combo sobre a regra:   +${R.combo - R.regra}`);
    console.log(`   ganho do combo sobre hoje:      +${R.combo - R.hoje}`);
    process.exit(0);
})();
