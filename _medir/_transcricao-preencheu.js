/**
 * _medir/_transcricao-preencheu.js — a transcrição ajudou a PREENCHER os campos?
 *
 * Pergunta do usuário (11/09/2026): "pode medir se isso ajudou a preencher os campos?"
 *
 * O scan de 03.2026 com transcrição já rodou. O relatório agora tem quatro classes
 * na coluna `conteudo`:
 *     Texto · Imagem (transcrição IA) · Imagem (OCR) · Imagem
 *
 * A última — `Imagem` puro — é o documento que NENHUMA via leu: nem transcrição,
 * nem OCR. É o "antes" que sobrou, e por isso serve de controle.
 *
 * ── O que se mede aqui ───────────────────────────────────────────────────────
 * 1. PREENCHIMENTO: quantos dos 4 campos cada classe traz preenchidos. Sem
 *    gabarito — só "tem valor ali ou não". É a pergunta literal do usuário.
 * 2. ACERTO: dos preenchidos, quantos conferem com o nome do arquivo. Preencher
 *    com dado errado é PIOR que deixar vazio ([[sucesso-silencioso-engana-vigilancia]]),
 *    então preenchimento sozinho não responde.
 *
 * A régua é `_julgar-campos.js`, a mesma das outras medições — [[gabarito-frouxo-inventa-erro]]
 * mostra o que acontece quando cada script tem a sua.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_transcricao-preencheu.js [periodo]
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
const ROT = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido', 'Valor lido do texto transcrito'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

function classe(x) {
    const c = String(x.conteudo || '');
    if (/transcri/i.test(c)) return 'transcrição';
    if (/\(OCR\)/i.test(c))  return 'OCR';
    if (/^Imagem\s*$/i.test(c)) return 'imagem NÃO LIDA';
    if (/^Texto/i.test(c)) return 'texto nativo';
    return 'outro:' + c;
}

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    if (!r.recordset.length) { console.log('sem relatório para ' + PERIODO); process.exit(1); }
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO);

    const grupos = new Map();
    for (const x of rows) {
        const k = classe(x);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(x);
    }

    const ORDEM = ['transcrição', 'OCR', 'imagem NÃO LIDA', 'texto nativo'];
    const chaves = [...ORDEM.filter(k => grupos.has(k)), ...[...grupos.keys()].filter(k => !ORDEM.includes(k))];

    console.log(`${PERIODO}: ${rows.length} linhas\n`);

    // ── 1. PREENCHIMENTO ────────────────────────────────────────────────────
    console.log('1) PREENCHIMENTO — quantos dos 4 campos vêm com conteúdo');
    console.log('   classe             linhas  valor  numero   data  emit   média/4   0 campos');
    const guarda = new Map();
    for (const k of chaves) {
        const g = grupos.get(k);
        const p = { valor: 0, numero: 0, data: 0, emitente: 0 };
        let soma = 0, zero = 0;
        const lidos = [];
        for (const x of g) {
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const lido = {
                valor: j.num(primeiro(pd, ROT.valor)),
                numero: primeiro(pd, ROT.numero),
                data: primeiro(pd, ROT.data),
                emitente: primeiro(pd, ROT.emitente),
            };
            lidos.push({ x, lido });
            let n = 0;
            for (const c of j.CAMPOS) if (!VAZIO(lido[c])) { p[c]++; n++; }
            soma += n;
            if (!n) zero++;
        }
        guarda.set(k, lidos);
        const pct = c => (100 * p[c] / g.length).toFixed(0).padStart(4) + '%';
        console.log('   ' + k.padEnd(18) + String(g.length).padStart(6) +
            pct('valor') + pct('numero') + pct('data') + pct('emitente') +
            (soma / g.length).toFixed(2).padStart(9) +
            `   ${zero} (${(100 * zero / g.length).toFixed(0)}%)`);
    }

    // ── 2. ACERTO ───────────────────────────────────────────────────────────
    console.log('\n2) ACERTO — dos que têm gabarito no nome, quantos conferem');
    console.log('   classe                ok   ERRO  ~parc  ·vazio    s/gab   taxa');
    for (const k of chaves) {
        const acc = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
        for (const { x, lido } of guarda.get(k)) {
            const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            const ver = j.julgar(lido, j.gabaritos(base));
            for (const c of j.CAMPOS) acc[ver[c] === 's/gab' ? 'semGab' : ver[c]]++;
        }
        const julgados = acc.ok + acc.erro + acc.parcela + acc.vazio;
        const taxa = julgados ? (100 * acc.ok / julgados).toFixed(0) + '%' : '—';
        console.log('   ' + k.padEnd(18) + String(acc.ok).padStart(6) + String(acc.erro).padStart(7) +
            String(acc.parcela).padStart(7) + String(acc.vazio).padStart(8) +
            String(acc.semGab).padStart(9) + taxa.padStart(7));
    }

    // ── 3. O campo que decide, isolado ──────────────────────────────────────
    console.log('\n3) SÓ O VALOR (o campo que casa lançamento com documento)');
    console.log('   classe             c/gab     ok   ERRO  ~parc  vazio');
    for (const k of chaves) {
        const a = { ok: 0, erro: 0, parcela: 0, vazio: 0 };
        let comGab = 0;
        for (const { x, lido } of guarda.get(k)) {
            const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            comGab++;
            a[j.jValor(lido.valor, g.valor)]++;
        }
        console.log('   ' + k.padEnd(18) + String(comGab).padStart(5) + String(a.ok).padStart(7) +
            String(a.erro).padStart(7) + String(a.parcela).padStart(7) + String(a.vazio).padStart(7));
    }

    // ── 4. as que continuam sem leitura ─────────────────────────────────────
    const naoLidas = grupos.get('imagem NÃO LIDA') || [];
    if (naoLidas.length) {
        console.log(`\n4) AS ${naoLidas.length} QUE CONTINUAM SEM LEITURA`);
        for (const x of naoLidas)
            console.log(`   ${String(x.arquivo).slice(0, 70)}`);
    }
    process.exit(0);
})();
