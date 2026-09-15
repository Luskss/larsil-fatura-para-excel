/**
 * _medir/_vale-reler-ocr.js — as linhas lidas por OCR valem uma releitura?
 *
 * Pergunta do usuário (11/09/2026): falta reler os OCR também?
 *
 * Depois do scan com transcrição, 03.2026 tem:
 *     1131 Texto   ·   58 Imagem (transcrição IA)   ·   53 Imagem (OCR)   ·   2 Imagem
 *
 * As 53 de OCR foram lidas ANTES da transcrição existir — em rodadas onde o
 * servidor PaddleOCR estava de pé. A pergunta é se a transcrição as melhoraria.
 *
 * ── Por que NÃO é óbvio que sim ──────────────────────────────────────────────
 * A medição que aprovou a transcrição (`_transcrever-pdf-imagem.js`) comparou
 * contra documentos SEM leitura nenhuma (0 campos). Contra OCR que FUNCIONOU a
 * comparação é outra: pode empatar, e aí reler é gasto sem retorno. Pior, pode
 * PIORAR — e sobrescrever leitura boa é o dano que [[ocr-cai-com-medicoes-em-paralelo]]
 * documenta.
 *
 * ── O que este script mede, sem gravar nada ──────────────────────────────────
 * Para cada linha `Imagem (OCR)` com gabarito no nome:
 *   1. os campos que o OCR gravou CONFEREM com o nome do arquivo? (régua de
 *      `_julgar-campos.js`, a mesma das outras medições)
 *   2. numa AMOSTRA, transcreve o mesmo PDF e extrai — a transcrição acerta mais?
 *
 * O critério é o de sempre: ERRO decide, e mede-se o que GANHA e o que PERDE.
 * Releitura só se justifica com líquido positivo.
 *
 * SOMENTE LEITURA — não grava no banco.
 *
 * Uso: node _medir/_vale-reler-ocr.js [periodo] [quantos-transcrever]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const trans = require('../routes/_nf-transcricao');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');
const { callOpenAI } = require('../routes/_helpers');

const PERIODO = process.argv[2] || '03.2026';
const QUANTOS = parseInt(process.argv[3], 10) || 8;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';
const ROT = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

function promptExtracao() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_nf-ai-full.js'), 'utf8');
    return src.match(/const FULL_PROMPT\s*=\s*`([\s\S]*?)`;/)[1];
}

async function extrair(prompt, texto, nome, paginas) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    let t = String(texto || '');
    if (!t.replace(/\s/g, '').length) return { erro: 'texto vazio' };
    if (t.length > 14000) t = t.slice(0, 14000);
    const r = await callOpenAI(key, {
        model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0, max_tokens: 4000,
        messages: [{ role: 'system', content: prompt },
                   { role: 'user', content: `Arquivo: ${nome}\nPáginas: ${paginas}\n\nTexto do documento:\n----------\n${t}\n----------` }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300) return { erro: `HTTP ${r.httpCode}` };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'não-JSON' }; }
    const txt = body?.choices?.[0]?.message?.content ?? '';
    let d = null;
    try { d = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { d = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return d ? { lido: j.normaliza(d) } : { erro: 'JSON inválido' };
}

(async () => {
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    const rows = pf.csvToRows(r.recordset[0].CONTEUDO);
    const ocrRows = rows.filter(x => /\(OCR\)/.test(String(x.conteudo || '')));

    console.log(`${PERIODO}: ${rows.length} linhas, ${ocrRows.length} lidas por OCR\n`);

    // ── 1. como está a qualidade do que o OCR gravou? ───────────────────────
    const acc = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    const porCampo = {};
    for (const c of j.CAMPOS) porCampo[c] = { ok: 0, erro: 0, parcela: 0, vazio: 0, semGab: 0 };
    const semNenhum = [];
    for (const x of ocrRows) {
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        const g = j.gabaritos(base);
        const lido = {
            valor: j.num(primeiro(pd, ROT.valor)),
            numero: primeiro(pd, ROT.numero),
            data: primeiro(pd, ROT.data),
            emitente: primeiro(pd, ROT.emitente),
        };
        const ver = j.julgar(lido, g);
        for (const c of j.CAMPOS) {
            const k = ver[c] === 's/gab' ? 'semGab' : ver[c];
            porCampo[c][k]++; acc[k]++;
        }
        if (j.CAMPOS.every(c => VAZIO(lido[c]))) semNenhum.push(x);
    }
    console.log('1) QUALIDADE DO QUE O OCR JÁ GRAVOU');
    console.log('   campo        ok  ERRO  ~parc  ·vazio  s/gab');
    for (const c of j.CAMPOS) {
        const p = porCampo[c];
        console.log('   ' + c.padEnd(11) + String(p.ok).padStart(4) + String(p.erro).padStart(6) +
            String(p.parcela).padStart(7) + String(p.vazio).padStart(8) + String(p.semGab).padStart(7));
    }
    console.log(`   TOTAL: ok=${acc.ok}  ERRO=${acc.erro}  vazio=${acc.vazio}  s/gab=${acc.semGab}`);
    console.log(`   linhas SEM nenhum dos 4 campos: ${semNenhum.length}/${ocrRows.length}`);

    // ── 2. a transcrição melhoraria? (amostra) ──────────────────────────────
    // Prioriza quem tem gabarito de VALOR: é o campo que decide, e sem gabarito
    // não há como dizer quem acertou.
    const comGab = ocrRows.filter(x => j.gabaritos(path.basename(String(x.arquivo).replace(/#p\d+$/, ''))).valor != null);
    console.log(`\n   com gabarito de valor: ${comGab.length}/${ocrRows.length}`);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    const amostra = comGab.slice(0, QUANTOS);
    console.log(`\n2) TRANSCRIÇÃO × OCR (amostra de ${amostra.length})`);
    const prompt = promptExtracao();
    let ganha = 0, perde = 0, igual = 0;
    for (const x of amostra) {
        const base = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
        const abs = idx.get(base);
        if (!abs) { console.log(`   (não achei no disco) ${base.slice(0, 50)}`); continue; }
        const g = j.gabaritos(base);
        let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
        const lidoOcr = {
            valor: j.num(primeiro(pd, ROT.valor)), numero: primeiro(pd, ROT.numero),
            data: primeiro(pd, ROT.data), emitente: primeiro(pd, ROT.emitente),
        };
        const jOcr = j.julgar(lidoOcr, g);

        const t = await trans.transcrever(fs.readFileSync(abs));
        if (t.erro) { console.log(`   transcrição falhou: ${t.erro}  ${base.slice(0, 44)}`); continue; }
        const e = await extrair(prompt, t.texto, base, t.nPaginas);
        if (e.erro) { console.log(`   extração falhou: ${e.erro}  ${base.slice(0, 44)}`); continue; }
        const jTr = j.julgar(e.lido, g);

        let g2 = 0, p2 = 0;
        for (const c of j.CAMPOS) {
            const a = jOcr[c] === 'ok', b = jTr[c] === 'ok';
            if (b && !a) g2++; if (a && !b) p2++;
        }
        ganha += g2; perde += p2; if (!g2 && !p2) igual++;
        const marca = g2 > p2 ? '← transcrição MELHOR' : p2 > g2 ? '← transcrição PIOR' : '';
        console.log(`   ${base.slice(0, 48)}  ${marca}`);
        console.log(`      gabarito valor=${g.valor}`);
        console.log(`      OCR         ` + j.CAMPOS.map(c => `${c[0]}${j.MARCA[jOcr[c]]}`).join(' ') + `  valor=${lidoOcr.valor ?? '—'}`);
        console.log(`      transcrição ` + j.CAMPOS.map(c => `${c[0]}${j.MARCA[jTr[c]]}`).join(' ') + `  valor=${e.lido.valor ?? '—'}`);
    }

    console.log(`\n── VEREDITO ────────────────────────────────────────────────`);
    console.log(`   campos que a transcrição GANHA: ${ganha}`);
    console.log(`   campos que a transcrição PERDE: ${perde}`);
    console.log(`   documentos sem diferença:       ${igual}`);
    console.log(`   líquido: ${ganha - perde > 0 ? '+' : ''}${ganha - perde}`);
    if (ganha - perde > 0) console.log('\n   → vale reler as linhas de OCR.');
    else if (ganha === perde) console.log('\n   → EMPATE: reler é gasto sem retorno.');
    else console.log('\n   → NÃO reler: a transcrição perde para o OCR nestes documentos.');
    process.exit(0);
})();
