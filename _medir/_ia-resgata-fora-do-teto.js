/**
 * _medir/_ia-resgata-fora-do-teto.js — reler por IA salva os que estão fora do teto?
 *
 * `_fora-do-teto.js` achou 1.654 documentos onde NENHUM número da linha bate com o
 * gabarito. Dois sinais dizem que parte disso não é limite do sistema, é dado velho:
 *
 *   - 1.154 (70%) foram lidos por `local`, não por IA — e a IA passou a ser a via
 *     única só hoje ([[ia-vence-o-parser-local-no-valor]], pareado 121×9)
 *   - 347 não têm NENHUM número na linha, sendo 100% deles PDF com texto nativo:
 *     não é documento ruim, é leitura pobre
 *
 * Mede numa AMOSTRA: relê por IA e vê quantos passam a ter o valor certo. O resultado
 * decide se vale um reprocessamento amplo (2.836 documentos, ~US$7) ou se o teto de
 * 69% é real.
 *
 * Amostra DIRIGIDA por estrato, não os primeiros N: a 1ª medição desta sessão pegou
 * 20 de 24 do mesmo fornecedor e quase deu veredito por um layout só.
 *
 * SOMENTE LEITURA — não grava no banco.
 *
 * Uso: node _medir/_ia-resgata-fora-do-teto.js [quantos-por-estrato]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const full = require('../routes/_nf-ai-full');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const POR_ESTRATO = parseInt(process.argv[2], 10) || 6;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const N = (pd, k) => j.num(pd[k]);
const proposta = (pd) => {
    const bol = N(pd, 'Valor do boleto'), nota = N(pd, 'Valor total da nota');
    if (bol != null && (nota == null || bol < nota)) return bol;
    return N(pd, 'Valor total') ?? j.num(primeiro(pd, ROT_VALOR));
};
function candidatos(pd) {
    const out = [];
    for (const [k, v] of Object.entries(pd)) {
        if (k === 'Itens') { for (const it of (v || [])) for (const kk of ['Valor total', 'Valor unitário']) {
            const n = j.num(it[kk]); if (n != null) out.push(n); } continue; }
        const n = j.num(v); if (n != null) out.push(n);
    }
    return out;
}

(async () => {
    const rota = h.internasDaRota();
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    const doc = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (/#p\d+$/.test(arq)) continue;          // parcela: o nome traz o total, não compara
            const base = path.basename(arq);
            if (rota.categoriaNaoFiscal && rota.categoriaNaoFiscal(base)) continue;
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!pd) continue;
            doc.set(base, { pd, gab: g.valor, base, tipo: x.tipo, origem: x.origem, conteudo: x.conteudo });
        }

    const fora = [...doc.values()].filter(l =>
        !candidatos(l.pd).some(v => Math.abs(v - l.gab) <= 0.02));
    console.log(`fora do teto (sem parcelas): ${fora.length}`);

    // Estratos: o que distingue as causas prováveis.
    const estratos = {
        'local, linha vazia':   l => !/\bIA\b/i.test(l.origem || '') && candidatos(l.pd).length === 0,
        'local, com números':   l => !/\bIA\b/i.test(l.origem || '') && candidatos(l.pd).length > 0,
        'IA, linha vazia':      l =>  /\bIA\b/i.test(l.origem || '') && candidatos(l.pd).length === 0,
        'IA, com números':      l =>  /\bIA\b/i.test(l.origem || '') && candidatos(l.pd).length > 0,
    };

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    const total = { n: 0, resgatou: 0, continua: 0, falhou: 0 };
    for (const [nome, filtro] of Object.entries(estratos)) {
        const pool2 = fora.filter(filtro);
        // dirigida: 1 por assinatura de layout, até POR_ESTRATO
        const porAssin = new Map();
        for (const l of pool2) {
            const a = j.assinatura(l.base);
            if (!porAssin.has(a)) porAssin.set(a, l);
        }
        const amostra = [...porAssin.values()].slice(0, POR_ESTRATO);
        console.log(`\n── ${nome} (${pool2.length} no total, testando ${amostra.length}) ──`);

        for (const l of amostra) {
            const abs = idx.get(l.base);
            if (!abs) { console.log(`   (não achei no disco) ${l.base.slice(0, 44)}`); continue; }
            let text = '', nPag = 1;
            try {
                const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
                const res = await p.getText();
                try { await p.destroy(); } catch (_) {}
                text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
                nPag = res.total || 1;
            } catch (e) { console.log(`   (pdf falhou) ${l.base.slice(0, 40)}`); continue; }

            total.n++;
            let r;
            try { r = await full.extrairNotaAI({ text, filename: l.base, pages: nPag }); }
            catch (e) { total.falhou++; console.log(`   (IA falhou) ${e.message}`); continue; }
            if (r.error) { total.falhou++; console.log(`   (IA erro) ${r.error}`); continue; }

            const lidos = [j.num(r.valorTotal), j.num(r.valorLiquido),
                ...((r.itens || []).map(i => j.num(i.valorTotal)))].filter(v => v != null);
            const acertou = lidos.some(v => Math.abs(v - l.gab) <= 0.02);
            if (acertou) total.resgatou++; else total.continua++;
            console.log(`   ${acertou ? '✓ RESGATOU' : '· continua'}  nome=${String(l.gab).padStart(10)}` +
                `  antes=${String(proposta(l.pd) ?? '—').padStart(10)}` +
                `  IA=${String(j.num(r.valorTotal) ?? '—').padStart(10)}  ${l.base.slice(0, 30)}`);
        }
    }

    console.log('\n── VEREDITO ────────────────────────────────────────────────');
    console.log(`   testados:  ${total.n}`);
    console.log(`   resgatados pela IA: ${total.resgatou}  (${total.n ? (100 * total.resgatou / total.n).toFixed(0) : 0}%)`);
    console.log(`   continuam fora:     ${total.continua}`);
    console.log(`   falhas:             ${total.falhou}`);
    if (total.n) {
        const taxa = total.resgatou / total.n;
        console.log(`\n   se a taxa valer para os ${fora.length} fora do teto:` +
            ` ~${Math.round(fora.length * taxa)} documentos a mais`);
    }
    process.exit(0);
})();
