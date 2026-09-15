/**
 * routes/_nf-visao.js — lê um PDF-imagem enviando a PÁGINA para a IA.
 *
 * ── Por que existe ───────────────────────────────────────────────────────────
 * Um terço do acervo de 03.2026 (1.037 de 2.221) não tem texto selecionável. Para
 * esses, o caminho até 10/09/2026 era OCR (imagem → texto → parsers) e, quando o
 * OCR não respondia, o prompt mandava a IA deduzir do NOME DO ARQUIVO — 32
 * registros no acervo com dado inventado com cara de lido.
 *
 * MEDIDO em 10 PDFs-imagem (`_medir/_visao-vs-ocr.js`, Haiku 4.5):
 *
 *              OCR + parsers      VISÃO
 *   respondeu       10/10         10/10
 *   campos             0            37     ← zero contra trinta e sete
 *   tipo        "Não identificado"  RECIBO / EXTRATO / FATURA
 *
 * Custo: US$ 0,0022 por documento (US$ 2,24 para os 1.037 de março).
 *
 * ── O que este módulo NÃO faz ────────────────────────────────────────────────
 * Não substitui a leitura de PDF com texto nativo. Ali `pdf-parse` entrega o que o
 * emissor gravou, e trocar por reconhecimento visual seria trocar exato por
 * inferido. Isto vale só para o que é imagem.
 *
 * ── A trava ──────────────────────────────────────────────────────────────────
 * A medição pegou a IA lendo o campo ERRADO: nas planilhas de evolução de dívida
 * da CAIXA ela devolveu o SALDO DEVEDOR (R$ 2.663.696,90) no lugar do valor pago
 * (R$ 166.960,86). Não inventou — a página tem dezenas de valores e a coluna certa
 * não era óbvia.
 *
 * Daí duas defesas, e as duas são essenciais:
 *   1. o prompt exige `ondeAcheiOValor` — o rótulo da célula de origem. A leitura
 *      chega com a própria procedência, e quem conferir não precisa abrir o papel.
 *   2. `conferirValor()` compara o valor lido com o do NOME DO ARQUIVO (digitado à
 *      mão pela equipe: um gabarito independente). Divergiu sem ser razão inteira
 *      de parcela? O valor é marcado como não-confiável e NÃO vira valor do
 *      documento — os demais campos (emitente, número, data) continuam valendo.
 *   3. `pareceTruncamentoDeMilhar()` distingue erro de ESCALA de erro de CAMPO,
 *      para a conferência humana saber se basta reler o número ou se é preciso
 *      procurar outro no documento. Não corrige o valor: o truncamento apaga os
 *      centavos, e reconstituí-los seria inventar precisão.
 */
'use strict';
const { PDFParse } = require('pdf-parse');
const { callAnthropic, callOpenAI } = require('./_helpers');
const { dadosDoBoleto } = require('./_nf-parsers');

// Mesmo modelo que `_nf-ai-full.js` usa para texto. Manter o modelo fixa a
// variável: o que muda aqui é a ENTRADA (imagem em vez de texto).
const MODELO_ANTHROPIC = 'claude-haiku-4-5-20251001';
// `gpt-4.1-mini`, não `gpt-4o-mini`: o 4o-mini deforma números (19.485,07 → 19,49)
// e mediu 9 divergências em 20 contra 3 do 4.1-mini. Ver a medição no cabeçalho.
const MODELO_OPENAI = 'gpt-4.1-mini';

// Páginas enviadas por documento. 1 cobre a nota; o boleto anexo costuma ser a 2ª.
// Cada página custa ~1.200 tokens de entrada, então o teto importa.
const MAX_PAGINAS = 2;

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

O emitente é QUEM EMITIU o documento. LARSIL (qualquer variação: LARSIL FLORESTAL,
LARSIL SERVICOS FLORESTAIS) é sempre o TOMADOR/pagador, nunca o emitente.

BOLETO: copie a LINHA DIGITÁVEL inteira em "linhaDigitavel" — a sequência de 47
dígitos impressa no topo (ex.: "34190.57041 89072.570008 00000.000000 4 13720001316611").
Copie dígito por dígito, incluindo os espaços e pontos como estiverem. Se não houver
linha digitável legível, use "".

