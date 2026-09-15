/**
 * routes/_valor-do-pagamento.js — decide QUAL valor do documento é o que se paga.
 *
 * O problema que este módulo resolve não é de leitura, é de ESCOLHA. Um documento
 * costuma trazer vários valores legítimos — o total da nota, a parcela do boleto, o
 * total de uma ordem de compra coletiva — e o pipeline vinha preferindo
 * `Valor total da nota`, que em pacote "+ BOL" é justamente o número errado.
 *
 * MEDIDO em 11/09/2026 sobre 5.306 documentos fiscais com gabarito no nome:
 *   - 46% dos erros de valor tinham o número CERTO já gravado na linha, em outra chave
 *   - o teto de uma escolha perfeita sobre o que já está no banco é 69% (hoje: 54%)
 *
 * Duas estratégias, medidas separadamente e depois juntas
 * (`_medir/_ancora-mais-regra.js`, amostra ALEATÓRIA de 300 documentos):
 *
 *   configuração            acertos   taxa
 *   hoje                       163    55%
 *   só regra de campo          181    61%
 *   ÂNCORA + regra             213    71%
 *
 * ── 1. A âncora pelo número da fatura ───────────────────────────────────────
 * A contabilidade digita o número da fatura no NOME do arquivo ("FT 245650"). Nos
 * PDFs que trazem o boleto, esse número está impresso ao lado do valor DAQUELA
 * fatura:
 *
 *     Data Doc   Número Doc   Valor do documento
 *     11/10/25   242502       125,00
 *
 * Achar o número no texto e ler o valor vizinho é determinístico — não depende de IA
 * nem de o valor ser o mais destacado da página. Mede 93% de acerto quando age, e age
 * em ~40% dos documentos. GANHA 34 / PERDE 1 numa amostra de 200.
 *
 * Isto resolve a classe que NENHUMA releitura resolveria: a ordem de compra coletiva
 * (ex.: BIOS NET, 12 pontos de internet numa OCP só, um arquivo por ponto). O PDF vale
 * 1.170,00 e cada arquivo paga 75,00 — só o número da fatura distingue.
 *
 * As duas travas de sanidade não são enfeite: sem elas a âncora devolvia 1,70 / 0,08
 * / 0,50 (juros ao dia e multa, que no boleto ficam logo depois do número). Com elas o
 * acerto subiu de 86% para 93% e as perdas caíram de 3 para 1.
 *
 * ── 2. A regra de precedência entre campos ──────────────────────────────────
 * Quando a âncora não age: `Valor do boleto` vence, MAS só se for menor que o total da
 * nota — senão é multa/juros (130,16 onde se pagou 78,09), não a parcela. Depois
 * `Valor total`, e por último a ordem antiga.
 *
 * ── O que este módulo NÃO faz ───────────────────────────────────────────────
 * Não apaga o valor lido. O número anterior vai para `Valor total da nota` (quando
 * ainda não estiver lá) e a proveniência fica em `Origem do valor pago`, para que a
 * conferência possa auditar a escolha em vez de confiar nela.
 */
'use strict';

// Valor monetário brasileiro: 1.234,56 · 75,00
//
// `(?<![\d.,])` no início NÃO é decorativo: sem ele a regex casa o SUFIXO de um número
// sem separador de milhar — em "1653,04" ela devolve "653,04", errado por um fator de
// 1.000 e com cara de certo. É a mesma armadilha que `valorDoNomeArquivo` documenta em
// process-folder.js, e ela apareceu de verdade num documento da IMOVEIS ANAPOLIS
// durante a validação do pipeline.
// `\d{1,3}(?:\.\d{3})*` cobre "1.653,04" mas não "1653,04" — quem escreve sem
// separador tem 4+ dígitos à esquerda. A alternativa `\d+` cobre esse caso; o
// lookbehind garante que ela pegue o número inteiro e não um sufixo dele.
const RE_MOEDA = /(?<![\d.,])(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}/g;

