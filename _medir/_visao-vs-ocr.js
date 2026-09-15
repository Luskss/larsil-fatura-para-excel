/**
 * _medir/_visao-vs-ocr.js — mandar a PÁGINA para a IA supera o OCR?
 *
 * Pergunta do usuário: em vez de OCR (imagem → texto → parser), renderizar a
 * página e pedir à IA que leia o documento. Nunca foi testado.
 *
 * Onde isso pode ganhar, e por quê:
 *   · o OCR entrega texto PLANO e descarta o layout — é a causa dos bugs de
 *     §15.1/§15.2 (ISSQN e COFINS com o mesmo valor, indistinguíveis);
 *   · nos PDFs-imagem SEM OCR o prompt atual manda a IA deduzir do NOME do
 *     arquivo (§15.3) — 32 registros com dado inventado.
 *
 * Compara TRÊS leituras do mesmo PDF-imagem:
 *   (a) hoje    — o que está gravado no banco (via OCR, ou deduzido do nome)
 *   (b) OCR     — texto do servidor Python + parsers locais
 *   (c) VISÃO   — página renderizada em PNG + IA multimodal
 *
 * Custa chamadas de IA, então roda numa AMOSTRA e sempre imprime o custo.
 *
 * Uso: node _medir/_visao-vs-ocr.js [quantos] [--gravar-amostra]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const parsers = require('../routes/_nf-parsers');
const pare = require('../routes/_pareamento');
const { PDFParse } = require('pdf-parse');
const { callAnthropic } = require('../routes/_helpers');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const PASTA = '2026.03.EXTRATOS CONTABILIDADE';
const QUANTOS = parseInt(process.argv[2], 10) || 12;
const OCR_URL = 'http://127.0.0.1:5001/ocr';

// Modelo com visão. Haiku 4.5 é o mesmo que `_nf-ai-full.js` já usa para texto —
// manter o modelo fixa a variável: o que muda no teste é a ENTRADA (imagem × texto),
// não a capacidade do modelo.
const MODELO = 'claude-haiku-4-5-20251001';

// O prompt aprendeu com o primeiro teste. A IA leu a planilha de evolução de
// dívida da CAIXA e devolveu R$ 2.663.696,90 — que É um número da página, mas é o
// SALDO DEVEDOR, não o valor daquele pagamento (R$ 166.960,86, na coluna "Valor
// total pago"). Ela não inventou: pegou a coluna errada, porque "valor total" é
// ambíguo num extrato com dezenas de valores. Documento financeiro precisa da
// distinção explícita.
const PROMPT = `Você lê documentos financeiros e fiscais brasileiros a partir da IMAGEM da página.

Extraia SOMENTE o que estiver VISÍVEL na imagem. Nunca deduza do nome do arquivo,
nunca invente. Campo ausente = "" (string) ou 0 (número).

REGRA CRÍTICA sobre valorTotal — é o valor DESTE documento/operação:
  · nota fiscal   → o valor total da nota
  · boleto        → o valor a pagar do boleto
  · extrato/planilha de dívida (parcelas, saldo devedor, evolução):
      use o valor DA PARCELA ou do pagamento em questão.
      NUNCA use saldo devedor, saldo acumulado, valor do contrato ou total financiado.
      Se houver várias linhas, use a MAIS RECENTE (ou a de "valor total pago").
Na dúvida entre dois números, prefira o que representa UM pagamento, não um acumulado.

Devolva APENAS este JSON, sem markdown:
{
  "tipo": "NF|NFS|FATURA|RECIBO|BOLETO|IMPOSTO|CONSORCIO|EXTRATO|OUTRO",
  "emitente": "razão social de QUEM EMITIU (nunca o tomador LARSIL)",
  "cnpjEmitente": "só dígitos",
  "numero": "número do documento/nota/contrato",
  "dataEmissao": "DD/MM/AAAA",
  "valorTotal": 0.00,
  "valorLiquido": 0.00,
  "retencoes": {"iss":0,"irrf":0,"inss":0,"csll":0,"cofins":0,"pis":0},
  "ondeAcheiOValor": "o RÓTULO exato da célula de onde tirou valorTotal",
  "legivel": true
}

"ondeAcheiOValor" é obrigatório: permite conferir se o campo lido foi o certo.
"legivel": false se a imagem estiver ilegível — resposta válida e preferível a chutar.`;

async function textoDoPdf(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try { return ((await pr.getText()).text || ''); }
    catch (e) { return ''; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

async function pngDaPagina(buf) {
    const pr = new PDFParse({ data: new Uint8Array(buf) });
    try {
        const shot = await pr.getScreenshot();
        const pgs = (shot && shot.pages) || [];
        if (!pgs.length) return null;
        // dataUrl vem como "data:image/png;base64,XXXX" — a API quer só o base64.
        const d = pgs[0].dataUrl || '';
        const i = d.indexOf(',');
        return i > 0 ? d.slice(i + 1) : null;
    } catch (e) { return null; }
    finally { try { await pr.destroy(); } catch (_) {} }
}

async function ocrDoPdf(buf) {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/pdf' }), 'x.pdf');
    try {
        const r = await fetch(OCR_URL, { method: 'POST', body: fd, signal: AbortSignal.timeout(120_000) });
        if (!r.ok) return { erro: `HTTP ${r.status}` };
        const j = await r.json();
        return j.error ? { erro: j.error } : { texto: j.text || '' };
    } catch (e) { return { erro: e.message }; }
}

async function visao(b64) {
    const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) return { erro: 'sem ANTHROPIC_API_KEY' };
    const r = await callAnthropic(key, {
        model: MODELO,
        max_tokens: 1500,
        temperature: 0,
        system: PROMPT,
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
                { type: 'text', text: 'Leia este documento e devolva o JSON.' },
            ],
        }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300)
        return { erro: `HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (e) { return { erro: 'resposta não-JSON' }; }
    const txt = body?.content?.[0]?.text ?? '';
    const uso = body?.usage || {};
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {
        const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
        if (s >= 0 && e > s) { try { j = JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    }
    return j ? { dados: j, uso } : { erro: 'JSON inválido', uso };
}

function listarPdfs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listarPdfs(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}

const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXTRATO = /^0+\s*[.\-]/;
const ehAnexo = n => RE_CPV.test(n) || RE_EXTRATO.test(n);

const preencheu = v => v != null && String(v).trim() !== '' && String(v).trim() !== '—' && String(v).trim() !== '0';

(async () => {
    console.log(`modelo: ${MODELO}   amostra: ${QUANTOS}\n`);

    // Acha PDFs-imagem (sem texto) que NÃO são CPV/extrato.
    // A ordem da pasta agrupa por subpasta/banco, então pegar os N primeiros dá
    // uma amostra enviesada — no primeiro teste vieram 4 documentos da CAIXA
    // seguidos. Embaralhar com passo fixo espalha pela pasta inteira sem
    // depender de sorteio (a medição precisa ser reproduzível).
    const todos = listarPdfs(path.join(RAIZ_ARQ, PASTA)).filter(p => !ehAnexo(path.basename(p)));
    const passo = Math.max(1, Math.floor(todos.length / (QUANTOS * 6)));
    const ordem = [];
    for (let i = 0; i < todos.length; i += passo) ordem.push(todos[i]);
    for (const x of todos) if (!ordem.includes(x)) ordem.push(x);

    const imagens = [];
    console.error('[visao] procurando PDFs-imagem...');
    for (const abs of ordem) {
        if (imagens.length >= QUANTOS) break;
        const buf = fs.readFileSync(abs);
        const t = await textoDoPdf(buf);
        if (t.replace(/\s/g, '').length < 15) imagens.push({ abs, buf });
    }
    console.log(`PDFs-imagem selecionados: ${imagens.length}\n`);

    let ocrOk = 0, ocrCampos = 0, visaoOk = 0, visaoCampos = 0, ilegiveis = 0;
    let tokIn = 0, tokOut = 0;
    const linhas = [];

    for (const { abs, buf } of imagens) {
        const nome = path.basename(abs);
        console.error(`  ${nome.slice(0, 55)}`);

        // (b) OCR + parser local
        const o = await ocrDoPdf(buf);
        let ocrCamposN = 0, ocrTipo = '—';
        if (o.texto) {
            ocrOk++;
            const cls = parsers.classify(o.texto, nome);
            ocrTipo = cls.tipo;
            const d = cls.parser ? cls.parser(o.texto) : {};
            ocrCamposN = Object.values(d || {}).filter(preencheu).length;
            ocrCampos += ocrCamposN;
        }

        // (c) visão
        const b64 = await pngDaPagina(buf);
        let vTipo = '—', vCampos = 0, vErro = null, vDados = null;
        if (!b64) vErro = 'não rasterizou';
        else {
            const v = await visao(b64);
            if (v.erro) vErro = v.erro;
            else {
                vDados = v.dados;
                visaoOk++;
                if (vDados.legivel === false) ilegiveis++;
                vTipo = vDados.tipo || '—';
                vCampos = ['emitente', 'cnpjEmitente', 'numero', 'dataEmissao', 'valorTotal']
                    .filter(k => preencheu(vDados[k])).length;
                visaoCampos += vCampos;
            }
            if (v.uso) { tokIn += v.uso.input_tokens || 0; tokOut += v.uso.output_tokens || 0; }
        }

        // GABARITO independente: o valor no NOME do arquivo é digitado à mão pela
        // equipe a partir do papel. Não é infalível, mas é uma segunda leitura —
        // e é o único conferidor disponível para documento que só existe como
        // imagem. Bater com ele é evidência forte de que a IA leu o campo certo.
        const vNome = pare.valorDoNome ? pare.valorDoNome(nome) : null;
        const vIA = vDados ? Number(vDados.valorTotal || 0) : null;
        let veredito = '—';
        if (vNome && vIA) {
            const r = vIA / vNome;
            veredito = Math.abs(vIA - vNome) <= 0.02 ? 'BATE'
                : (Math.abs(r - Math.round(r)) < 0.02 && Math.round(r) >= 2) ? `${Math.round(r)}x (parcela?)`
                : `DIVERGE ${r.toFixed(1)}x`;
        }

        linhas.push({ nome, ocrTipo, ocrCamposN, vTipo, vCampos, vErro, vDados, vNome, vIA, veredito });
    }

    console.log('┌─ comparação por documento ─────────────────────────────────');
    for (const l of linhas) {
        console.log(`│ ${l.nome.slice(0, 58)}`);
        console.log(`│   OCR:   tipo=${String(l.ocrTipo).padEnd(16)} campos=${l.ocrCamposN}`);
        if (l.vErro) console.log(`│   VISÃO: ERRO — ${l.vErro}`);
        else {
            console.log(`│   VISÃO: tipo=${String(l.vTipo).padEnd(16)} campos=${l.vCampos}` +
                        (l.vDados && l.vDados.legivel === false ? '  [marcou ILEGÍVEL]' : ''));
            if (l.vDados) {
                console.log(`│      emitente="${String(l.vDados.emitente || '').slice(0, 34)}" ` +
                    `nº=${l.vDados.numero || '—'}`);
                console.log(`│      valor IA=${l.vIA}  nome=${l.vNome ?? '—'}  → ${l.veredito}`);
                if (l.vDados.ondeAcheiOValor)
                    console.log(`│      leu de: "${String(l.vDados.ondeAcheiOValor).slice(0, 48)}"`);
            }
        }
    }
    console.log('└────────────────────────────────────────────────────────────\n');

    const bate = linhas.filter(l => l.veredito === 'BATE').length;
    const parcela = linhas.filter(l => /parcela/.test(l.veredito)).length;
    const diverge = linhas.filter(l => /DIVERGE/.test(l.veredito)).length;
    console.log(`valor da IA × valor do nome do arquivo:`);
    console.log(`  BATE no centavo:   ${bate}`);
    console.log(`  razão inteira:     ${parcela}  (parcela — o nome traz o pago)`);
    console.log(`  DIVERGE:           ${diverge}  ← campo errado ou leitura errada\n`);

    console.log(`OCR   respondeu em ${ocrOk}/${imagens.length}   campos preenchidos: ${ocrCampos}`);
    console.log(`VISÃO respondeu em ${visaoOk}/${imagens.length}   campos preenchidos: ${visaoCampos}` +
                (ilegiveis ? `   (${ilegiveis} marcados ilegíveis pela própria IA)` : ''));

    // Custo: Haiku 4.5 — US$ 1/MTok entrada, US$ 5/MTok saída.
    const custo = (tokIn / 1e6) * 1 + (tokOut / 1e6) * 5;
    console.log(`\ntokens: ${tokIn} entrada + ${tokOut} saída`);
    console.log(`custo desta amostra: US$ ${custo.toFixed(4)}`);
    if (visaoOk) console.log(`custo por documento: US$ ${(custo / visaoOk).toFixed(5)}` +
        `  → 66 docs ≈ US$ ${(custo / visaoOk * 66).toFixed(2)}` +
        `  → 1.037 docs ≈ US$ ${(custo / visaoOk * 1037).toFixed(2)}`);
    process.exit(0);
})();
