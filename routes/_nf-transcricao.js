/**
 * routes/_nf-transcricao.js — a IA no lugar do OCR: transcreve a PÁGINA em texto.
 *
 * ── Por que existe ───────────────────────────────────────────────────────────
 * 1.037 dos 2.221 PDFs de 03.2026 são IMAGEM. Para eles o caminho era o servidor
 * PaddleOCR, que (a) precisa estar de pé — caiu duas vezes em 10-11/09/2026,
 * gravando vazio sobre dado bom — e (b) mesmo funcionando entregou ZERO campo em 10
 * documentos medidos (`_medir/_visao-vs-ocr.js`).
 *
 * Este módulo faz o que `ocrViaBackend` faz — entra PDF, sai TEXTO — usando uma IA
 * multimodal como OCR. É substituta do OCR, não do extrator: o texto devolvido
 * segue para `classify` + parsers + `FULL_PROMPT`, que continuam decidindo quais
 * campos são o quê.
 *
 * ── A distinção que fez isto funcionar ───────────────────────────────────────
 * TRANSCREVER ≠ EXTRAIR, e a diferença foi medida (ver [[transcrever-nao-e-extrair]]).
 * Mandar a página e pedir o JSON de campos direto (`_nf-visao.js`) faz a IA escolher
 * QUAL número é o valor — e ela erra: leu "Valor Crédito" 42.015,60 onde a parcela
 * era 696,33, "SALDO DEVEDOR" no lugar do valor pago. Transcrevendo, quem escolhe
 * volta a ser o `FULL_PROMPT`, com suas regras de precedência e de pacote
 * multi-documento.
 *
 *   MEDIDO em PDFs COM texto nativo (onde existe verdade para comparar):
 *     extrair da imagem       11 erros   (ganha 2, perde 13)
 *     transcrever em lote      4 erros   (38 campos iguais ao nativo, 2 pior)
 *     transcrever POR PÁGINA   2 erros   (40 iguais, 0 pior) ← empata com o nativo
 *
 *   MEDIDO em 16 PDF-IMAGEM (`_medir/_transcrever-pdf-imagem.js`), o caso real:
 *     hoje          0 campos certos em 16 documentos
 *     transcrição  16 campos certos, 14/16 documentos, VALOR certo em 14 de 16
 *     visão direta 12 campos certos, valor certo em 10 de 16
 *
 * ── Por que UMA CHAMADA POR PÁGINA ───────────────────────────────────────────
 * Contra-intuitivo e medido: por página o recall de tokens numéricos CAIU
 * (67,3% → 63,2%) e os erros de extração caíram de 4 para 2. O que melhora não é
 * quantidade de texto, é ESTRUTURA — cada página isolada mantém o rótulo junto do
 * valor, e o separador de página impede que um número da pág. 2 seja lido como
 * continuação de um rótulo da pág. 1. Em lote a IA também RESUME documento longo
 * apesar da proibição (PRUDENTIAL: 32.007 chars nativos → 5.756 transcritos).
 *
 * ── O que este módulo NÃO resolve ────────────────────────────────────────────
 * Data. Dos 4 erros de data medidos, 2 são `31/12/1970` LITERALMENTE IMPRESSO na
 * apólice HDI (defeito do emissor, transcrito corretamente) e 2 são escolha entre
 * 75 datas de um carnê. Não é defeito da transcrição, e a defesa está em
 * `dataPlausivel` (em process-folder) e no fato de a data do documento vir da
 * SUBPASTA (ver [[data-do-documento-vem-da-pasta]]).
 *
 * Custo medido: US$ 0,0023/documento → ~US$ 2,41 pelos 1.037 PDF-imagem de março.
 */
'use strict';
const { PDFParse } = require('pdf-parse');
const { callOpenAI, callAnthropic } = require('./_helpers');

// `gpt-4.1-mini`, o mesmo da visão e pela mesma medição: o `gpt-4o-mini` DEFORMA
// números lendo imagem (19.485,07 → 19,49). Ver [[modelo-visao-medido-nao-suposto]].
const MODELO_OPENAI = 'gpt-4.1-mini';
const MODELO_ANTHROPIC = 'claude-haiku-4-5-20251001';

// Teto de páginas transcritas. Cada página é UMA chamada, então isto é o controle
// de custo: um carnê de 25 páginas custaria 25 chamadas e as páginas extras são
// parcelas repetidas, que `sanitizeParcelas` já trata a partir das primeiras.
const MAX_PAGINAS = Number(process.env.TRANSCRICAO_MAX_PAGINAS || 3);

// O prompt é todo escrito para impedir a IA de INTERPRETAR. Cada regra aqui
// corresponde a um erro observado na medição: resumir documento longo, converter
// "17.904,40" para 17904.40 (que destrói o formato que os parsers esperam),
// reordenar tabela, omitir rótulo (e sem rótulo o extrator não acha o campo).
const PROMPT = `Você é um OCR. Transcreva LITERALMENTE todo o texto visível nesta página.

REGRAS ABSOLUTAS:
· Copie cada caractere como está impresso. NÃO resuma, NÃO interprete, NÃO reordene.
· NÃO explique, NÃO comente, NÃO adicione cabeçalhos seus. Só o texto do papel.
· Preserve NÚMEROS exatamente: "17.904,40" se transcreve "17.904,40" — não
  17904.40, não 17,90. O ponto de milhar e a vírgula decimal ficam como estão.
· Preserve a ORDEM de leitura e a separação em linhas. Em tabela, mantenha cada
  linha da tabela numa linha do texto, com os campos separados por espaços.
· Preserve RÓTULOS junto de seus valores ("Valor Total da Nota  R$ 1.234,56").
  O rótulo é o que permite identificar o campo depois — nunca o omita.
· Transcreva TODOS os números da página, inclusive os que parecem irrelevantes.
· Códigos de barras / linha digitável: copie a sequência de dígitos como impressa.
· Se algo estiver ilegível, escreva [ilegível] naquele ponto e siga.

Devolva APENAS o texto transcrito, em texto puro, sem markdown e sem JSON.`;