// Termos que denunciam encargo, não o valor do documento. A janela da âncora costuma
// pegar "cobrar juros de R$ 0,04 ao dia" logo depois do número da fatura.
//
// Ancorado no FIM (`\s*R?\$?\s*$`): o que reprova um candidato é o rótulo IMEDIATAMENTE
// antes dele ("juros de R$ ▸1,70"), não a palavra solta nas redondezas. Sem a âncora,
// "…1,70 ao dia Valor do documento ▸728,00" reprovava também o 728,00, porque "ao dia"
// caía na janela — a bateria pegou exatamente esse caso.
const RE_ENCARGO = /\b(JUROS?|MULTA|MORA|DESCONTO|ABATIMENTO)\b[^\d]{0,24}$/i;

// Piso relativo: candidato abaixo de 1% do maior valor do documento é encargo ou
// alíquota, não o valor pago.
const FRACAO_PISO = 0.01;

// Quanto texto depois do número ainda conta como "ao lado dele". 260 caracteres cobre
// o bloco "Data Doc / Número Doc / Valor do documento" do boleto padrão.
const JANELA = 260;

// O número só ancora se estiver rotulado como documento. "ORDEM DE COMPRA" e "PROJETO"
// ficam de FORA de propósito: são identificadores internos do comprador, não da nota, e
// foi um deles que fez a âncora ler a tabela de materiais em vez do boleto.
const RE_ROTULO_DOC = /\b(N[UÚ]MERO\s+DOC|N[º°o]?\s*DOC|DOCUMENTO|NOTA|NF-?S?e?|NFS|FATURA|\bFT\b|DUPLICATA|T[IÍ]TULO|RECIBO|RPS|SEU\s+N[UÚ]MERO)\b/i;
const ROTULO_ANTES = 90;
const ROTULO_DEPOIS = 60;

