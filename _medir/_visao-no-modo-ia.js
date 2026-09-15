/**
 * _medir/_visao-no-modo-ia.js — no modo IA, PDF-imagem deve ir para a VISÃO?
 *
 * Pedido do usuário (14/09/2026): "esses PDFs eram para funcionar igual os que não têm
 * OCR — ir para visão, e testar se isso melhora a veracidade e certeza dos campos".
 *
 * ── O defeito que motiva a medição ──────────────────────────────────────────
 * Em `analyzePdf`, o ramo `forceAI` trata PDF-imagem assim (process-folder.js:577-635):
 *
 *     transcrever() → se falhar, ocrViaBackend() → analyzeViaAI(texto) → RETURN
 *
 * O `return` da linha 633 acontece ANTES do bloco de visão (linha 650). Ou seja: no
 * modo IA — que é o modo de produção desde §16.1 — a imagem vira TEXTO (transcrito ou
 * de OCR) e o texto vai para a IA. A via de visão, medida e aprovada em §15.10 (OCR
 * preencheu 0 campos, visão preencheu 37), só é alcançada pelo caminho do parser local.
 *
 * Isso explica um número do baseline que eu não soube ler: 03.2026 tem 7 documentos de
 * origem `visão (IA)` — a via quase nunca é alcançada.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Nos PDF-imagem de 03.2026, lado a lado no MESMO documento:
 *
 *   A) via atual   — transcrever() → texto → `analyzeViaAI`
 *   B) via proposta — `lerPorVisao` (a nota vai direto ao modelo de visão)
 *
 * Julgadas contra o gabarito do NOME do arquivo (valor e número), que é a única
 * verdade independente disponível — [[gabarito-frouxo-inventa-erro]] adverte que uma
 * régua frouxa inventa erro, então o julgamento é o mesmo `_julgar-campos` do resto.
 *
 * "Veracidade e certeza" se decompõem em três medidas distintas:
 *   CAMPOS   — quantos campos vêm preenchidos (cobertura)
 *   CERTOS   — quantos batem com o gabarito (precisão)
 *   INVENTA  — campo preenchido que CONTRADIZ o gabarito (o pior caso: erro com
 *              cara de dado lido; é o que [[ia-le-nome-do-arquivo-sem-ocr]] registra)
 *
 * SOMENTE LEITURA — não grava no banco.
 *
 * Uso: node _medir/_visao-no-modo-ia.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const { lerPorVisao } = require('../routes/_nf-visao');
const { transcrever } = require('../routes/_nf-transcricao');
const full = require('../routes/_nf-ai-full');

const QUANTOS = parseInt(process.argv[2], 10) || 12;
const MES_DIR = '\\\\larsil-dell\\LA26.EXT.BANC\\2026.03.EXTRATOS CONTABILIDADE';
const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXT = /^0+\s*[.\-]/;
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

const CH_VALOR  = ['Valor total', 'Valor total da nota', 'Valor do boleto', 'Valor do serviço'];
const CH_NUMERO = ['Nº da NF-e', 'Nº da NFS-e', 'Número do documento'];
const primeiro = (o, ks) => { for (const k of ks) if (o && !VAZIO(o[k])) return o[k]; return null; };
const jNum = (lido, gab) => {
    if (gab == null || lido == null) return 's/gab';
    const a = String(lido).replace(/\D/g, ''), b = String(gab).replace(/\D/g, '');
    if (!a || !b) return 'vazio';
    return (a === b || a.endsWith(b) || b.endsWith(a)) ? 'ok' : 'erro';
};

(async () => {
    // Só os PDF-imagem: onde `pdf-parse` não acha texto nativo.
    const cand = [];
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) {
            const q = path.join(d, x.name);
            if (x.isDirectory()) { anda(q); continue; }
            if (!x.name.toLowerCase().endsWith('.pdf')) continue;
            if (RE_CPV.test(x.name) || RE_EXT.test(x.name)) continue;
            const g = j.gabaritos(x.name);
            if (g.valor == null) continue;   // sem gabarito não há como julgar
            cand.push({ p: q, nome: x.name, gab: g });
        }
    })(MES_DIR);

    const imagens = [];
    for (const f of cand) {
        if (imagens.length >= QUANTOS) break;
        try {
            const buffer = fs.readFileSync(f.p);
            const p = new PDFParse({ data: new Uint8Array(buffer) });
            const r = await p.getText();
            try { await p.destroy(); } catch (_) {}
            if ((r.text || '').replace(/\s/g, '').length < 40) imagens.push({ ...f, buffer });
        } catch (_) {}
    }

    console.log(`candidatos com gabarito: ${cand.length}`);
    console.log(`PDF-imagem medidos: ${imagens.length}\n`);
    if (!imagens.length) { console.log('nenhum PDF-imagem com gabarito — nada a medir'); process.exit(0); }

    const R = { A: { campos: 0, vOk: 0, vErr: 0, nOk: 0, nErr: 0, falhou: 0 },
                B: { campos: 0, vOk: 0, vErr: 0, nOk: 0, nErr: 0, falhou: 0 } };
    const linhas = [];

    for (const f of imagens) {
        const linha = { nome: f.nome, gab: f.gab };

        // ── A) via atual: transcrição → texto → IA
        //
        // `extrairNotaAI` devolve objeto PLANO ({tipo, emitente, valorTotal, numero…}),
        // não {campos}. A primeira versão deste script chamou `full.lerTudo(texto, nome)`
        // — função que não existe — e lia `r.campos`. O lado A teria falhado em 100% dos
        // casos e o placar sairia "visão ganha de lavada", lisonjeiro e falso.
        try {
            const t = await transcrever(f.buffer);
            if (t.texto && t.texto.replace(/\s/g, '').length >= 15) {
                const d = await full.extrairNotaAI({ text: t.texto, filename: f.nome, pages: '?' });
                if (d && d.error) { R.A.falhou++; linha.A = { erro: d.error }; }
                else {
                    const nc = ['tipo', 'emitente', 'cnpj', 'chaveAcesso', 'dataEmissao',
                                'dataVencimento', 'numero', 'valorTotal']
                        .filter(k => d[k] !== '' && d[k] != null && d[k] !== 0).length;
                    R.A.campos += nc;
                    const v = d.valorTotal > 0 ? d.valorTotal : null;
                    const n = d.numero || null;
                    const cv = j.jValor(v, f.gab.valor);
                    if (cv === 'ok') R.A.vOk++; else if (v != null) R.A.vErr++;
                    const cn = jNum(n, f.gab.numero);
                    if (cn === 'ok') R.A.nOk++; else if (n != null && f.gab.numero != null) R.A.nErr++;
                    linha.A = { nc, v, n, cv, cn };
                }
            } else { R.A.falhou++; linha.A = { erro: t.erro || 'sem texto' }; }
        } catch (e) { R.A.falhou++; linha.A = { erro: e.message }; }

        // ── B) via proposta: a nota direto ao modelo de visão
        try {
            const r = await lerPorVisao(f.buffer, f.nome, f.gab.valor);
            const d = (r && r.campos) || {};
            const nc = Object.keys(d).filter(k => !VAZIO(d[k])).length;
            R.B.campos += nc;
            const v = j.num(primeiro(d, CH_VALOR)), n = primeiro(d, CH_NUMERO);
            const cv = j.jValor(v, f.gab.valor);
            if (cv === 'ok') R.B.vOk++; else if (v != null) R.B.vErr++;
            const cn = jNum(n, f.gab.numero);
            if (cn === 'ok') R.B.nOk++; else if (n != null && f.gab.numero != null) R.B.nErr++;
            linha.B = { nc, v, n, cv, cn, veredito: r && r.veredito };
        } catch (e) { R.B.falhou++; linha.B = { erro: e.message }; }

        linhas.push(linha);
        const fa = linha.A.erro ? 'FALHOU' : `${linha.A.nc} campos, valor ${linha.A.cv}`;
        const fb = linha.B.erro ? 'FALHOU' : `${linha.B.nc} campos, valor ${linha.B.cv}`;
        console.log(`▸ ${f.nome.slice(0, 46)}\n   gabarito=${f.gab.valor}\n   A) texto+IA: ${fa}\n   B) VISÃO:    ${fb}`);
    }

    const n = imagens.length;
    console.log('\n' + '═'.repeat(64));
    console.log('RESULTADO — PDF-imagem no modo IA');
    console.log('═'.repeat(64));
    console.log(`                        A) texto+IA    B) VISÃO`);
    console.log(`   campos preenchidos   ${String(R.A.campos).padStart(9)}   ${String(R.B.campos).padStart(9)}`);
    console.log(`   VALOR certo          ${String(R.A.vOk).padStart(9)}   ${String(R.B.vOk).padStart(9)}   (de ${n})`);
    console.log(`   VALOR errado         ${String(R.A.vErr).padStart(9)}   ${String(R.B.vErr).padStart(9)}   ← campo preenchido e contradito`);
    console.log(`   NÚMERO certo         ${String(R.A.nOk).padStart(9)}   ${String(R.B.nOk).padStart(9)}`);
    console.log(`   NÚMERO errado        ${String(R.A.nErr).padStart(9)}   ${String(R.B.nErr).padStart(9)}`);
    console.log(`   falhou               ${String(R.A.falhou).padStart(9)}   ${String(R.B.falhou).padStart(9)}`);
    process.exit(0);
})();