/** Rasteriza as primeiras páginas em PNG base64. */
async function paginasEmPng(buffer, max = MAX_PAGINAS) {
    const pr = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const shot = await pr.getScreenshot();
        const pgs = (shot && shot.pages) || [];
        const out = [];
        for (const p of pgs.slice(0, max)) {
            const d = p.dataUrl || '';
            const i = d.indexOf(',');
            if (i > 0) out.push(d.slice(i + 1));
        }
        return out;
    } finally { try { await pr.destroy(); } catch (_) {} }
}

async function transcreverPagina(b64, i, total, provider, modelo) {
    if (provider === 'anthropic') {
        const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
        if (!key) return { erro: 'ANTHROPIC_API_KEY não configurada' };
        const r = await callAnthropic(key, {
            model: modelo || MODELO_ANTHROPIC, max_tokens: 8000, temperature: 0,
            system: PROMPT,
            messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
                { type: 'text', text: `Transcreva o texto desta página (página ${i} de ${total}).` },
            ] }],
        });
        if (!r.ok || r.httpCode < 200 || r.httpCode >= 300)
            return { erro: `Anthropic HTTP ${r.httpCode} ${r.error || ''}`.trim() };
        let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
        return { texto: body?.content?.[0]?.text ?? '', uso: body?.usage || {} };
    }

    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'OPENAI_API_KEY não configurada' };
    const r = await callOpenAI(key, {
        model: modelo || MODELO_OPENAI, temperature: 0, max_tokens: 8000,
        messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                { type: 'text', text: `Transcreva o texto desta página (página ${i} de ${total}).` },
            ] },
        ],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300)
        return { erro: `OpenAI HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { texto: body?.choices?.[0]?.message?.content ?? '', uso: body?.usage || {} };
}

/**
 * Transcreve um PDF-imagem em texto, UMA CHAMADA POR PÁGINA.
 *
 * Espelha o contrato de `ocrViaBackend`: recebe o buffer do PDF e devolve texto.
 * Em vez de lançar, devolve `{ erro }` — quem chama decide se cai para o OCR.
 *
 * @param {Buffer} buffer
 * @param {object} [opts] `{ maxPaginas, provider, modelo }` — os dois últimos
 *        existem para a MEDIÇÃO poder comparar alternativas sem alterar a
 *        configuração do usuário (a armadilha de [[modelo-visao-medido-nao-suposto]]:
 *        monkey-patch em `getActiveAiProvider` não funciona, o require congela).
 * @returns {{texto: string, nPaginas: number, falhas: number, uso}|{erro: string}}
 */
async function transcrever(buffer, opts = {}) {
    const max = Number(opts.maxPaginas || MAX_PAGINAS);
    let imagens;
    try {
        imagens = await paginasEmPng(buffer, max);
    } catch (e) { return { erro: `rasterização falhou: ${e.message}` }; }
    if (!imagens.length) return { erro: 'nenhuma página rasterizada' };

    const partes = [];
    let tokIn = 0, tokOut = 0, falhas = 0;
    for (let i = 0; i < imagens.length; i++) {
        const r = await transcreverPagina(imagens[i], i + 1, imagens.length, opts.provider, opts.modelo);
        if (r.uso) {
            tokIn  += r.uso.input_tokens  || r.uso.prompt_tokens     || 0;
            tokOut += r.uso.output_tokens || r.uso.completion_tokens || 0;
        }
        if (r.erro) {
            // Página que falhou NÃO invalida as outras: um documento de 3 páginas
            // com a 2ª falhando ainda tem a 1ª, que normalmente é a que traz a
            // nota. A falha fica MARCADA no texto para a conferência humana ver
            // que aquele trecho não foi lido — silenciar seria fingir leitura.
            partes.push(`=== página ${i + 1}: NÃO TRANSCRITA (${r.erro}) ===`);
            falhas++;
            continue;
        }
        // O separador de página é parte do resultado, não enfeite: sem ele um valor
        // da página 2 pode ser lido como continuação de um rótulo da página 1 — foi
        // o que a medição por página corrigiu em relação ao lote.
        partes.push(`=== página ${i + 1} ===\n${r.texto}`);
    }

    // Todas as páginas falharam: não há texto nenhum. Devolver string vazia faria o
    // chamador gravar row vazia como se tivesse lido — o modo de falha que
    // [[ocr-cai-com-medicoes-em-paralelo]] documenta (45 documentos perdidos,
    // incluindo notas de R$ 100.000).
    if (falhas === imagens.length) return { erro: `todas as ${falhas} páginas falharam` };

    return {
        texto: partes.join('\n\n'),
        nPaginas: imagens.length,
        falhas,
        uso: { input_tokens: tokIn, output_tokens: tokOut },
    };
}

module.exports = { transcrever, paginasEmPng, PROMPT, MAX_PAGINAS, MODELO_OPENAI };