function paraNumero(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    let s = String(v).replace(/[^\d.,-]/g, '').trim();
    if (!s) return null;
    // A forma é decidida pelo ÚLTIMO separador, senão "17.904,40" vira 17,90.
    const uv = s.lastIndexOf(','), up = s.lastIndexOf('.');
    if (uv > up) s = s.replace(/\./g, '').replace(',', '.');
    else if (up > uv) {
        s = s.replace(/,/g, '');
        const p = s.split('.');
        if (p.length > 2 || (p.length === 2 && p[1].length === 3)) s = p.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Acha o número da fatura no texto e devolve o valor monetário ao lado dele.
 * Devolve null quando não há evidência — e "null" aqui significa "não sei", não
 * "não tem": quem chama deve então usar a regra de campos.
 *
 * @param {string} text     texto do documento
 * @param {string|number} numero  número da fatura (vem do NOME do arquivo)
 */
function valorPelaAncora(text, numero) {
    const num = String(numero == null ? '' : numero).replace(/\D/g, '');
    // Menos de 4 dígitos casaria com qualquer coisa (ano, código, quantidade).
    if (num.length < 4) return null;
    const t = String(text || '');
    if (!t) return null;

    const todos = (t.match(RE_MOEDA) || []).map(paraNumero).filter(v => v != null);
    if (!todos.length) return null;
    const piso = Math.max(...todos) * FRACAO_PISO;

    const candidatos = [];
    let from = 0;
    for (;;) {
        const i = t.indexOf(num, from);
        if (i < 0) break;
        from = i + num.length;
        // Colado em outros dígitos = linha digitável ou "nosso número": o número
        // aparece ali por acaso, não como rótulo.
        if (/\d/.test(t[i - 1] || ' ') || /\d/.test(t[i + num.length] || ' ')) continue;

        // O número precisa estar sendo usado como IDENTIFICADOR DE DOCUMENTO, não como
        // outra coisa que por acaso tem os mesmos dígitos. Num caso real (IMOVEIS
        // ANAPOLIS) o "901512" do nome era a ORDEM DE COMPRA, e a janela caiu na tabela
        // de materiais — a âncora devolveu um valor sem relação com o pagamento.
        //
        // Exige um rótulo de documento perto (antes ou logo depois). Onde o rótulo não
        // aparece, a âncora se cala e a precedência decide: silêncio é melhor que um
        // número plausível e errado.
        const contexto = t.slice(Math.max(0, i - ROTULO_ANTES), i + num.length + ROTULO_DEPOIS);
        if (!RE_ROTULO_DOC.test(contexto)) continue;

        const janela = t.slice(i, i + JANELA);
        const achados = janela.match(RE_MOEDA) || [];
        // O encargo se reconhece pelo que vem IMEDIATAMENTE antes do valor ("juros de
        // R$ 1,70"), não por aparecer em algum ponto da janela. Olhar a janela inteira
        // desde o número reprovava também o "Valor do documento 728,00" que vinha
        // DEPOIS do trecho de juros — o caso que a bateria pegou.
        const PRETO = 40;   // caracteres antes do valor que caracterizam o rótulo dele
        let cursor = 0;
        for (let k = 0; k < Math.min(achados.length, 3); k++) {
            const pos = janela.indexOf(achados[k], cursor);
            if (pos < 0) continue;
            cursor = pos + achados[k].length;
            const n = paraNumero(achados[k]);
            if (n == null || n < piso) continue;
            if (RE_ENCARGO.test(janela.slice(Math.max(0, pos - PRETO), pos))) continue;
            candidatos.push(n);
        }
    }
    if (!candidatos.length) return null;

    // O mais frequente entre as ocorrências: no boleto o par número/valor costuma
    // aparecer duas vezes (recibo do sacado e ficha de compensação), e a repetição é
    // justamente a confirmação.
    const cont = new Map();
    for (const v of candidatos) cont.set(v, (cont.get(v) || 0) + 1);
    return [...cont.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Precedência entre os campos já lidos, quando a âncora não tem o que dizer.
 * Devolve { valor, origem } — a origem entra na linha para poder auditar depois.
 */
function valorPorPrecedencia(pd) {
    const bol  = paraNumero(pd['Valor do boleto']);
    const nota = paraNumero(pd['Valor total da nota']);

    // O boleto é a parcela que se paga — mas só quando MENOR que o total da nota.
    // Boleto maior é multa/juros somados, e trocar ali seria piorar.
    if (bol != null && (nota == null || bol < nota)) return { valor: bol, origem: 'boleto' };

    const total = paraNumero(pd['Valor total']);
    if (total != null) return { valor: total, origem: 'valor total' };

    for (const k of ['Valor total da nota', 'Valor do serviço', 'Valor principal',
                     'Valor da prestação', 'Valor líquido']) {
        const v = paraNumero(pd[k]);
        if (v != null) return { valor: v, origem: k.toLowerCase() };
    }
    return { valor: null, origem: null };
}

const fmtBR = n => n.toFixed(2).replace('.', ',');

/**
 * Aplica a decisão sobre `dados_parser`, devolvendo um objeto NOVO.
 *
 * @param {object} pd          dados_parser já montado
 * @param {object} opts
 * @param {string} opts.text   texto do documento (para a âncora)
 * @param {string|number} opts.numeroDoNome  número da fatura vindo do NOME do arquivo
 */
function decidirValorPago(pd, { text, numeroDoNome } = {}) {
    if (!pd || typeof pd !== 'object') return pd;

    const anterior = paraNumero(pd['Valor total']);
    let escolhido = null, origem = null;

    if (text && numeroDoNome != null) {
        const v = valorPelaAncora(text, numeroDoNome);
        if (v != null) { escolhido = v; origem = 'âncora do nº da fatura'; }
    }
    if (escolhido == null) {
        const r = valorPorPrecedencia(pd);
        escolhido = r.valor; origem = r.origem;
    }
    if (escolhido == null) return pd;

    const out = { ...pd };

    // O valor anterior não se perde: se ele era o total da nota e a chave ainda não
    // existe, preserva-o ali. Quem confere precisa poder ver os dois números.
    if (anterior != null && Math.abs(anterior - escolhido) > 0.02
        && paraNumero(out['Valor total da nota']) == null) {
        out['Valor total da nota'] = fmtBR(anterior);
    }

    out['Valor total'] = fmtBR(escolhido);
    out['Origem do valor pago'] = origem;
    return out;
}

module.exports = {
    decidirValorPago, valorPelaAncora, valorPorPrecedencia, paraNumero,
    RE_MOEDA, RE_ENCARGO, FRACAO_PISO, JANELA,
};
