/**
 * routes/_nf-parsers.js
 * Classificação e parsers locais portados de conferencia-notas.html para uso no
 * backend (process-folder.js). Mantém a MESMA lógica de regex do front para que
 * o processamento automático produza os mesmos campos em `dados_parser`.
 */
'use strict';

// Normalização: remove acentos, caixa alta, colapsa espaços
function norm(s) {
    return (s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Extração genérica de CNPJ — funciona em qualquer documento (NFS, FATURA, RECIBO).
// Procura primeiro um CNPJ rotulado ("CNPJ: 00.000.000/0001-00"); se não houver,
// pega o primeiro CNPJ formatado válido do texto. Retorna '' se nada bater.
const CNPJ_LABELED_RE = /\bCNPJ[:\s/]*?(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/;
const CNPJ_ANY_RE     = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/;
function extrairCnpj(text) {
    const t = norm(text);
    const m = t.match(CNPJ_LABELED_RE) || t.match(CNPJ_ANY_RE);
    return m ? m[1].trim() : '';
}

// Extração do NOME do emitente a partir do NOME DO ARQUIVO.
// IMPORTANTE: o nome do arquivo é usado APENAS para o emitente — nunca para
// classificar o tipo do documento (isso continua 100% por conteúdo).
//
// Padrão dos nomes: "NNN.DOC- valor - YYYY.MM.DD. EMITENTE. TIPO numero ..."
// O emitente fica entre a DATA e o marcador de tipo de documento (RCB/RC/FAT/
// FT/NFS/NF/BOL/GUIA/etc.) ou o fim do nome.
const TIPO_DOC_RE = /\b(RCB|RC|RECIBO|FAT|FT|FATURA|NFS|NFE|NF|BOL|BOLETO|GUIA|DARF|GPS|INSS|FGTS|CTE|DACTE|IMOVEL|OCP|OC)\b/;
function limpaBordas(s) {
    return s.replace(/^[\s.,\-]+|[\s.,\-]+$/g, '').trim();
}
function extrairEmitente(filename = '') {
    const t = norm(String(filename).replace(/\.pdf$/i, ''));
    // 1) corta tudo até (e incluindo) a DATA do documento. Aceita a data completa
    //    (YYYY.MM.DD / DD.MM.YYYY) ou apenas o ANO solto (ex.: "2026.ALGAR").
    let resto = t;
    const data = t.match(/(?:20\d{2}\.\d{2}\.\d{2}|\d{2}\.\d{2}\.20\d{2}|\b20\d{2})\.?/);
    if (data) resto = t.slice(data.index + data[0].length);
    else {
        const pref = t.match(/^\d{1,4}\.?DOC[-\s]*[\d.,]*\s*-?\s*/);
        if (pref) resto = t.slice(pref[0].length);
    }
    // 2) o emitente vai até o 1º marcador de tipo de documento. Se cortar deixar
    //    vazio/curto (o marcador faz parte do nome, ex.: "LARSIL"/"MS CONSORCIO"),
    //    mantém o trecho inteiro sem cortar.
    const tipo = resto.match(TIPO_DOC_RE);
    let nome = limpaBordas(tipo ? resto.slice(0, tipo.index) : resto);
    if (nome.length < 2) nome = limpaBordas(resto);
    // remove números/códigos finais (ex.: "MS CONSORCIO G712 C2950" → "MS CONSORCIO")
    nome = limpaBordas(nome.replace(/\s+[A-Z]?\d[\w]*(\s+[A-Z]?\d[\w]*)*$/, ''));
    if (nome.length < 2 || /^[\d.,\s]+$/.test(nome)) return '';
    return nome;
}

// Indício de que o emitente é um ÓRGÃO PÚBLICO (governo). Cobre nome do emitente
// e termos canônicos de documentos públicos. Usado para classificar como IMPOSTO.
// Termos que indicam órgão público NO NOME DO EMITENTE (do arquivo).
// Não testamos o texto completo do PDF — termos como "ESTADO DE", "UNIAO", "MUNICIPIO"
// aparecem em qualquer endereço ou cláusula e causam falsos positivos (ex: Localiza).
const GOVERNO_RE = /\bGOVERNO\b|\bPREFEITURA\b|\bMUNICIPIO\b|\bSECRETARIA\b|\bMINISTERIO\b|\bRECEITA FEDERAL\b|\bFAZENDA (?:NACIONAL|ESTADUAL|MUNICIPAL|PUBLICA)\b|\bSEFAZ\b|\bESTADO DE\b|\bUNIAO\b|\bTRIBUNAL\b|\bAUTARQUIA\b/;
function emitenteEhGoverno(text, emitente = '') {
    return GOVERNO_RE.test(norm(emitente));
}

// ── classificação em 7 categorias: CONSORCIO · CTE · FATURA · IMPOSTO · NF · NFS · RECIBO ─
const STRONG = [
    ['CONSORCIO', /\bCONSORCIO\b|COTA DE CONSORCIO|PARCELA DE CONSORCIO|\bADMINISTRADORA DE CONSORCIOS?\b|\bGRUPO DE CONSORCIO\b/],
    ['CTE',     /\bDACTE\b|CONHECIMENTO DE TRANSPORTE|DOCUMENTO AUXILIAR DO CONHECIMENTO|\bCT-?E\b|\bMDF-?E\b|TRANSPORTE RODOVIARIO DE CARGAS/],
    ['IMPOSTO', /\bDARF\b|ARRECADACAO DE RECEITAS FEDERAIS|GUIA DA PREVIDENCIA SOCIAL|\bDCTFWEB\b|FGTS DIGITAL|GUIA DO FGTS|\bGFD\b|DARF-?SIMPLES/],
    ['NF',      /\bDANFE\b|DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONI|NATUREZA DA OPERACAO/],
    ['NFS',     /\bNFS-?E\b|NOTA FISCAL DE SERVICOS? ELETRONICA|NOTA FISCAL ELETRONICA DE SERVICOS?/],
];

const CTE_STRONG_RE     = STRONG[1][1];
const TRANSPORT_HINT_RE = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|TRANSPORTE DE CARGA/;

const WEAK = [
    ['IMPOSTO', /\bGUIA\b|\bDCTFWEB\b|\bINSS\b|\bFGTS\b|\bDARF\b|\bGPS\b/],
    ['NFS',     /NOTA FISCAL DE SERVICOS?/],
    ['FATURA',  /\bFATURA\b/],
    ['NF',      /NOTA FISCAL/],
    ['RECIBO',  /\bRECIBO\b/],
];

const PARSERS = { CTE: parseCte, NF: parseDanfe, IMPOSTO: parseImposto, NFS: parseNfse };

function mk(tipo, evidencia, origem) {
    return { tipo, evidencia, origem, parser: PARSERS[tipo] || null };
}

// Classificação do TIPO é 100% por CONTEÚDO. O nome do arquivo é usado APENAS
// para identificar o EMITENTE (e, daí, detectar emitente público → IMPOSTO).
function classify(text, filename = '') {
    const t = norm(text);
    const emitente = extrairEmitente(filename);

    // 1) Marcadores FORTES de tipo de documento (alta confiança) vêm primeiro:
    //    um DANFE/NFS/CTE legítimo emitido por órgão público mantém seu tipo.
    for (const [cat, re] of STRONG) { const m = t.match(re); if (m) return mk(cat, m[0], 'conteúdo'); }

    // 2) Emitente é órgão público → IMPOSTO (vence os marcadores fracos, ex.: RECIBO).
    //    Olha o nome do emitente (do arquivo) e termos de órgão público no conteúdo.
    if (emitenteEhGoverno(text, emitente)) {
        const ev = emitente && GOVERNO_RE.test(norm(emitente)) ? `emitente: ${emitente}` : 'emitente público';
        return mk('IMPOSTO', ev, 'conteúdo (emitente)');
    }

    // 3) Marcadores FRACOS de conteúdo (último recurso)
    for (const [cat, re] of WEAK)   { const m = t.match(re); if (m) return mk(cat, m[0], 'conteúdo (fraco)'); }

    return { tipo: 'Não identificado', evidencia: '—', origem: '—', parser: null };
}

// ── parser: DANFE (NF-e de produto) ─────────────────────────────────────────
function parseDanfe(text) {
    const t = norm(text);
    const grab = re => { const m = t.match(re); return m ? m[1].trim() : '—'; };
    // `chaveAcessoDoTexto` varre TODAS as sequências de 44 dígitos e devolve a primeira
    // que passa na validação. A regex própria que estava aqui (`\d[\d ]{42,52}\d`)
    // aceitava de 44 a 54 dígitos e gravava sem conferir nada: medido em 09/09/2026,
    // 429 das 1.554 chaves do acervo não têm sequer 44 dígitos — vieram daqui.
    const chave = chaveAcessoDoTexto(t);
    const ocpM = t.match(/(?:ORDEM\s+DE\s+COMPRA[-–\s]*OCP|OCP|ORDEM\s+DE\s+COMPRA)[:\s#Nº°.]*(\d{4,})/i)
              || t.match(/\bOC[:\s#]*(\d{4,})\b/i);
    return {
        'Chave de acesso':    chave ? chave.replace(/\s+/g, '') : '—',
        'Nº da NF-e':         grab(/(?:NR\.?DOCUMENTO|N[º°]?\.?\s*(?:DA )?NF-?E|NUMERO)\D{0,8}(\d{3,9})/),
        'Série':              grab(/SERIE\D{0,4}(\d{1,3})/),
        'Natureza da operação': grab(/NATUREZA DA OPERACAO[:\s]*([A-Z0-9 .,/-]{4,40})/),
        'Data de emissão':    grab(/(?:DATA (?:DE |DA )?EMISSAO|EMISSAO)[:\s]*([\d/]{8,10})/),
        'CNPJ emitente':      grab(/\bCNPJ[:\s]*(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/),
        'Valor total da nota':grab(/VALOR TOTAL DA NOTA[:\s]*R?\$?\s*([\d.,]{3,})/),
        'Ordem de Compra':    ocpM ? ocpM[1] : '—',
    };
}

// ── parser: CTE / DACTE (conhecimento de transporte) ────────────────────────
function parseCte(text) {
    const t = norm(text);
    const grab = re => { const m = t.match(re); return m ? m[1].trim() : '—'; };
    // Mesma correção de parseDanfe: valida em vez de pegar a primeira sequência longa.
    const chave = chaveAcessoDoTexto(t);
    return {
        'Chave de acesso':      chave ? chave.replace(/\s+/g, '') : '—',
        'Nº do CT-e':           grab(/(?:NR\.?DOCUMENTO|N[º°]?\.?\s*(?:DO )?CT-?E)\D{0,8}(\d{3,9})/),
        'Data de emissão':      grab(/(?:DATA (?:DE |DA )?EMISSAO|EMISSAO)[:\s]*([\d/]{8,10})/),
        'CNPJ emitente':        grab(/\bCNPJ[:\s]*(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/),
        'Valor da prestação':   grab(/VALOR TOTAL DA PRESTACAO[:\s]*R?\$?\s*([\d.,]{3,})/),
    };
}

// ── parser: NFS-e (nota de serviço) ──────────────────────────────────────────
// NFS-e não tinha parser: caía no genérico, que grava um "Valor total" só. Isso
// é a origem de um erro visível no painel — o card "Valores divergentes" acusava
// a CORREA TRUCK HOUSE NF 377 com R$ 184,50 de diferença, quando 184,50 é o ISSRF
// RETIDO NA FONTE: a planilha lança o serviço bruto (3.690,00) e o boleto cobra o
// líquido (3.505,50). Os dois números estão certos; são campos diferentes.
//
// A nota de serviço traz os três valores impressos, então a conferência pode ser
// ARITMÉTICA em vez de heurística: bruto − retenções = líquido.
//
// MEDIDO em 10/09/2026 sobre jan–jun/2026 (`_medir/_retencao-*.js`), 131
// divergências fora parcela: 110 têm documento MENOR que o lançado e, dessas, 95
// declaram retenção no papel. Adivinhar a alíquota foi medido e REPROVADO
// (`_retencao-aritmetica.js`): explica só 38%, porque o ISS é municipal — ARPSEG
// retém 3,52%, AGRIPONTA 3,97%, ANDRADE MARTINS 3,33%, nenhuma na tabela legal.
// Aumentar a lista de alíquotas até cobri-las faria a regra "explicar" qualquer
// diferença pequena, inclusive erro de digitação — o oposto do objetivo.
//
// Por isso lemos o que está ESCRITO. Cada tributo é buscado pelo rótulo próprio.
function parseNfse(text) {
    const t = norm(text);
    const grab = re => { const m = t.match(re); return m ? m[1].trim() : '—'; };
    const N = '([\\d.]{0,12}\\d,\\d{2})';

    // ISSQN é lido separado dos demais e NÃO entra na soma de retenções: medido em
    // jan–jun/2026, nas notas da ROCHA & ROCHA e da CONSEGMA o rótulo `ISSQN` vem
    // seguido da BASE DE CÁLCULO (ISSQN 17.000,00 = o próprio bruto), não do
    // imposto. Somá-lo estouraria a conta e transformaria retenção legítima em
    // divergência gigante — exatamente o erro que este parser existe para evitar.
    // O ISS efetivamente RETIDO tem rótulo próprio: ISSRF / ISS RETIDO.
    // `(?!\s*%)` em TODO tributo: o valor seguido de "%" é alíquota, não imposto.
    // Sem isso, "PIS/COFINS/CSLL 4,65%" fazia o rótulo `CSLL` capturar 4,65 — o
    // mesmo erro que reprovou a leitura da SKILLHUB (alíquotas no lugar de valores).
    const pc = `[:\\s]*R?\\$?\\s*${N}(?!\\s*%)`;
    const retencoes = {
        'ISSRF':  grab(new RegExp(`\\b(?:ISSRF|ISS RETIDO|ISS RETIDO NA FONTE)\\b${pc}`)),
        // `IR` sozinho é rótulo real: no layout de Cascavel/PR a linha é
        // "ISSQN … ISSRF … IR 89,72 INSS … CSLL … COFINS … PIS". Buscar só
        // IRRF perdia esse valor (GENUSCLIN NF 37846, 10/09/2026). O `\b` e a
        // exigência de número com centavos logo depois evitam casar com "IR" de
        // outra palavra — `norm` já removeu acentos e colapsou espaços.
        'IRRF':   grab(new RegExp(`\\b(?:IRRF|IR RETIDO|IR)\\b${pc}`)),
        'INSS':   grab(new RegExp(`\\bINSS\\b${pc}`)),
        'CSLL':   grab(new RegExp(`\\bCSLL\\b${pc}`)),
        'COFINS': grab(new RegExp(`\\bCOFINS\\b${pc}`)),
        'PIS':    grab(new RegExp(`\\bPIS\\b${pc}`)),
    };

    // A PRÓPRIA NOTA já soma as retenções federais em "TOTAL TRIB. FEDERAIS" —
    // preferir esse número a somar rótulo por rótulo elimina duas classes de erro
    // de uma vez: tributo cujo rótulo variou (o `IR` acima) e tributo lido da
    // coluna errada (a GENUSCLIN traz COFINS 179,43 e ISSQN 179,43 no mesmo
    // valor, e a leitura solta não distingue qual foi capturado).
    //
    // Medido em 10/09/2026 na NFS-e da GENUSCLIN: IR 89,72 + CSLL 59,81 +
    // COFINS 179,43 + PIS 38,88 = 367,84, idêntico ao TOTAL TRIB. FEDERAIS
    // impresso — e 5.981,00 − 367,84 = 5.613,16, o líquido. `retencaoDoParser`
    // continua exigindo que a conta feche, então este campo é conveniência
    // verificada, nunca um valor aceito sem conferência.
    // Dois layouts, dois nomes para o mesmo campo (medido em 03.2026):
    //   · municipal (Cascavel/PR):  "TOTAL TRIB. FEDERAIS 367,84"
    //   · NACIONAL (novo padrão):   "TOTAL DAS RETENCOES FEDERAIS R$ 184,79"
    // O `R$` entre rótulo e número aparece só no nacional — daí `R?\$?` em todos
    // os campos deste parser.
    const totalFederais = grab(new RegExp(
        `TOTAL (?:TRIB\\.? FEDERAIS|DAS RETENCOES FEDERAIS)[:\\s]*R?\\$?\\s*${N}`));

    // O layout nacional agrupa os três num rótulo só, com a ALÍQUOTA no meio:
    // "PIS/COFINS/CSLL 4,65%: R$ 25,39" (G.A.R MEDICINA NF 216). Nenhum rótulo
    // isolado existe nessa nota, então sem isto a conta não teria como fechar.
    //
    // O `(?:\d+,\d+\s*%\s*)?` pula a alíquota explicitamente, e o `(?!\s*%)` no
    // fim recusa capturar um percentual como se fosse valor — sem os dois, a
    // regex devolvia 4,65 (a alíquota) em vez de 25,39 (o imposto), que é
    // justamente o erro da SKILLHUB que este parser existe para não cometer.
    const pisCofinsCsll = grab(new RegExp(
        `PIS\\s*/\\s*COFINS\\s*/\\s*CSLL[:\\s]*(?:\\d+[.,]\\d+\\s*%\\s*)?[:\\s]*R?\\$?\\s*${N}(?!\\s*%)`));

    // Idem: "CONTRIBUICOES SOCIAIS - RETIDAS R$ 139,72" é o bloco social do
    // layout nacional, irmão de `IRRF` — os dois somados dão o total federal.
    const contribSociais = grab(new RegExp(
        `CONTRIBUICOES SOCIAIS\\s*-?\\s*RETIDAS[:\\s]*R?\\$?\\s*${N}`));

    return {
        'Nº da NFS-e':        grab(/(?:NUMERO DA NOTA|N[º°]?\.?\s*(?:DA )?NFS-?E|NUMERO DA NFS-?E)\D{0,8}(\d{1,12})/),
        'Data de emissão':    grab(/(?:DATA (?:DE |DA )?EMISSAO|EMISSAO)[:\s]*([\d/]{8,10})/),
        'CNPJ emitente':      grab(/\bCNPJ[:\s]*(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/),
        // O BRUTO — é este que a planilha lança, e o que deve casar com ela.
        // `VALOR DO SERVICO R$ 3.004,62` é a forma do layout nacional.
        'Valor do serviço':   grab(new RegExp(`(?:VALOR (?:TOTAL )?(?:DOS? )?SERVICOS?|VALOR SERVICO)[:\\s]*R?\\$?\\s*${N}`)),
        // O LÍQUIDO — é este que o boleto cobra, e o que o extrator vinha lendo.
        // O layout nacional escreve "DA NOTA" onde o municipal escreve "DA NFS-E".
        'Valor líquido':      grab(new RegExp(`VALOR LIQUIDO(?: DA (?:NFS-?E|NOTA))?[:\\s]*R?\\$?\\s*${N}`)),
        'ISS retido':         retencoes['ISSRF'],
        'IRRF retido':        retencoes['IRRF'],
        'INSS retido':        retencoes['INSS'],
        'CSLL retido':        retencoes['CSLL'],
        'COFINS retido':      retencoes['COFINS'],
        'PIS retido':         retencoes['PIS'],
        'Total trib. federais': totalFederais,
        // Agrupados do layout nacional — ver os comentários acima.
        'PIS/COFINS/CSLL retidos': pisCofinsCsll,
        'Contrib. sociais retidas': contribSociais,
    };
}

// ── parser: IMPOSTO (DARF, GPS/INSS, DCTFWeb, FGTS Digital) ──────────────────
function parseImposto(text) {
    const t = norm(text);
    const grab = re => { const m = t.match(re); return m ? m[1].trim() : '—'; };
    const base = {
        'Tipo de guia':         grab(/\b(DARF-?SIMPLES|DARF|GPS|DCTFWEB|GFD|FGTS DIGITAL|GNRE)\b/),
        'CNPJ / CPF':           grab(/\b(?:CNPJ|CPF)[:\s]*(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}|\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2})/),
        'Data de vencimento':   grab(/(?:DATA DE )?VENCIMENTO[:\s]*([\d/]{8,10})/),
        'Valor total':          grab(/VALOR TOTAL[:\s]*R?\$?\s*([\d.,]{3,})/),
    };
    if (/FGTS DIGITAL|GUIA DO FGTS|\bGFD\b/.test(t)) {
        return {
            ...base,
            'Competência':           grab(/COMPETENCIA[:\s]*([\d/.-]{4,7})/),
            'FGTS mensal':           grab(/(?:FGTS MENSAL|DEPOSITO MENSAL)[:\s]*R?\$?\s*([\d.,]{3,})/),
            'FGTS rescisório':       grab(/(?:FGTS RESCISORIO|DEPOSITO RESCISORIO)[:\s]*R?\$?\s*([\d.,]{3,})/),
        };
    }
    return {
        ...base,
        'Código da receita':    grab(/CODIGO (?:DA|DE) RECEITA[:\s]*([\d-]{4,})/),
        'Período de apuração':  grab(/PERIODO DE APURACAO[:\s]*([\d./-]{5,})/),
        'Número do documento':  grab(/NUMERO DO DOCUMENTO[:\s]*([\d.]{6,})/),
        'Valor principal':      grab(/VALOR PRINCIPAL[:\s]*R?\$?\s*([\d.,]{3,})/),
        'Multa':                grab(/\bMULTA[:\s]*R?\$?\s*([\d.,]{3,})/),
        'Juros / Encargos':     grab(/JUROS[:\s]*R?\$?\s*([\d.,]{3,})/),
    };
}

// ── Chave de acesso da NF-e (44 dígitos) ─────────────────────────────────────
// Vale para QUALQUER documento, não só os que `classify` marca como NF/CTE. Motivo
// medido em 14/08/2026 sobre os 190 PDFs de Março no disco: metade deles (95) traz a
// chave no texto, mas ela só era procurada por parseDanfe/parseCte — e um PDF de
// "boleto + DANFE anexa" é classificado como FATURA, então cai na IA, que extrai
// campos de boleto e nunca olha a chave. Resultado: a chave chegava preenchida em 9%
// dos documentos quando está fisicamente presente em 50%.
//
// A chave vem impressa em grupos de 4 separados por espaço — e a extração de texto
// pode quebrá-la em várias linhas —, então o separador tolerado inclui quebra de linha.
// Nos 76 casos em que deu para conferir contra o número real da nota, houve
// 0 divergência: onde existe, a chave é fonte determinística e confiável.
const RE_CHAVE_ACESSO = /(?<!\d)((?:\d[\s]*){44})(?!\d)/g;

// O código de barras de um boleto TAMBÉM tem 44 dígitos — sem validar estrutura, a
// linha digitável de uma conta de água virava "NF 100100108 do CNPJ 01001000801001".
// A chave da NF-e é validável: começa pelo código da UF e traz o modelo do documento
// nas posições 21-22 (55 = NF-e, 57 = CT-e, 65 = NFC-e).
const UFS = new Set([11,12,13,14,15,16,17,21,22,23,24,25,26,27,28,29,
                     31,32,33,35,41,42,43,50,51,52,53]);
const MODELOS = new Set(['55', '57', '65']);

// O último dígito da chave é um verificador mod-11 sobre os 43 anteriores. Conferi-lo
// é o que separa uma chave lida certa de uma lida com dígito trocado ou faltando —
// UF e modelo sozinhos deixam passar leitura corrompida que por acaso comece com
// "41…55". Medido em 09/09/2026 (`_medir/_chave-dv.js`) sobre 1.554 linhas com chave:
// 49 tinham 44 dígitos e DV errado, e a leitura por IA só produzia chave válida em
// 34% dos casos contra 98% do extrator determinístico. Sem esta conferência, o campo
// mais confiável do sistema (traz CNPJ e número da nota embutidos) virava palpite.
function dvChaveOk(d) {
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(d[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto) === Number(d[43]);
}

function chaveValida(d) {
    return d.length === 44 && UFS.has(Number(d.slice(0, 2))) && MODELOS.has(d.slice(20, 22)) && dvChaveOk(d);
}

function chaveAcessoDoTexto(text) {
    const s = String(text || '');
    RE_CHAVE_ACESSO.lastIndex = 0;
    let m;
    // Varre todas as sequências de 44 dígitos e devolve a primeira que é chave de
    // verdade — num PDF de "boleto + DANFE" o código de barras aparece ANTES dela.
    while ((m = RE_CHAVE_ACESSO.exec(s)) !== null) {
        const d = m[1].replace(/\D/g, '');
        if (chaveValida(d)) return d;
    }
    return '';
}

// Layout da chave: cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) cDV(1).
// O número da nota são os 9 dígitos a partir da posição 25 (0-based).
function nfDaChaveAcesso(chave) {
    const d = String(chave || '').replace(/\D/g, '');
    if (!chaveValida(d)) return '';
    return d.slice(25, 34).replace(/^0+/, '');
}

// CNPJ do emitente embutido na chave (posições 7-20). Identidade determinística —
// não depende de a IA ter lido o nome certo. Evidência forte para casar, e a única
// que distingue duas empresas diferentes com o mesmo nº de nota (medido: NF 706 e 708
// do CNPJ 32418130000135 caem sobre FRISIA COOPERATIVA e EXPRICE na planilha).
function cnpjDaChaveAcesso(chave) {
    const d = String(chave || '').replace(/\D/g, '');
    return chaveValida(d) ? d.slice(6, 20) : '';
}

// Completa `dados` com a chave e o nº dela, SEM sobrescrever o que já veio: o número
// lido diretamente continua sendo o primário; o da chave entra como campo próprio e
// vira chave adicional de busca no comparador. Quando o documento não traz número
// nenhum (boleto puro com DANFE anexa), este é o único caminho para achá-lo.
function enriquecerComChaveAcesso(dados, text) {
    const chave = chaveAcessoDoTexto(text);
    if (!chave) return dados;
    const d = dados || {};
    const atual = String(d['Chave de acesso'] || '').replace(/\D/g, '');
    if (!chaveValida(atual)) d['Chave de acesso'] = chave;
    const nf = nfDaChaveAcesso(d['Chave de acesso']);
    if (nf) d['Nº da NF-e (chave)'] = nf;
    // CNPJ só quando não veio nada: o lido diretamente do documento tem precedência.
    const cnpj = cnpjDaChaveAcesso(d['Chave de acesso']);
    const cnpjAtual = String(d['CNPJ emitente'] || '').replace(/\D/g, '');
    if (cnpj && cnpjAtual.length !== 14) d['CNPJ emitente'] = cnpj;
    return d;
}

// ── Linha digitável do boleto ────────────────────────────────────────────────
// O boleto de cobrança carrega VALOR e VENCIMENTO codificados, então não dependem
// de leitura: são aritmética. Medido sobre os 190 PDFs de Março, 110 (57,9%) têm
// linha digitável e o valor decodificado bateu em 110/110 — enquanto o valor lido
// pela IA erra com frequência. O vencimento vinha em branco na maioria dos casos.
//
// Impressa como "00190.00009 02778.804092 00060.190170 3 13730000274000" (47 dígitos):
//   pos 1-3   banco          pos 34-37  fator de vencimento
//   pos 4     moeda          pos 38-47  valor em centavos
// Os DVs das posições 10, 21, 32 e 33 fazem a linha digitável NÃO ser o código de
// barras — por isso a leitura é posicional na forma impressa, que é a que aparece
// no texto extraído do PDF.
const RE_LINHA_DIGITAVEL =
    /(?<![\d.])(\d{5}[.\s]?\d{5}\s+\d{5}[.\s]?\d{6}\s+\d{5}[.\s]?\d{6}\s+\d\s+\d{14})(?![\d])/;

// Fator de vencimento: dias desde 07/10/1997. O contador estourou 9999 e foi
// reiniciado em 1000 = 22/02/2025, então o mesmo fator tem duas leituras possíveis;
// escolhemos a que cai numa janela plausível de operação.
const FATOR_BASE_ANTIGA = Date.UTC(1997, 9, 7);
const FATOR_BASE_NOVA   = Date.UTC(2025, 1, 22);
const DIA_MS = 86400000;

function vencimentoDoFator(fator) {
    if (!(fator > 0)) return null;
    const cand = [];
    if (fator >= 1000) cand.push(new Date(FATOR_BASE_NOVA + (fator - 1000) * DIA_MS));
    cand.push(new Date(FATOR_BASE_ANTIGA + fator * DIA_MS));
    const min = Date.UTC(2020, 0, 1), max = Date.UTC(2032, 11, 31);
    for (const d of cand) if (d.getTime() >= min && d.getTime() <= max) return d;
    return cand[cand.length - 1];
}

function linhaDigitavelDoTexto(text) {
    const m = String(text || '').match(RE_LINHA_DIGITAVEL);
    if (!m) return '';
    const d = m[1].replace(/\D/g, '');
    return d.length === 47 ? d : '';
}

// { banco, valor, vencimento 'DD/MM/AAAA' } — ou null. Valor 0 é boleto sem valor
// impresso (o pagador preenche), caso em que não há o que aproveitar.
function dadosDoBoleto(linha) {
    const d = String(linha || '').replace(/\D/g, '');
    if (d.length !== 47) return null;
    const valor = parseInt(d.slice(37, 47), 10) / 100;
    const venc = vencimentoDoFator(parseInt(d.slice(33, 37), 10));
    return {
        banco: d.slice(0, 3),
        valor: valor > 0 ? valor : 0,
        vencimento: venc ? `${String(venc.getUTCDate()).padStart(2, '0')}/` +
                           `${String(venc.getUTCMonth() + 1).padStart(2, '0')}/` +
                           `${venc.getUTCFullYear()}` : '',
    };
}

// Acrescenta os campos do boleto SEM sobrescrever leitura direta existente, exceto
// pelo vencimento: ali o fator é mais confiável que a data lida, e o campo costuma
// vir vazio. O valor entra em campo próprio ('Valor do boleto') para o comparador
// poder preferi-lo sem perder o que a IA leu.
function enriquecerComBoleto(dados, text) {
    const linha = linhaDigitavelDoTexto(text);
    if (!linha) return dados;
    const b = dadosDoBoleto(linha);
    if (!b) return dados;
    const d = dados || {};
    d['Linha digitável'] = linha;
    if (b.banco) d['Banco do boleto'] = b.banco;
    if (b.valor > 0) d['Valor do boleto'] = String(b.valor.toFixed(2)).replace('.', ',');
    if (b.vencimento) d['Data de vencimento'] = b.vencimento;
    return d;
}

module.exports = {
    norm, classify, mk, parseDanfe, parseCte, parseImposto, parseNfse,
    extrairCnpj, extrairEmitente, emitenteEhGoverno,
    CTE_STRONG_RE, TRANSPORT_HINT_RE,
    chaveValida, chaveAcessoDoTexto, nfDaChaveAcesso, cnpjDaChaveAcesso, enriquecerComChaveAcesso,
    linhaDigitavelDoTexto, dadosDoBoleto, enriquecerComBoleto,
};