Devolva APENAS este JSON, sem markdown:
{
  "tipo": "NF|NFS|FATURA|RECIBO|BOLETO|IMPOSTO|CONSORCIO|EXTRATO|OUTRO",
  "emitente": "razão social de quem emitiu",
  "cnpjEmitente": "só dígitos",
  "numero": "número do documento/nota/contrato",
  "dataEmissao": "DD/MM/AAAA",
  "valorTotal": 0.00,
  "valorLiquido": 0.00,
  "linhaDigitavel": "",
  "retencoes": {"iss":0,"irrf":0,"inss":0,"csll":0,"cofins":0,"pis":0},
  "ondeAcheiOValor": "o RÓTULO exato da célula de onde tirou valorTotal",
  "legivel": true
}

FORMATO DOS NÚMEROS — o erro mais comum, leia com atenção:
No Brasil o PONTO separa milhar e a VÍRGULA separa decimais. Converta assim:
  "R$ 17.904,40"  → 17904.40     (ERRADO: 17.90 — isso perdeu os milhares)
  "R$ 166.960,86" → 166960.86    (ERRADO: 166.96)
  "R$ 35.012,74"  → 35012.74     (ERRADO: 35.01)
Antes de responder, confira: o número que você escreveu tem a mesma ORDEM DE
GRANDEZA do que está impresso? Um valor de "R$ 35.012,74" não pode virar 35.

Se o documento tem um único valor de pagamento, preencha valorTotal com ele.

COMPROVANTE DE PAGAMENTO / ESTORNO / TRANSFERÊNCIA: o valor é o da OPERAÇÃO —
o que foi debitado, pago ou estornado nesta transação. Ignore saldo anterior,
saldo final, limite disponível e totais do dia.

"ondeAcheiOValor" é obrigatório: permite conferir se o campo lido foi o certo.
"legivel": false se a imagem estiver ilegível — resposta válida e preferível a chutar.`;

/** Rasteriza as primeiras páginas do PDF em PNG base64. */
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

function extrairJson(txt) {
    try { return JSON.parse(txt); } catch (_) {}
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s >= 0 && e > s) { try { return JSON.parse(txt.slice(s, e + 1)); } catch (_) {} }
    return null;
}

async function perguntarAnthropic(imagens, modelo = MODELO_ANTHROPIC) {
    const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) return { erro: 'ANTHROPIC_API_KEY não configurada' };
    const content = imagens.map(b64 => ({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 },
    }));
    content.push({ type: 'text', text: 'Leia este documento e devolva o JSON.' });
    const r = await callAnthropic(key, {
        model: modelo, max_tokens: 1500, temperature: 0,
        system: PROMPT, messages: [{ role: 'user', content }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300)
        return { erro: `Anthropic HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { dados: extrairJson(body?.content?.[0]?.text ?? ''), uso: body?.usage || {} };
}

