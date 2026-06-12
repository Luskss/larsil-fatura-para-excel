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

const PARSERS = { CTE: parseCte, NF: parseDanfe, IMPOSTO: parseImposto };

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
    const chave = (t.match(/\b(\d[\d ]{42,52}\d)\b/) || [])[1];
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
    const chave = (t.match(/\b(\d[\d ]{42,52}\d)\b/) || [])[1];
    return {
        'Chave de acesso':      chave ? chave.replace(/\s+/g, '') : '—',
        'Nº do CT-e':           grab(/(?:NR\.?DOCUMENTO|N[º°]?\.?\s*(?:DO )?CT-?E)\D{0,8}(\d{3,9})/),
        'Data de emissão':      grab(/(?:DATA (?:DE |DA )?EMISSAO|EMISSAO)[:\s]*([\d/]{8,10})/),
        'CNPJ emitente':        grab(/\bCNPJ[:\s]*(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/),
        'Valor da prestação':   grab(/VALOR TOTAL DA PRESTACAO[:\s]*R?\$?\s*([\d.,]{3,})/),
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

module.exports = {
    norm, classify, mk, parseDanfe, parseCte, parseImposto,
    extrairCnpj, extrairEmitente, emitenteEhGoverno,
    CTE_STRONG_RE, TRANSPORT_HINT_RE,
};
