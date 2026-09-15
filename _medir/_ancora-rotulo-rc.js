/**
 * _medir/_ancora-rotulo-rc.js — incluir "RC" em `RE_NUM_NOME` ganha ou perde?
 *
 * `_testar-numero-do-nome.js` mostrou que a regex nova se cala em "RC 902527": o
 * rótulo não está na lista. Não é bug — silêncio é o comportamento correto quando não
 * há evidência (§16.6) — mas é COBERTURA que talvez esteja sobrando na mesa: 249 nomes
 * do acervo usam "RC" seguido de número.
 *
 * ── A armadilha que este script existe para evitar ──────────────────────────
 * A alternância de uma regex é ORDENADA: `(?:RC|RCB)` casa "RC" dentro de "RCB 213833"
 * e devolve o número errado em 843 nomes. A regex candidata coloca `RCB` ANTES de `RC`.
 * Medir sem conferir isso daria um resultado catastrófico atribuído ao rótulo errado.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Sobre amostra ALEATÓRIA (semente fixa) de documentos FISCAIS com gabarito de valor:
 *   atual     — `RE_NUM_NOME` como está em produção
 *   com RC    — mesma regex, com RCB|RC acrescentados na ordem segura
 * Para cada uma: quantas vezes a ÂNCORA age, e quando age, acerta o gabarito?
 *
 * O veredito não é "a âncora agiu mais" — é GANHA/PERDE contra o valor que o pipeline
 * escolheria sem ela. Agir mais e errar é pior que se calar
 * ([[inspecao-anima-medicao-decide]]).
 *
 * SOMENTE LEITURA — não grava nada.
 *
 * Uso: node _medir/_ancora-rotulo-rc.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const V = require('../routes/_valor-do-pagamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const QUANTOS = parseInt(process.argv[2], 10) || 300;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

// A regex de produção, extraída do fonte (não é exportada) — o mesmo truque de
// `_testar-numero-do-nome.js`, para medir o que RODA e não uma cópia.
const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
const m = src.match(/const RE_NUM_NOME =[\s\S]*?\n\}/);
if (!m) { console.log('não achei numeroDoNomeArquivo no fonte'); process.exit(1); }
const numAtual = new Function(`${m[0]}; return numeroDoNomeArquivo;`)();

// A candidata: RCB ANTES de RC (senão "RC" casa dentro de "RCB" e captura errado).
const RE_COM_RC = /\b(?:NFS-?e?|NFS|NF-?e?|NF|FT|FAT|FATURA|CT-?e?|RPS|RCB|RC|REC|NOTA)\s*[.\-nN°ºo]*\s*(\d{1,12})\b/i;
function numComRC(nome) {
    const mm = String(nome || '').match(RE_COM_RC);
    if (!mm) return null;
    const d = mm[1];
    if (/^(19|20)\d{6}$/.test(d)) return null;
    return d;
}

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };
const semAncora = (pd) => V.valorPorPrecedencia(pd).valor ?? j.num(primeiro(pd, ROT_VALOR));

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
            doc.set(base, { pd, gab: g.valor, base });
        }

    // Só os nomes onde as duas regexes DIVERGEM: nos demais o resultado é idêntico por
    // construção e incluí-los só diluiria o efeito numa média.
    const alvo = [...doc.values()].filter(l => {
        const a = numAtual(l.base), b = numComRC(l.base);
        return String(a) !== String(b);
    });
    console.log(`universo fiscal com gabarito: ${doc.size}`);
    console.log(`onde "RC" muda o número extraído: ${alvo.length}\n`);
    if (!alvo.length) { console.log('nada a medir'); process.exit(0); }

    let s = 42;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const amostra = alvo.map(v => ({ v, r: rnd() })).sort((a, b) => a.r - b.r)
        .slice(0, QUANTOS).map(x => x.v);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    let n = 0, agiu = 0, ganhou = 0, perdeu = 0, igual = 0, calou = 0;
    const ex = [];
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

        const base = semAncora(l.pd);
        const novo = V.valorPelaAncora(text, numComRC(l.base));
        if (novo == null) { calou++; continue; }
        agiu++;

        const cBase = j.jValor(base, l.gab), cNovo = j.jValor(novo, l.gab);
        if (cNovo === 'ok' && cBase !== 'ok') { ganhou++; ex.push({ q: 'GANHOU', l, base, novo }); }
        else if (cNovo !== 'ok' && cBase === 'ok') { perdeu++; ex.push({ q: 'PERDEU', l, base, novo }); }
        else igual++;
    }

    console.log(`documentos lidos: ${n}`);
    console.log(`   âncora AGIU com "RC": ${agiu}   calou: ${calou}`);
    console.log(`   GANHOU ${ganhou}   PERDEU ${perdeu}   indiferente ${igual}`);
    console.log(`   líquido: ${ganhou - perdeu > 0 ? '+' : ''}${ganhou - perdeu}`);

    if (ex.length) {
        console.log('\nCASOS:');
        for (const e of ex.slice(0, 25))
            console.log(`   ${e.q}  nome=${String(e.l.gab).padStart(10)}` +
                `  sem-âncora=${String(e.base).padStart(11)} → com-RC=${String(e.novo).padStart(11)}` +
                `  ${e.l.base.slice(0, 40)}`);
    }
    process.exit(0);
})();