async function perguntarOpenai(imagens, modelo = MODELO_OPENAI) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return { erro: 'OPENAI_API_KEY não configurada' };
    const content = imagens.map(b64 => ({
        type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` },
    }));
    content.push({ type: 'text', text: 'Leia este documento e devolva o JSON.' });
    const r = await callOpenAI(key, {
        model: modelo, response_format: { type: 'json_object' },
        temperature: 0, max_tokens: 1500,
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content }],
    });
    if (!r.ok || r.httpCode < 200 || r.httpCode >= 300)
        return { erro: `OpenAI HTTP ${r.httpCode} ${r.error || ''}`.trim() };
    let body; try { body = JSON.parse(r.body); } catch (_) { return { erro: 'resposta não-JSON' }; }
    return { dados: extrairJson(body?.choices?.[0]?.message?.content ?? ''), uso: body?.usage || {} };
}

/**
 * Número vindo da IA. O JSON pede decimal com ponto, mas o modelo às vezes devolve
 * string no formato brasileiro — e aí a conversão ingênua erra por 1000x:
 * medido em 10/09/2026, "17.904,40" virava 17,90 (o `.` tratado como decimal e o
 * resto descartado). Por isso a forma é decidida pelo ÚLTIMO separador.
 */
const num = v => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = String(v).replace(/[^\d.,-]/g, '').trim();
    if (!s) return null;
    const ultVirgula = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
    if (ultVirgula > ultPonto) {
        // "17.904,40" — vírgula decimal, ponto é milhar.
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (ultPonto > ultVirgula) {
        // "17,904.40" (inglês) ou "17904.40". Vírgulas são milhar.
        s = s.replace(/,/g, '');
        // "17.904" sem centavos: se o que vem depois do ponto tem 3 dígitos e há
        // mais de um grupo, é separador de milhar, não decimal.
        const partes = s.split('.');
        if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3)) s = partes.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * O valor lido confere com o do NOME DO ARQUIVO?
 *
 * O nome é digitado à mão pela equipe a partir do papel — leitura independente da
 * IA, e o único gabarito disponível para documento que só existe como imagem.
 *
 * Devolve 'bate' | 'parcela' | 'diverge' | 'sem-gabarito'. 'parcela' é razão
 * inteira: o nome traz o valor PAGO e a página o total do contrato, que é
 * divergência legítima (a mesma que `razaoParcela` já trata no comparador).
 */
function conferirValor(valorIA, valorDoNome) {
    if (!(valorIA > 0) || !(valorDoNome > 0)) return 'sem-gabarito';
    if (Math.abs(valorIA - valorDoNome) <= 0.02) return 'bate';
    const r = valorIA / valorDoNome;
    const n = Math.round(r);
    if (n >= 2 && n <= 60 && Math.abs(r - n) < 0.02) return 'parcela';
    return 'diverge';
}

/**
 * O valor lido é o gabarito TRUNCADO no separador de milhar?
 *
 * MEDIDO em 10/09/2026: o gpt-4.1-mini devolveu 35,01 para um documento de
 * 35.012,74; o gpt-4o-mini fazia o mesmo com mais frequência (19.485,07 → 19,49,
 * aqui por arredondamento). O modelo leu os dígitos certos e errou a escala.
 *
 * Devolve `true` quando `lido × 1000` cai a menos de 1% do gabarito.
 *
 * **Não devolve um valor corrigido, de propósito.** Reconstituir `35,01 → 35.010`
 * perde os centavos originais para sempre — o número reconstruído nunca é o do
 * papel, só chega perto. Gravar isso como leitura seria inventar precisão que não
 * existe. O que se ganha ao detectar é DIAGNÓSTICO: a linha vai para conferência
 * dizendo "o modelo truncou o milhar", em vez de "valor incompatível", e quem
 * confere sabe que basta reler a escala, não o documento inteiro.
 */
function pareceTruncamentoDeMilhar(valorIA, valorDoNome) {
    if (!(valorIA > 0) || !(valorDoNome > 0)) return false;
    return Math.abs(valorIA * 1000 - valorDoNome) / valorDoNome <= 0.01;
}

/**
 * Lê um PDF-imagem por visão.
 *
 * @param {Buffer} buffer            o PDF
 * @param {string} nomeArquivo       para log
 * @param {number|null} valorDoNome  valor extraído do nome do arquivo (gabarito)
 * @param {string} [provider]        força 'openai' ou 'anthropic'; por padrão usa
 *                                   o medido (ver abaixo). Existe para a medição
 *                                   comparar os dois sobre os mesmos documentos —
 *                                   sem isto seria preciso alterar a configuração
 *                                   do usuário no meio do teste.
 * @param {string} [modelo]          força um modelo específico dentro do provider,
 *                                   para medir alternativas (gpt-4.1-mini, nano…)
 *                                   sem tocar no que a produção usa.
 * @returns {{campos, dados, veredito, uso}|{erro}}
 */
async function lerPorVisao(buffer, nomeArquivo = '', valorDoNome = null, provider = null, modelo = null) {
    let imagens;
    try {
        imagens = await paginasEmPng(buffer);
    } catch (e) { return { erro: `rasterização falhou: ${e.message}` }; }
    if (!imagens.length) return { erro: 'nenhuma página rasterizada' };

    // O provider desta via é OPENAI (gpt-4.1-mini) por padrão, e a escolha veio de
    // duas medições sobre os MESMOS 20 PDFs-imagem, conferidas contra o valor do
    // nome do arquivo (`_medir/_visao-modelos.js`, 10/09/2026):
    //
    //   modelo          DIVERGE (prompt v1)   DIVERGE (prompt v2)   US$/1.037 docs
    //   gpt-4o-mini              9                    —                  0,31
    //   gpt-4.1-nano             6                    8                  0,27
    //   gpt-4.1-mini             5                    3   ← melhor       0,89
    //   haiku-4.5                4                    4                  2,59
    //
    // O 4o-mini foi descartado por DEFORMAR números (19.485,07 → 19,49). O
    // 4.1-mini não faz isso e, com o prompt v2 (regra de conversão explícita +
    // regra de comprovante/estorno), ficou à frente do haiku por um terço do
    // preço. Os 3 erros que restam são as planilhas de dívida da CAIXA, onde
    // TODOS os modelos erram — não é diferencial entre eles.
    //
    // `settings.json` continua mandando na leitura por TEXTO; esta escolha vale só
    // para imagem, onde a medição existe. `provider`/`modelo` explícitos ainda
    // vencem, para a medição poder comparar.
    const prov = provider || 'openai';
    const r = prov === 'openai'
        ? await perguntarOpenai(imagens, modelo || MODELO_OPENAI)
        : await perguntarAnthropic(imagens, modelo || MODELO_ANTHROPIC);
    if (r.erro) return { erro: r.erro };
    const d = r.dados;
    if (!d || typeof d !== 'object') return { erro: 'JSON inválido da IA' };

    // A própria IA declarou que não conseguiu ler. É resposta legítima e melhor
    // que um chute — tratamos como falha para não gravar campo vazio como leitura.
    if (d.legivel === false) return { erro: 'IA marcou a imagem como ilegível', uso: r.uso };

    // O valor a conferir é o total; quando a IA deixa `valorTotal` vazio mas
    // preenche o líquido (acontece em comprovante bancário), o líquido é o único
    // valor do documento e precisa passar pelo MESMO gabarito — senão um número
    // errado entra sem conferência nenhuma, que é o pior desfecho.
    let valorIA = num(d.valorTotal) ?? num(d.valorLiquido);
    let origemValor = d.ondeAcheiOValor ? String(d.ondeAcheiOValor).slice(0, 120) : '';

    // ── A LINHA DIGITÁVEL vence a leitura do valor ───────────────────────────
    // Num boleto, os 47 dígitos codificam o valor nas posições 37-46. Isso não é
    // "ler um número da página": é decodificar um campo por POSIÇÃO, do mesmo
    // jeito que `dadosDoBoleto` já faz sobre texto (_nf-parsers.js). O projeto
    // sempre teve essa verificação — ela só nunca alcançava PDF-imagem, porque
    // dependia de haver texto.
    //
    // MOTIVO CONCRETO (10/09/2026): num boleto Itaú escaneado torto, a visão leu
    // "186,13" onde o Valor do Documento é 13.186,11 — pegou um fragmento e
    // embaralhou os dígitos. A linha digitável do mesmo papel devolve o valor
    // exato, porque errar um dígito nela quebra a decodificação inteira em vez de
    // produzir um número plausível.
    const linha = String(d.linhaDigitavel || '').replace(/\D/g, '');
    if (linha.length === 47) {
        const b = dadosDoBoleto(linha);
        if (b && b.valor > 0) {
            valorIA = b.valor;
            origemValor = `linha digitável (posições 37-46): ${linha.slice(37, 47)}`;
        }
    }

    let veredito = conferirValor(valorIA, valorDoNome);

    // Truncamento de milhar continua sendo `diverge` — o valor NÃO entra. Só se
    // registra o diagnóstico, para a conferência humana saber que o erro é de
    // escala (basta reler o número) e não de campo (precisa achar outro).
    const truncou = veredito === 'diverge' && pareceTruncamentoDeMilhar(valorIA, valorDoNome);

    // ── A trava ──────────────────────────────────────────────────────────────
    // Valor que diverge do gabarito sem ser parcela vai para um campo SEPARADO,
    // com a origem declarada. Não entra como "Valor total" — foi assim que a
    // medição pegou o saldo devedor da CAIXA entrando no lugar do valor pago.
    // Os outros campos continuam valendo: o erro foi de QUAL número, não de
    // leitura do documento.
    const campos = {};
    if (d.emitente && !/LARSIL/i.test(String(d.emitente))) campos['Emitente'] = String(d.emitente).trim();
    if (d.cnpjEmitente) {
        const cn = String(d.cnpjEmitente).replace(/\D/g, '');
        if (cn.length === 14 || cn.length === 11) campos['CNPJ emitente'] = cn;
    }
    if (d.numero) campos['Número do documento'] = String(d.numero).trim();

    // Data com sanidade de ANO. Medido em 10/09/2026: num comprovante de 02/03/2026
    // a IA devolveu "02/03/2028" — dia e mês certos, ano errado. Uma data no futuro
    // distante desloca o documento para uma pasta-mês inexistente e ele some da
    // conferência, então é melhor não gravar do que gravar errado. A janela aceita
    // do ano anterior ao próximo: cobre documento antigo arquivado agora e nota
    // emitida na virada do ano.
    const dt = String(d.dataEmissao || '').trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dt)) {
        const [dia, mes, ano] = dt.split('/').map(Number);
        const anoAgora = new Date().getFullYear();
        const plausivel = dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12
                       && ano >= anoAgora - 6 && ano <= anoAgora + 1;
        if (plausivel) campos['Data de emissão'] = dt;
    }

    const liq = num(d.valorLiquido);
    if (veredito === 'diverge') {
        // Nenhum valor entra como leitura boa: o gabarito diz que a IA pegou o
        // campo errado, e não há como saber se o líquido veio da mesma coluna.
        // Fica registrado com o rótulo explícito, para conferência humana.
        if (valorIA != null) {
            campos['Valor lido (não confere com o nome)'] = valorIA.toFixed(2).replace('.', ',');
            if (truncou) campos['Diagnóstico'] = 'o modelo truncou o separador de milhar — confira a escala';
        }
    } else {
        if (valorIA != null) campos['Valor total'] = valorIA.toFixed(2).replace('.', ',');
        if (liq != null) campos['Valor líquido'] = liq.toFixed(2).replace('.', ',');
    }

    // Retenções só quando a aritmética do papel fecha — a MESMA disciplina que
    // `retencaoDoParser` aplica ao texto (ver §15 do PROGRESSO). Sem isso, um
    // número plausível viraria retenção sem conferência.
    const ret = d.retencoes || {};
    const soma = ['iss', 'irrf', 'inss', 'csll', 'cofins', 'pis']
        .map(k => num(ret[k])).filter(v => v != null).reduce((s, v) => s + v, 0);
    const bruto = num(d.valorTotal), liquido = num(d.valorLiquido);
    if (soma > 0 && bruto && liquido && Math.abs(bruto - soma - liquido) <= 0.05) {
        if (num(ret.iss))    campos['ISS retido']    = num(ret.iss).toFixed(2).replace('.', ',');
        if (num(ret.irrf))   campos['IRRF retido']   = num(ret.irrf).toFixed(2).replace('.', ',');
        if (num(ret.inss))   campos['INSS retido']   = num(ret.inss).toFixed(2).replace('.', ',');
        if (num(ret.csll))   campos['CSLL retido']   = num(ret.csll).toFixed(2).replace('.', ',');
        if (num(ret.cofins)) campos['COFINS retido'] = num(ret.cofins).toFixed(2).replace('.', ',');
        if (num(ret.pis))    campos['PIS retido']    = num(ret.pis).toFixed(2).replace('.', ',');
    }

    // A procedência do número, para conferência humana sem abrir o PDF. Quando a
    // linha digitável venceu, ela é a origem — e o rótulo diz que veio de
    // decodificação, não de leitura.
    if (origemValor) campos['Origem do valor (visão)'] = origemValor;
    if (linha.length === 47) campos['Linha digitável'] = linha;
    campos['Origem dos dados'] = 'visão (IA)';

    return { campos, dados: d, veredito, truncou, uso: r.uso, tipo: String(d.tipo || '').toUpperCase() };
}

module.exports = {
    lerPorVisao, conferirValor, pareceTruncamentoDeMilhar, paginasEmPng, MAX_PAGINAS,
};
