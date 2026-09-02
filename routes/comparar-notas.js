/**
 * routes/comparar-notas.js
 * POST /api/comparar-notas  body: { mes, ano }
 *
 * REESCRITO DO ZERO em 14/08/2026. A versão anterior (~1.800 linhas) tentava casar
 * documento×lançamento com dezenas de regras acumuladas; ela está preservada em
 * `_backup-larsil-20260814-1333/` e o histórico do que foi medido está em
 * ANALISE-COMPARADOR.md e PROGRESSO-COMPARADOR.md.
 *
 * O NÚCLEO desta versão só CONTA, em três fontes independentes:
 *
 *   pasta    — PDFs no disco, sob MONITOR_PATH
 *   banco    — documentos gravados pelo OCR (nfs.RELATORIOS_CONFERENCIA, TIPO='M')
 *   planilha — lançamentos da planilha Delsoft
 *
 * Nenhum dos três depende dos outros. É a base para reconstruir a comparação com
 * chão firme: se estes números não fecharem entre si, o problema é de captura, e
 * não adianta discutir regra de casamento.
 *
 * Em 02/09/2026 o pareamento voltou, como camada ADITIVA em `_pareamento.js`: ele
 * responde "quantos lançamentos têm documento arquivado" sem alterar nenhuma das
 * três contagens acima. A regra usada foi escolhida por medição, não por intuição —
 * ver TIPOS-IGNORADOS-COMPARADOR.md §10 e o cabeçalho de `_pareamento.js`.
 *
 * A separação é deliberada: contagem e casamento falham por motivos diferentes, e
 * foi justamente misturá-los que tornou a versão de ~1.800 linhas indepurável. Se o
 * pareamento estiver errado, os cards das três fontes continuam corretos.
 */
'use strict';
const { getConnection } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const pareamento = require('./_pareamento');
const XLSX = require('xlsx');
const xlsxRapido = require('./_xlsx-rapido');
const fs   = require('fs');
const path = require('path');

// ── Escopo dos arquivos ──────────────────────────────────────────────────────
// Só contam os "NNN.DOC- ...": é o documento em si. A pasta guarda junto o
// comprovante de pagamento (NNN.CPV.pdf), o extrato do dia (000.pdf) e outros
// anexos, que não são nota e por isso nunca deveriam entrar em contagem nenhuma.
const RE_DOC = /^\s*\d+\s*\.\s*DOC\b/i;
const ehDoc = nome => RE_DOC.test(String(nome || ''));

// Boleto de carnê é gravado como uma linha por parcela, com sufixo #p1, #p2…
// O PDF é UM só — para contar arquivo, o sufixo sai.
const arquivoBase = s => String(s || '').replace(/#p\d+$/i, '');

// ── Arquivos "NNN.DOC" que NÃO são nota fiscal de fornecedor ─────────────────
// Investigado em 25/08/2026 (ver TIPOS-IGNORADOS-COMPARADOR.md): dos 896 PDFs
// "NNN.DOC" de 03/2026, 259 eram consórcio, financiamento, PIX, folha e guia de
// governo — pagamentos que nunca têm NF de fornecedor. Tirando esses, sobram 637,
// contra 639 na planilha (depois de excluir o equivalente do lado dela — ver
// CONTAS_SEM_DOCUMENTO) — diferença de 2, dentro do ruído de uma heurística por
// nome de arquivo. Sem este corte, a pasta parecia ter ~40% mais documento do
// que a planilha esperava, quando na prática as duas já batiam.
//
// Padrões abaixo da linha (ampliados em 25/08/2026, mesmo dia): analisando
// jan–jun/2026 inteiros, achamos mais 7 categorias que se repetem igual em TODO
// mês (cheque, folha/RH, guia de tributo, variantes de crédito, cartão de
// benefício, sindicato, TED/DOC) — tiram 22 a 43 arquivos por mês, de forma
// uniforme (inclusive nos meses que já batiam bem com a planilha, confirmando
// que não é ajuste forçado para um mês específico).
//
// Ordem dos padrões não importa: cada nome cai em no máximo uma categoria (usado
// só para a composição no tooltip); a decisão de excluir é "bateu em algum".
const PADROES_NAO_FISCAL = [
    [/\bGRUPO\s*\d+.*\bCOTA\b/i, 'Consórcio (Grupo/Cota)'],
    [/\bPAGTO\s+FINANC\s+VEIC\b|\bCDC\s+(VEICULOS|MAQUINAS)/i, 'Financiamento de veículo/máquina'],
    [/\bFINANCIAMENTO\b/i, 'Financiamento'],
    [/\bEMPRESTIMO\b|\bDAYCOVAL\b/i, 'Empréstimo'],
    [/\bGIRO\s+(CAIXA|PEAC)\b|\bCRED\s+ESP\b|\bPARC\s+FLUTUANTE\b|\bCAPITAL\s+DE\s+GIRO\b|\bPARCELA\s+GIRO\b/i, 'Crédito/giro empresarial'],
    [/\bPIX\s+(ENVIADO|RECEBIDO)\b/i, 'PIX enviado/recebido'],
    [/\bSISPAG\b/i, 'SISPAG (pagamento em lote)'],
    [/\bpgto\s+VA\b/i, 'Vale alimentação (pagamento em lote)'],
    [/\bISS\s+RETIDO\b/i, 'ISS retido'],
    [/\bFGTS\b/i, 'FGTS'],
    [/\bRCB\.?\s*(9039|9049)\d{2}\b/i, 'Guia de governo (RCB 9039xx/9049xx)'],
    [/\bDETRAN\b|\bMINISTERIO\s+DA\s+JUSTICA\b/i, 'Taxa de governo (DETRAN/Ministério)'],
    [/\bSALARIO\b|\bFERIAS\b/i, 'Folha/salário'],
    // ── ampliação de 25/08/2026 ──
    [/\bCHEQUE\b/i, 'Compensação de cheque'],
    [/\bpgto\s+(TRCT|FOLHA|ADTO\s+SALARIAL|PENSAO\s+ALIMENTICIA|MEI|PREMIO|DIARIAS?|REEMBOLSO|BOLETO\s+CIEE|DIF\b)/i, 'Folha/RH (pgto ...)'],
    [/\bGUIA\s+(ISS|INSS|PIS|COFINS|CSLL|IRPJ|IPTU|IPVA)\b/i, 'Guia de tributo'],
    [/\bCONTA\s+GARANTIDA\s+PJ\b|\bGIRO\s+PARCELADO\b|\bLIQUIDACAO\s+DE\s+PARCELA\b/i, 'Crédito/giro empresarial (variante)'],
    [/\bEVA\s+CARD\b/i, 'Cartão de benefício (EVA Card)'],
    [/\bpgto\s+SINDICATO\b/i, 'Contribuição sindical'],
    [/\b(ITAU|BANCO)\.?\s*DOC\.?\s*\d{6,}/i, 'Transferência bancária (TED/DOC)'],
    // Guia de tributo identificada pela ENTIDADE, não pelo número do RC. O padrão
    // `RCB 9039xx/9049xx` acima só pegava uma faixa estreita: os RCs de guia vão de
    // 9017xx a 9046xx, e ampliar a faixa é inviável — 392 documentos de fornecedor
    // legítimo (pessoas físicas: CELSO, JANICE, LEANDRO…) usam RC na mesma faixa
    // 90xxxx. Já o nome da entidade é inequívoco: as 260 ocorrências em jan–jun/2026
    // são todas guia de IPVA (por placa) ou taxa municipal, nenhuma nota de serviço.
    [/\bGOVERNO\b|\bPREFEITURA\b|\bIPVA\b/i, 'Guia de tributo (GOVERNO/PREFEITURA/IPVA)'],
];
// Peneira barata antes dos 23 padrões acima. A maioria esmagadora dos arquivos É nota
// fiscal, e para esses todos os 23 `test()` falham antes de devolver ''. Esta regex única
// reúne as palavras-âncora de TODOS os padrões: se ela não bate, nenhum deles bateria,
// e a peneira devolve '' com uma varredura só.
//
// INVARIANTE: toda alternativa de PADROES_NAO_FISCAL tem de ter aqui uma âncora que ela
// implique. Ao acrescentar um padrão novo lá, acrescente a âncora dele aqui também —
// senão a peneira o esconde. `verificarPeneira()` abaixo checa isso na carga do módulo.
const PENEIRA_NAO_FISCAL = /GRUPO|FINANC|EMPRESTIMO|DAYCOVAL|GIRO|CRED|FLUTUANTE|PIX|SISPAG|\bVA\b|ISS|FGTS|RCB|DETRAN|MINISTERIO|SALARIO|FERIAS|CHEQUE|TRCT|FOLHA|ADTO|PENSAO|MEI|PREMIO|DIARIA|REEMBOLSO|CIEE|DIF|GUIA|CONTA\s+GARANTIDA|LIQUIDACAO|EVA|SINDICATO|ITAU|BANCO|GOVERNO|PREFEITURA|IPVA|CDC|PAGTO/i;

// Devolve o rótulo da categoria não-fiscal, ou '' se o nome parece nota fiscal.
function categoriaNaoFiscal(nome) {
    const n = String(nome || '');
    if (!PENEIRA_NAO_FISCAL.test(n)) return '';   // caminho rápido: não é não-fiscal
    for (const [re, rotulo] of PADROES_NAO_FISCAL) if (re.test(n)) return rotulo;
    return '';
}

// A peneira é uma otimização que pode ESCONDER um padrão se alguém acrescentar um
// padrão novo sem a âncora correspondente — falha silenciosa que sub-contaria
// não-fiscais. Este teste roda na carga do módulo: para cada alternativa de cada
// padrão, gera um texto que casa com ela e confere que a peneira deixa passar.
// Custo: alguns milissegundos, uma vez por processo.
(function verificarPeneira() {
    // Um exemplo mínimo por padrão, escrito à mão (gerar texto a partir de regex é
    // frágil). Cada entrada TEM de casar com o padrão de mesmo índice.
    const exemplos = [
        'GRUPO 1234 COTA 56', 'PAGTO FINANC VEIC', 'FINANCIAMENTO', 'EMPRESTIMO',
        'GIRO CAIXA', 'PIX ENVIADO', 'SISPAG', 'pgto VA', 'ISS RETIDO', 'FGTS',
        'RCB 903901', 'DETRAN', 'SALARIO', 'CHEQUE', 'pgto FOLHA', 'GUIA ISS',
        'CONTA GARANTIDA PJ', 'EVA CARD', 'pgto SINDICATO', 'ITAU.DOC.123456',
        'GOVERNO',
    ];
    if (exemplos.length !== PADROES_NAO_FISCAL.length) {
        console.error(`[comparar-notas] verificarPeneira: ${exemplos.length} exemplos para ` +
            `${PADROES_NAO_FISCAL.length} padrões — acrescente o exemplo do padrão novo.`);
        return;
    }
    for (let i = 0; i < PADROES_NAO_FISCAL.length; i++) {
        const [re, rotulo] = PADROES_NAO_FISCAL[i];
        const ex = exemplos[i];
        if (!re.test(ex)) {
            console.error(`[comparar-notas] verificarPeneira: exemplo "${ex}" não casa com ` +
                `o padrão "${rotulo}" — exemplo desatualizado.`);
        } else if (!PENEIRA_NAO_FISCAL.test(ex)) {
            console.error(`[comparar-notas] verificarPeneira: PENEIRA_NAO_FISCAL esconde o ` +
                `padrão "${rotulo}" (ex.: "${ex}") — acrescente a âncora dele à peneira.`);
        }
    }
})();

function norm(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// ── Data ─────────────────────────────────────────────────────────────────────
// Mesmas regras de process-folder.js, para o mês de um PDF ser decidido aqui
// exatamente como foi decidido na hora de gravar: 1º a data no nome do arquivo,
// 2º a subpasta (YYYY.MM.DD ou DD.MM.YYYY).
function mesDoNome(nome) {
    const n = String(nome || '');
    const a = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (a) return `${a[2]}.${a[1]}`;
    const b = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (b) return `${b[2]}.${b[3]}`;
    return null;
}
function mesDaPasta(rel) {
    const r = String(rel || '');
    const a = r.match(/(?:^|[\/\\])(20\d{2})\.(\d{2})\.(\d{2})(?:[\/\\]|$)/);
    if (a) return `${a[2]}.${a[1]}`;
    const b = r.match(/(?:^|[\/\\])(\d{2})\.(\d{2})\.(20\d{2})(?:[\/\\]|$)/);
    if (b) return `${b[2]}.${b[3]}`;
    return null;
}

// Serial do Excel → { mes, ano }
function mesDoSerial(serial) {
    if (!serial || typeof serial !== 'number') return null;
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

// Serial do Excel → epoch ms (UTC), para medir distância em DIAS entre o documento
// e o lançamento. `mesDoSerial` só resolve o mês, e a janela do pareamento precisa
// da data cheia. Aceita também data já em texto, que aparece em export mais antigo.
function dataDoSerial(serial) {
    if (typeof serial === 'number' && serial > 0)
        return Math.round((serial - 25569) * 86400 * 1000);
    const s = String(serial || '').trim();
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
}

// ── 1) PASTA ─────────────────────────────────────────────────────────────────
// Varre MONITOR_PATH e devolve a contagem por mês. Só PDF, só "NNN.DOC", e só o
// que parece nota fiscal de fornecedor (ver PADROES_NAO_FISCAL acima).
function contarNaPasta(raiz) {
    const porMes = {};                 // "MM.AAAA" → contagem (só documento fiscal)
    const naoFiscalPorMes = {};        // "MM.AAAA" → { total, porCategoria }
    // "MM.AAAA" → [{ nome, rel }] dos mesmos PDFs que `porMes` conta. Guardar o nome
    // é o que permite o pareamento (_pareamento.js) sem uma segunda varredura do
    // arquivo permanente, que é a operação mais cara desta rota.
    const arquivosPorMes = {};
    let docs = 0, ignorados = 0, pdfsSemData = 0;

    const andar = (dir, rel) => {
        let entradas;
        try { entradas = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }
        for (const e of entradas) {
            const filho = path.join(dir, e.name);
            const relFilho = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { andar(filho, relFilho); continue; }
            if (!/\.pdf$/i.test(e.name)) continue;
            if (!ehDoc(e.name)) { ignorados++; continue; }
            docs++;
            const mes = mesDoNome(e.name) || mesDaPasta(rel);
            if (!mes) { pdfsSemData++; continue; }

            const categoria = categoriaNaoFiscal(e.name);
            if (categoria) {
                if (!naoFiscalPorMes[mes]) naoFiscalPorMes[mes] = { total: 0, porCategoria: {} };
                naoFiscalPorMes[mes].total++;
                naoFiscalPorMes[mes].porCategoria[categoria] = (naoFiscalPorMes[mes].porCategoria[categoria] || 0) + 1;
                continue;
            }
            porMes[mes] = (porMes[mes] || 0) + 1;
            (arquivosPorMes[mes] || (arquivosPorMes[mes] = [])).push({ nome: e.name, rel: relFilho });
        }
    };
    andar(raiz, '');
    return { porMes, naoFiscalPorMes, arquivosPorMes, docs, ignorados, pdfsSemData };
}

// A varredura acima percorre o ARQUIVO PERMANENTE inteiro — todos os meses, dezenas de
// milhares de PDFs — com readdirSync recursivo, que é síncrono e bloqueia o event loop.
// E ela devolve TODOS os meses de uma vez: o recorte por período acontece depois, na
// rota. Ou seja, trocar de mês na tela refazia a mesma varredura para reler exatamente
// o mesmo resultado — que é justamente o padrão de uso do painel.
//
// Banco e planilha já eram cacheados; a pasta era a única fonte sem cache, e a mais cara.
//
// Por que TTL e não mtime: não existe mtime de árvore inteira (o mtime da raiz não muda
// quando um PDF é criado numa subpasta funda), então não há sinal barato de invalidação
// como o mtime do .xlsx ou o tamanho dos CSVs. O TTL aceita uma contagem defasada por até
// TTL_PASTA_MS; como o scheduler leva minutos por ciclo e a conferência é uma leitura de
// acompanhamento (não um fechamento contábil), essa defasagem é invisível na prática — e
// se corrige sozinha na janela seguinte, sem intervenção.
const TTL_PASTA_MS = 60 * 1000;
let cachePasta = { raiz: null, em: 0, resultado: null };
function contarNaPastaCacheado(raiz) {
    const agora = Date.now();
    if (cachePasta.raiz === raiz && cachePasta.resultado && (agora - cachePasta.em) < TTL_PASTA_MS)
        return cachePasta.resultado;
    const t0 = Date.now();
    const resultado = contarNaPasta(raiz);
    console.log(`[comparar-notas] pasta varrida em ${Date.now() - t0} ms ` +
        `(${resultado.docs} docs, ${Object.keys(resultado.porMes).length} meses)`);
    cachePasta = { raiz, em: agora, resultado };
    return resultado;
}

// ── 2) BANCO ─────────────────────────────────────────────────────────────────
// O OCR grava um CSV por PERIODO em nfs.RELATORIOS_CONFERENCIA (TIPO='M'), mas o
// PERIODO é decidido no momento em que o scheduler PROCESSOU o arquivo — não é a
// data do documento. Confiar nele filtra errado: medido em 03/2026, dos 828
// arquivos gravados sob PERIODO='03.2026', só 667 têm data de março no nome; os
// outros 161 são de fevereiro (74), janeiro (43), abril (36) e até 2025.
// Por isso o mês aqui é RECALCULADO por arquivo (mesma regra da pasta: nome do
// arquivo, com a subpasta do relatório como reserva), e não pelo PERIODO da
// consulta SQL — a mesma lógica que já valia para pasta e planilha.
// Contamos ARQUIVOS distintos, não linhas: carnê vira N linhas (#p1, #p2…) do
// mesmo PDF. Mesmo corte não-fiscal da pasta (ver PADROES_NAO_FISCAL): o banco
// grava tudo que chegou na pasta, então tem o mesmo consórcio/financiamento/PIX.
function contarNoCsv(csvs) {
    const porMes = {};              // "MM.AAAA" → Set de arquivos fiscais
    const naoFiscalPorMes = {};     // "MM.AAAA" → { total, porCategoria }
    // Índice arquivo → campos que o OCR extraiu do miolo do PDF, para o
    // pareamento (ver enriquecerComOcr em _pareamento.js). Sai desta mesma
    // varredura porque os CSVs já estão aqui: uma segunda leitura custaria a
    // mesma transferência de vários MB do SQL.
    const ocrPorArquivo = {};
    let linhas = 0, ignorados = 0, semData = 0;

    for (const csv of (csvs || []).filter(c => c && c.trim())) {
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].split(';');
        const iArq = cols.indexOf('arquivo');
        const iPasta = cols.indexOf('pasta');
        const iParser = cols.indexOf('dados_parser');
        if (iArq < 0) continue;
        // Última coluna que interessa: a varredura para nela (ver separarCsvAte).
        const iUltima = Math.max(iArq, iPasta, iParser);
        for (let i = 1; i < ls.length; i++) {
            // O CSV usa ; como separador e aspas duplas com escape "" nos campos
            // (dados_parser é um JSON inteiro). Só precisamos das colunas 'arquivo'
            // e 'pasta', mas é preciso respeitar as aspas para não quebrar errado.
            const campos = separarCsvAte(ls[i], iUltima);
            const arq = arquivoBase(campos[iArq] || '');
            if (!arq) continue;
            linhas++;
            if (!ehDoc(arq)) { ignorados++; continue; }

            // O índice do OCR é montado ANTES do corte por mês e por categoria:
            // o pareamento consulta pastas vizinhas, então precisa dos campos de
            // documento que esta contagem descarta.
            //
            // Os campos são FUNDIDOS entre as linhas do mesmo arquivo, não fixados
            // na primeira: carnê grava uma linha por parcela (#p1, #p2…) e cada uma
            // traz um pedaço — a parcela tem o valor dela, o cabeçalho tem o da
            // nota. Ficar só com a primeira perdia campo em 1.035 arquivos.
            if (iParser >= 0) {
                const campo = camposOcr(campos[iParser]);
                if (campo) {
                    const at = ocrPorArquivo[arq] || (ocrPorArquivo[arq] = {});
                    for (const k of ['numero', 'emitente', 'valor', 'dtEmissao'])
                        if (at[k] == null && campo[k] != null) at[k] = campo[k];
                }
            }

            const pastaRel = iPasta >= 0 ? (campos[iPasta] || '') : '';
            const mes = mesDoNome(arq) || mesDaPasta(pastaRel);
            if (!mes) { semData++; continue; }

            const chave = `${arq}|${pastaRel}`;
            const categoria = categoriaNaoFiscal(arq);
            if (categoria) {
                if (!naoFiscalPorMes[mes]) naoFiscalPorMes[mes] = { total: 0, porCategoria: {}, vistos: new Set() };
                const nf = naoFiscalPorMes[mes];
                if (!nf.vistos.has(chave)) {
                    nf.vistos.add(chave);
                    nf.total++;
                    nf.porCategoria[categoria] = (nf.porCategoria[categoria] || 0) + 1;
                }
                continue;
            }
            if (!porMes[mes]) porMes[mes] = new Set();
            porMes[mes].add(chave);
        }
    }

    const contagemPorMes = {};
    for (const [mes, set] of Object.entries(porMes)) contagemPorMes[mes] = set.size;
    for (const nf of Object.values(naoFiscalPorMes)) delete nf.vistos;

    return { porMes: contagemPorMes, naoFiscalPorMes, ocrPorArquivo, linhas, ignorados, semData };
}

// ── Campos do OCR ────────────────────────────────────────────────────────────
// `dados_parser` é o JSON que o parser gravou por documento. As chaves variam com
// o tipo de documento (NF-e, NFS-e, boleto, guia), por isso cada campo aceita um
// conjunto de nomes. Medido em 7.155 linhas: Emitente em 99,4%, Nº da NF-e em
// 76%, Valor total em 80%.
const CHAVES_NUMERO   = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF'];
const CHAVES_EMITENTE = ['Emitente', 'Razão social', 'Nome do emitente'];
const CHAVES_VALOR    = ['Valor total da nota', 'Valor total', 'Valor do boleto'];
const CHAVES_EMISSAO  = ['Data de emissão', 'Data emissao'];

function primeiroDe(obj, chaves) {
    for (const k of chaves) {
        const v = obj[k];
        if (v != null && String(v).trim() !== '') return v;
    }
    return null;
}

// "32.233,60" / "R$ 1.234,56" / "1234.56" → número. O parser grava em formatos
// diferentes conforme o documento, então a conversão tem de aceitar os dois.
function valorDoParser(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? v : null;
    let s = String(v).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
    if (!s) return null;
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/,/.test(s) && !/\.\d/.test(s)) s = s.replace(/,/g, '');
    const n = Number(s);
    return isFinite(n) && n > 0 ? n : null;
}

function dataDoParser(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return null;
}

// Extrai de `dados_parser` só o que o pareamento usa. Devolve null quando não há
// nada aproveitável, para não encher o índice de objeto vazio.
// O CNPJ NÃO entra: medido em 02/09/2026, ele não identifica o fornecedor de
// forma confiável (ver cabeçalho de _pareamento.js).
function camposOcr(bruto) {
    const s = String(bruto || '').trim();
    if (!s.startsWith('{')) return null;
    let d;
    try { d = JSON.parse(s); } catch (e) { return null; }

    // O parser grava "—" (travessão) quando não achou o campo. Sem tirar isso, o
    // travessão vira "número" e entra no índice como lixo — inofensivo (quem
    // consome roda soDigitos), mas mascara a cobertura real do campo.
    const digitos = v => String(v == null ? '' : v).replace(/\D/g, '');
    const numeroBruto = primeiroDe(d, CHAVES_NUMERO);
    const numero = digitos(numeroBruto) ? String(numeroBruto) : null;
    const emitente = primeiroDe(d, CHAVES_EMITENTE);
    const valor = valorDoParser(primeiroDe(d, CHAVES_VALOR));
    const dtEmissao = dataDoParser(primeiroDe(d, CHAVES_EMISSAO));
    if (numero == null && emitente == null && valor == null && dtEmissao == null) return null;

    const out = {};
    if (numero != null) out.numero = String(numero);
    if (emitente != null) out.emitente = String(emitente);
    if (valor != null) out.valor = valor;
    if (dtEmissao != null) out.dtEmissao = dtEmissao;
    return out;
}

// Parsear ~30 CSVs (o maior tem ~1 MB) a cada request é desperdício quando o relatório
// não mudou. Cache simples por "tamanho total dos CONTEUDO": barato de calcular e muda
// sempre que qualquer período é regravado (o cenário real — o scheduler reescreve o
// CSV inteiro do período, não faz append).
let cacheBanco = { tamanho: -1, resultado: null };
function contarNoCsvCacheado(csvs) {
    const tamanho = (csvs || []).reduce((soma, c) => soma + (c ? c.length : 0), 0);
    if (cacheBanco.tamanho === tamanho && cacheBanco.resultado) return cacheBanco.resultado;
    const resultado = contarNoCsv(csvs);
    cacheBanco = { tamanho, resultado };
    return resultado;
}

// O cache acima evita o RE-PARSE, mas não a TRANSFERÊNCIA: para calcular o tamanho é
// preciso já ter os CONTEUDO na mão, e são vários MB puxados do SQL a cada troca de mês.
//
// Esta sonda pergunta antes, com uma query que não traz CONTEUDO nenhum: se a assinatura
// do conjunto não mudou, o resultado cacheado vale e o SELECT pesado é pulado por inteiro.
//
// A assinatura combina três sinais porque nenhum sozinho basta:
//   • SUM(DATALENGTH(CONTEUDO)) — pega qualquer reescrita que mude o tamanho;
//   • COUNT(*)                  — pega período novo/removido, inclusive quando o
//                                 INSERT do MERGE não preenche ATUALIZADO_EM (ele não
//                                 preenche: só o ramo UPDATE seta a coluna);
//   • MAX(ATUALIZADO_EM)        — pega reescrita do MESMO tamanho (reprocessar um mês
//                                 costuma dar CSV de tamanho idêntico).
// NULL vira '' — a coluna pode ser nula nas linhas nunca atualizadas.
async function assinaturaBanco(pool) {
    const rs = await pool.request()
        .input('tipo', 'M')
        .query(`SELECT COUNT(*) AS n,
                       SUM(DATALENGTH(CONTEUDO)) AS bytes,
                       MAX(ATUALIZADO_EM) AS max_at
                  FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo`);
    const r = (rs.recordset && rs.recordset[0]) || {};
    return `${r.n || 0}|${r.bytes || 0}|${r.max_at ? new Date(r.max_at).getTime() : ''}`;
}

// Resultado do banco cacheado pela assinatura acima. Guardamos o resultado JÁ CONTADO
// (não os CSVs), para não segurar vários MB de string viva no processo entre requests.
let cacheBancoPorAssinatura = { assinatura: null, resultado: null };
async function contarNoBanco(pool) {
    let assinatura = null;
    try {
        assinatura = await assinaturaBanco(pool);
        if (assinatura && cacheBancoPorAssinatura.assinatura === assinatura && cacheBancoPorAssinatura.resultado)
            return cacheBancoPorAssinatura.resultado;
    } catch (e) {
        // Sonda é otimização, não requisito: se ela falhar (permissão, coluna ausente
        // num ambiente antigo), seguimos pelo caminho completo em vez de quebrar a rota.
        console.warn(`[comparar-notas] sonda de assinatura falhou (${e.message}); lendo tudo`);
    }

    const rs = await pool.request()
        .input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const resultado = contarNoCsvCacheado(rs.recordset.map(r => r.CONTEUDO));
    if (assinatura) cacheBancoPorAssinatura = { assinatura, resultado };
    return resultado;
}

// Igual a `separarCsv`, mas PARA depois de fechar o campo de índice `ate`. Aqui só
// interessam 'arquivo' e 'pasta', que são as duas primeiras colunas (ver COLS em
// process-folder.js) — enquanto a coluna cara, `dados_parser`, é um JSON inteiro entre
// aspas, bem mais longa que todas as outras juntas. Sem a parada, cada linha percorria
// esse JSON caractere a caractere e concatenava string só para descartar no fim.
//
// A varredura é a MESMA de separarCsv (mesmo tratamento de aspas e de "" escapado); a
// única diferença é parar cedo. Os campos até `ate` saem idênticos.
function separarCsvAte(linha, ate) {
    const out = [];
    let atual = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (aspas) {
            if (c === '"') {
                if (linha[i + 1] === '"') { atual += '"'; i++; }
                else aspas = false;
            } else atual += c;
        } else if (c === '"') aspas = true;
        else if (c === ';') {
            out.push(atual); atual = '';
            if (out.length > ate) return out;   // já temos todos os campos pedidos
        }
        else atual += c;
    }
    out.push(atual);
    return out;
}

function separarCsv(linha) {
    const out = [];
    let atual = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (aspas) {
            if (c === '"') {
                if (linha[i + 1] === '"') { atual += '"'; i++; }
                else aspas = false;
            } else atual += c;
        } else if (c === '"') aspas = true;
        else if (c === ';') { out.push(atual); atual = ''; }
        else atual += c;
    }
    out.push(atual);
    return out;
}

// ── 3) PLANILHA ──────────────────────────────────────────────────────────────
// Acha o cabeçalho varrendo as abas (a planilha do Delsoft tem linhas de título
// antes dele, e a posição muda a cada export). Cacheado por mtime.
const COLUNAS = ['ORIG', 'NF', 'ENTIDADE'];
const MAX_LINHAS_CABECALHO = 200;
let cachePlanilha = { path: null, mtime: 0, porMes: null };

function acharCabecalho(abas) {
    for (const { nome, linhas } of abas) {
        for (let i = 0; i < Math.min(linhas.length, MAX_LINHAS_CABECALHO); i++) {
            const header = (linhas[i] || []).map(c => norm(c));
            if (COLUNAS.every(c => header.includes(c)))
                return { sheetName: nome, rows: linhas, header, headerRow: i };
        }
    }
    throw new Error(`Planilha sem cabeçalho reconhecível (colunas ${COLUNAS.join(', ')}).`);
}

// Abre a planilha pelo leitor rápido (ver _xlsx-rapido.js: 2,5 s contra 23–55 s do
// xlsx nesta planilha de 118 mil linhas). Se ele falhar — .xls antigo, .xlsb, ZIP com
// compressão incomum, qualquer formato que ele não cubra — cai no `xlsx`, que abre
// tudo. Assim o ganho é o caminho normal e o suporte amplo continua garantido.
function lerAbasDaPlanilha(planilhaPath) {
    try {
        const abas = xlsxRapido.lerAbas(planilhaPath);
        if (abas.length) return abas;
        console.warn('[comparar-notas] leitor rápido não achou abas; usando xlsx');
    } catch (e) {
        console.warn(`[comparar-notas] leitor rápido falhou (${e.message}); usando xlsx`);
    }
    const wb = XLSX.readFile(planilhaPath, { cellDates: false });
    return wb.SheetNames.map(nome => ({
        nome,
        linhas: XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1 }),
    }));
}

// ── Escopo: ORIG ∈ {'NF_ENTRADA', 'LMCP', 'TAXA'} ────────────────────────────
// A planilha marca a origem de cada lançamento. 'CP' (Conta a Pagar) era o escopo
// anterior; 'NF_ENTRADA' é a ENTRADA FISCAL, e é o escopo certo para esta conferência:
//
//   • cobertura maior — 10,3% contra 9,2% do CP (6 meses de 2026);
//   • traz o TIPO fiscal explícito, dito pela própria contabilidade:
//       NFE AUTORIZADA RECEITA FEDERAL  2.033 lanç.  17,5% com documento
//       NFS EMITIDA PREFEITURAS         1.086        19,0%
//       NFSE SISTEMA NACIONAL             734        15,1%
//       FAT AGUA LUZ PEDAGIO ALUGUEL      494        33,4%
//       RECIBO                          6.450         4,2%   <- único sem nota
//
// Não é para SOMAR com CP: 10.250 dos 10.797 NF_ENTRADA já aparecem em CP com a mesma
// NF e entidade (10.248 no mesmo mês). É a mesma compra vista duas vezes — entrada
// fiscal e conta a pagar. LMCP e TAXA entraram no escopo por pedido do usuário
// (25/08/2026), junto com NF_ENTRADA. As demais origens continuam fora
// (TRANSF-REC/TRANSF-PAG somam R$ 326 mi cada com cobertura 0,0%).
const ORIG_ESCOPO = new Set(['NF_ENTRADA', 'LMCP', 'TAXA']);

// ── Escopo: FILIAL = 'LARSIL' ─────────────────────────────────────────────────
// Por pedido do usuário (25/08/2026): considerar só lançamentos da filial LARSIL.
const FILIAL_ESCOPO = 'LARSIL';

// ── Por que NÃO cortamos mais por TIPO='RECIBO' ──────────────────────────────
// O corte por TIPO rodava ANTES do corte por conta contábil e levava junto tudo que a
// contabilidade lançou como recibo, independente da conta. Medido em 03/2026: dos 964
// RECIBOs cortados, 745 eram VALE REFEICAO — que a lista CONTAS_SEM_DOCUMENTO abaixo já
// cortaria de qualquer jeito. Os ~219 restantes eram conta de água da SANESUL, aluguel,
// manutenção, telefone e luz: documentos que EXISTEM e deveriam estar arquivados.
// Nos 6 períodos de 2026 o corte por TIPO descartava 1.050 lançamentos legítimos (+49%).
// Quem decide é a CONTA_C (abaixo) — o TIPO é redundante no que acerta e nocivo no resto.

// ── Contas que não geram documento de fornecedor ─────────────────────────────
// CONTA_C é a conta contábil da própria planilha — quem classifica é a contabilidade,
// não uma heurística nossa, e por isso ela separa melhor que o TIPO. Medido nos 6
// períodos de 2026 (12.807 lançamentos ORIG=CP):
//
//   VALE REFEICAO        4.329 lanç.   0,7% com documento   <- 34% de TUDO
//   DESPESAS BANCARIAS     961         0,4%
//   SALARIOS               256         0,0%
//   FGTS                   216         0,5%
//   ...contra ALUGUEIS 38,7% · TELEFONE 41,0% · MATERIAL DE USO E CONSUMO 41,7%
//
// A lista abaixo foi escolhida pelo SIGNIFICADO (folha, encargo, benefício e tarifa
// bancária não têm nota de fornecedor para arquivar), com a cobertura servindo só de
// conferência. Deliberadamente NÃO cortamos contas de cobertura baixa cujo significado
// pede nota — MATERIAL DE CONSUMO (1,2%) e MELHORAMENTOS E REPAROS (0,9%) ficam dentro:
// se elas não têm documento, isso é achado, não ruído para esconder.
// Custo medido do corte: 36 lançamentos com documento em 6 meses.
const CONTAS_SEM_DOCUMENTO = new Set([
    'VALE REFEICAO', 'CESTA ALIMENTACAO', 'VALE TRANSPORTE', 'BENEFICIOS',
    'SALARIOS', 'FERIAS + 1/3', '13º SALARIO', 'BOLSA ESTAGIO',
    'FGTS', 'INSS', 'INSS A RECUPERAR', 'ISSQN',
    'INDENIZACOES TRABALHISTAS', 'RECLAMATORIA TRABALHISTA',
    'DESPESAS BANCARIAS', 'IOF', 'JUROS PAGOS', 'JUROS A PAGAR',
    'DISTRIBUICAO DE LUCROS', 'CAPITAL SOCIAL', 'DEPRECIACAO E AMORTIZACAO',
    // Rendimento de aplicação é receita financeira, não compra de fornecedor.
    // (13 lançamentos em 03/2026, sem documento nenhum para arquivar.)
    'RENIMENTO S/ APLIC FINANCEIRAS',
    // NÃO cortamos 'IMPOSTOS E TAXAS' aqui, embora PADROES_NAO_FISCAL tire as guias
    // de tributo da pasta/banco pelo nome. Medido em jan–jun/2026: a planilha tem só
    // 110 lançamentos nessa conta contra 260 documentos de guia na pasta — cortar
    // dos dois lados PIORA o alinhamento (desvio médio pasta/planilha vai de 8,9%
    // para 11,5%), porque a planilha registra bem menos guias do que a pasta arquiva.
]);

// ── Entidades que nunca emitem nota de fornecedor ────────────────────────────
// O corte por CONTA_C (acima) não alcança estes: recolhimento a Receita Federal e
// a fazenda estadual cai em "Impostos e Taxas", e proventos caem em contas de
// folha variadas — contas que, no geral, TÊM nota e por isso não podem ser
// cortadas inteiras (ver a ressalva sobre IMPOSTOS E TAXAS logo acima).
//
// A saída é a mesma que o lado da pasta já usa em PADROES_NAO_FISCAL: identificar
// pelo NOME. Aqui o nome é o da ENTIDADE, e é inequívoco — recolhimento de tributo
// federal ou estadual e provento de folha não geram nota de fornecedor para
// arquivar. Medido em jan–jun/2026, entre os que ficavam como "sem documento":
//
//   Receita Federal .......  7 lanç.  R$   922.419,38   0 com documento
//   Divisão de proventos ..  5 lanç.  R$   742.685,65   0 com documento
//   Fazenda estadual ...... 31 lanç.  R$   210.903,00   0 com documento
//   Prefeitura ............  3 lanç.  R$     1.550,60   0 com documento
//
// A coluna "com documento" é o teste de segurança: se o padrão pegasse coisa que
// costuma ter nota arquivada, ela seria alta. Sendo zero nos quatro, o corte não
// esconde ausência real.
//
// FICARAM DE FORA, deliberadamente:
//   • CARTAO CRED (18 sem documento, R$ 470 mil) — a fatura ÀS VEZES é arquivada:
//     achamos "052.DOC-...CARTAO DE CREDITO. RCB 901727" casando por 3 sinais.
//     Cortar esconderia as vezes em que ela realmente falta.
//   • FOLHA DE PAGAMENTO (3 sem, R$ 675 mil) — 3 dos 6 casaram, e volume baixo
//     demais para justificar regra. (Os 3 pares são fracos, só por valor, contra
//     "pgto PRESTADOR SERVIÇO" — provavelmente errados, mas isso é outro assunto.)
const ENTIDADES_SEM_NOTA = [
    [/SECRETARIA\s+DA\s+RECEITA\s+FEDERAL|RECEITA\s+FEDERAL\s+DO\s+BRASIL/i, 'Receita Federal'],
    [/^DIVISAO\s+DE\s+PROVENTOS/i, 'Divisão de proventos'],
    [/GOVERNO\s+DO\s+(ESTADO|PARANA|MATO\s+GROSSO)|SEC(RETARIA)?\s+DE\s+ESTADO\s+DA\s+FAZENDA/i,
     'Fazenda estadual'],
    [/^PREFEITURA(\s+MUNICIPAL)?\b/i, 'Prefeitura'],
];
function entidadeSemNota(ent) {
    const e = String(ent || '');
    for (const [re, rotulo] of ENTIDADES_SEM_NOTA) if (re.test(e)) return rotulo;
    return '';
}

// Lançamento informativo: a contabilidade marca com "*" na ENTIDADE
// (*P.R.B INFORMATIVO, *INF. JUROS INFORMATIVO, *DEPRECIACAO...). Não é pagamento a
// fornecedor — 64 lançamentos em 6 meses, mas R$ 81 milhões, então distorcem somas.
const ehInformativo = ent => String(ent || '').trim().startsWith('*');

// Conta LANÇAMENTOS, não linhas: uma nota com 5 itens ocupa 5 linhas com o mesmo
// cabeçalho. A chave de agrupamento é NF + entidade.
// Verificado em 03/2026 no escopo LARSIL: NF+entidade dá 1.527 chaves distintas, e
// acrescentar VL_TOTAL_CAB à chave dá exatamente as mesmas 1.527 — o agrupamento não
// colapsa lançamento distinto nem infla contagem.
// (Nota: CD_LANC NÃO identifica o lançamento — tem só 143 valores distintos em 118 mil
// linhas, é um código de categoria. Um comentário antigo aqui o tratava como id.)
//
// ORDEM DOS CORTES: as contas sem documento são cortadas ANTES da deduplicação, não
// depois. Elas não são candidatas a ter nota arquivada, então não deveriam entrar nem
// no "de N lançamentos" exibido na tela — em 03/2026 eram 888 de 1.527 (58%), quase
// todas VALE REFEICAO (reembolso individual de refeição, 757 lançamentos).
// Tudo o que sai continua contado em `excluidos`/`porConta`, para nenhum corte ser invisível.
function contarNaPlanilha(planilhaPath) {
    const mtime = fs.statSync(planilhaPath).mtimeMs;
    if (cachePlanilha.path === planilhaPath && cachePlanilha.mtime === mtime && cachePlanilha.porMes)
        return cachePlanilha.porMes;

    const t0 = Date.now();
    const { sheetName, rows, header, headerRow } = acharCabecalho(lerAbasDaPlanilha(planilhaPath));
    const msLeitura = Date.now() - t0;
    const iOrig = header.indexOf('ORIG');
    const iNF   = header.indexOf('NF');
    const iEnt  = header.indexOf('ENTIDADE');
    const iVal   = header.findIndex(c => c === 'VL_TOTAL(CAB)' || c === 'VL_TOTAL_CAB');
    const iLanc  = header.indexOf('DT_LANCAMENTO');
    const iEmis  = header.indexOf('DT_EMISSAO');
    const iConta = header.indexOf('CONTA_C');
    const iFilial = header.indexOf('FILIAL');

    const porMes = {};            // "MM.AAAA" → { lancamentos, linhas, ... }
    const vistos = new Set();     // "mes|nf|entidade|valor"
    // Colunas usadas só pelo pareamento (_pareamento.js). São opcionais: se a planilha
    // não trouxer FANTASIA ou CNPJ, o pareamento perde um sinal mas continua válido.
    const iFant = header.indexOf('FANTASIA');
    const iCnpj = header.indexOf('CNPJ');

    for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.length) continue;

        // Mês pelo LANÇAMENTO (data do pagamento), com a emissão como reserva.
        const mes = mesDoSerial(row[iLanc]) || mesDoSerial(row[iEmis]);
        if (!mes) continue;
        if (!porMes[mes]) porMes[mes] = {
            lancamentos: 0, linhas: 0, linhasEscopoBruto: 0, linhasTodasOrig: 0,
            excluidos: 0, informativos: 0, porConta: {}, itens: [],
        };
        const m = porMes[mes];
        m.linhasTodasOrig++;

        if (!ORIG_ESCOPO.has(norm(row[iOrig]))) continue;
        if (iFilial >= 0 && norm(row[iFilial]) !== FILIAL_ESCOPO) continue;
        m.linhasEscopoBruto++;

        const ent = norm(row[iEnt]);

        // CORTES ANTES DA DEDUPE: folha, benefício, encargo e tarifa bancária não têm
        // nota de fornecedor para arquivar, então não são candidatos a documento e não
        // entram na base comparável. Contados por motivo em `excluidos`/`porConta`.
        // Deduplicados pela mesma chave da base, para o "excluído" ser lançamento e não linha.
        const nf  = String(row[iNF] || '').trim();
        const chave = `${mes}|${nf}|${ent}`;

        const conta = iConta >= 0 ? norm(row[iConta]) : '';
        if (CONTAS_SEM_DOCUMENTO.has(conta)) {
            if (!vistos.has(chave)) {
                vistos.add(chave);
                m.excluidos++;
                m.porConta[conta] = (m.porConta[conta] || 0) + 1;
            }
            continue;
        }
        if (ehInformativo(ent)) {
            if (!vistos.has(chave)) { vistos.add(chave); m.excluidos++; m.informativos++; }
            continue;
        }
        // Recolhimento de tributo e provento de folha: a conta contábil não os
        // separa (caem em contas que no geral TÊM nota), mas o nome da entidade
        // sim. Contados em `porConta` junto com os demais cortes, com o rótulo do
        // padrão, para nenhum corte ficar invisível no tooltip.
        const semNota = entidadeSemNota(ent);
        if (semNota) {
            if (!vistos.has(chave)) {
                vistos.add(chave);
                m.excluidos++;
                m.porConta[semNota] = (m.porConta[semNota] || 0) + 1;
            }
            continue;
        }

        m.linhas++;   // linhas da base comparável (antes do agrupamento)

        // Chave de agrupamento: NF + entidade (sem o valor). Uma NF com vários itens
        // repete a mesma linha várias vezes com o mesmo header — conta como 1 lançamento,
        // como no exemplo do usuário (mesma NF+entidade repetida N vezes → 1 registro).
        if (vistos.has(chave)) continue;
        vistos.add(chave);

        m.lancamentos++;
        // Guarda o lançamento para o pareamento. É exatamente o mesmo conjunto que
        // `lancamentos` conta — a lista não pode divergir do card, senão "conferidos"
        // passaria a se referir a um universo diferente do exibido.
        m.itens.push({
            nf,
            entidade: ent,
            fantasia: iFant >= 0 ? String(row[iFant] || '').trim() : '',
            cnpj: iCnpj >= 0 ? String(row[iCnpj] || '').trim() : '',
            valor: Number(row[iVal]) || 0,
            dtLancamento: dataDoSerial(row[iLanc]),
            dtEmissao: dataDoSerial(row[iEmis]),
        });
    }

    console.log(`[comparar-notas] planilha lida em ${msLeitura} ms (aba "${sheetName}", ` +
        `cabeçalho linha ${headerRow + 1}, ${rows.length} linhas, ${Object.keys(porMes).length} meses)`);
    cachePlanilha = { path: planilhaPath, mtime, porMes };
    return porMes;
}

// ── Resumo por valor dos lançamentos sem documento ───────────────────────────
// A pergunta do painel é "todos os lançamentos da planilha estão na pasta?". A
// resposta útil não é só quantos faltam, é QUANTO falta: nota de R$ 21.616 sem
// papel é problema fiscal, pedágio de R$ 12,10 não é. As faixas separam os dois.
const FAIXAS = [
    { chave: 'alto',  rotulo: 'acima de R$ 1.000', teste: v => v >= 1000 },
    { chave: 'medio', rotulo: 'R$ 100 a R$ 1.000', teste: v => v >= 100 && v < 1000 },
    { chave: 'baixo', rotulo: 'abaixo de R$ 100',  teste: v => v < 100 },
];
// Quantos lançamentos da lista aparecem na tela; o resto fica no CSV. 200 é o que
// cabe numa rolagem sem pesar o JSON (a lista inteira de 03/2026 tem 259).
const MAX_LISTA = 200;

function resumoPorValor(todos, semDocumento) {
    const soma = a => a.reduce((s, l) => s + (Math.abs(l.valor) || 0), 0);
    const faixas = FAIXAS.map(f => {
        const g = semDocumento.filter(l => f.teste(Math.abs(l.valor) || 0));
        return { chave: f.chave, rotulo: f.rotulo, n: g.length, valor: soma(g) };
    });
    // Ordenada por valor: quem confere começa pelo que pesa.
    const lista = [...semDocumento]
        .sort((a, b) => (Math.abs(b.valor) || 0) - (Math.abs(a.valor) || 0))
        .slice(0, MAX_LISTA)
        .map(l => ({
            entidade: l.entidade,
            nf: l.nf,
            valor: Math.abs(l.valor) || 0,
            dtLancamento: l.dtLancamento,
        }));
    return {
        valorTotal: soma(todos),
        valorSemDocumento: soma(semDocumento),
        faixasSemDocumento: faixas,
        listaSemDocumento: lista,
        listaTruncadaEm: semDocumento.length > MAX_LISTA ? MAX_LISTA : null,
    };
}

// ── Rota ─────────────────────────────────────────────────────────────────────
module.exports = async function compararNotasRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const mes = parseInt(req.body && req.body.mes, 10);
        const ano = parseInt(req.body && req.body.ano, 10);
        if (!mes || !ano) {
            return res.status(400).json({ success: false, message: 'Parâmetros mes e ano obrigatórios.' });
        }
        const periodo = `${String(mes).padStart(2, '0')}.${ano}`;

        // 1) pasta
        // ARQUIVO_PATH é o ARQUIVO permanente (todos os meses). MONITOR_PATH é a pasta de
        // trabalho que o scheduler varre — ela é esvaziada a cada ciclo e só contém o lote
        // corrente, por isso contar ali dava 0 em todo mês que já foi arquivado.
        // Identificado em 14/08/2026 comparando os nomes de arquivo do relatório com cada
        // compartilhamento *.EXT.BANC: LA26 bate 80% em 03/2026 e em 05/2026; os demais, 0%.
        const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
        let pasta = { total: 0, disponivel: false, ignorados: 0, semData: 0, raiz: raiz || null };
        let pastaBruta = null;   // varredura crua, reusada pelo pareamento (passo 4)
        if (raiz && fs.existsSync(raiz)) {
            const r = contarNaPastaCacheado(raiz);
            pastaBruta = r;
            const naoFiscal = r.naoFiscalPorMes[periodo] || { total: 0, porCategoria: {} };
            pasta = {
                total: r.porMes[periodo] || 0,
                disponivel: true,
                ignorados: r.ignorados,     // PDFs que não são "NNN.DOC" (CPV, extrato, anexos)
                semData: r.pdfsSemData,
                naoFiscal: naoFiscal.total, // "NNN.DOC" que não são nota (consórcio, financiamento, PIX...)
                naoFiscalPorCategoria: naoFiscal.porCategoria,
                raiz,
                mesesNaPasta: Object.keys(r.porMes).sort(),
            };
        }

        // 2) banco
        // Traz TODOS os PERIODO (só ~30, poucos MB no total — ver comentário em
        // contarNoCsv): o mês de cada arquivo é recalculado pelo nome, não pelo
        // PERIODO gravado, então não dá para filtrar isso já no SQL.
        // `contarNoBanco` sonda a assinatura antes e só puxa CONTEUDO se algo mudou.
        const pool = await getConnection();
        const b = await contarNoBanco(pool);
        const naoFiscalBanco = b.naoFiscalPorMes[periodo] || { total: 0, porCategoria: {} };
        const banco = {
            total: b.porMes[periodo] || 0,
            linhas: b.linhas, ignorados: b.ignorados, semData: b.semData,
            naoFiscal: naoFiscalBanco.total,
            naoFiscalPorCategoria: naoFiscalBanco.porCategoria,
            mesesNoBanco: Object.keys(b.porMes).sort(),
        };

        // 3) planilha
        const planilhaPath = process.env.PLANILHA_PATH;
        let planilha = { total: 0, disponivel: false, linhas: 0, linhasTodasOrig: 0 };
        let itensPlanilha = null;   // lançamentos do período, reusados pelo pareamento
        if (planilhaPath && fs.existsSync(planilhaPath)) {
            const porMes = contarNaPlanilha(planilhaPath);
            const m = porMes[periodo] || { lancamentos: 0, linhas: 0, linhasEscopoBruto: 0, linhasTodasOrig: 0, excluidos: 0, informativos: 0, porConta: {}, itens: [] };
            itensPlanilha = m.itens || [];
            planilha = {
                total: m.lancamentos,             // entradas fiscais que DEVERIAM ter documento
                disponivel: true,
                escopo: [...ORIG_ESCOPO],
                linhas: m.linhas,                 // linhas da base comparável, antes do agrupamento
                linhasEscopoBruto: m.linhasEscopoBruto, // linhas do escopo ORIG+FILIAL, antes dos cortes
                linhasTodasOrig: m.linhasTodasOrig,
                excluidos: m.excluidos,           // cortados por conta contábil / informativo
                informativos: m.informativos,
                porConta: m.porConta,             // composição do corte, p/ o tooltip
                // Base comparável = só os lançamentos que PODEM ter documento. Os cortados
                // por conta contábil não entram: eles nunca foram candidatos a nota arquivada,
                // e somá-los aqui inflava o número (1.527 em 03/2026, sendo 888 vale-refeição
                // e folha) a ponto de sugerir o dobro dos PDFs realmente esperados.
                antesDoCorte: m.lancamentos,
            };
        }

        // 4) pareamento — camada aditiva: casa lançamento × documento do MESMO mês.
        // Não toca nas contagens acima; se falhar, os três cards seguem válidos, por
        // isso o try/catch é local e o erro vira apenas `conferencia.disponivel=false`.
        let conferencia = { disponivel: false, motivo: 'pasta ou planilha indisponível' };
        if (pasta.disponivel && planilha.disponivel) {
            try {
                const t0 = Date.now();
                // Converte só as pastas que a conferência vai olhar (o mês e os
                // vizinhos), não o arquivo permanente inteiro.
                // O OCR já leu o miolo de cada PDF (número, emitente, valor, data)
                // e o índice saiu junto da contagem do banco. Ele PREENCHE o que o
                // nome do arquivo não traz — nome é digitado à mão e erra o nome do
                // fornecedor ("ARPESEG" por ARPSEG). Medido: +48 pares e precisão
                // de 88,9% para 90,9% (TIPOS-IGNORADOS §11).
                const ocrPorArquivo = (b && b.ocrPorArquivo) || {};
                const documentosPorMes = {};
                for (const off of [0, ...pareamento.VIZINHANCA]) {
                    const alvo = pareamento.deslocarPeriodo(periodo, off);
                    const arquivos = (pastaBruta && pastaBruta.arquivosPorMes[alvo]) || [];
                    documentosPorMes[alvo] = arquivos.map(a =>
                        pareamento.enriquecerComOcr(
                            pareamento.documentoDoArquivo(a.nome, a.rel),
                            ocrPorArquivo[a.nome]));
                }
                const lancamentos = (itensPlanilha || []).map(pareamento.lancamentoDaPlanilha);
                const r = pareamento.conferirPeriodo(lancamentos, documentosPorMes, periodo);
                const porVia = [...r.pares, ...r.paresVizinhos].reduce((acc, p) => {
                    acc[p.via] = (acc[p.via] || 0) + 1;
                    return acc;
                }, {});
                conferencia = {
                    disponivel: true,
                    // Total conferido = com documento em qualquer pasta. É o número do card.
                    conferidos: r.pares.length + r.paresVizinhos.length,
                    // Quantos vieram da pasta DESTE mês, e quantos de pasta vizinha.
                    noMes: r.pares.length,
                    emPastaVizinha: r.paresVizinhos.length,
                    porPastaVizinha: r.paresVizinhos.reduce((acc, p) => {
                        acc[p.periodoDocumento] = (acc[p.periodoDocumento] || 0) + 1;
                        return acc;
                    }, {}),
                    fracos: r.fracos,                                // apoiados num sinal só
                    lancamentosSemDocumento: r.lancamentosSemDocumento,
                    documentosSemLancamento: r.documentosSemLancamento,
                    porVia,
                    janelaDias: pareamento.JANELA_DIAS,
                    vizinhanca: r.vizinhanca,
                    ms: Date.now() - t0,
                    // ── O que a tela precisa para responder "está tudo arquivado?" ──
                    // Contagem sozinha trata R$ 12,10 de pedágio igual a R$ 21.616 de
                    // nota de serviço. Medido em 03/2026: dos 259 sem documento, 59 são
                    // abaixo de R$ 100 e somam R$ 2.600 — 23% dos casos, 0,09% do valor.
                    // O que decide a conferência é o valor, não a contagem.
                    ...resumoPorValor(lancamentos, r.semDocumento),
                };
                console.log(`[comparar-notas] ${periodo}: pareamento ${conferencia.conferidos} de ` +
                    `${lancamentos.length} lançamentos (${r.pares.length} no mês, ` +
                    `${r.paresVizinhos.length} em pasta vizinha, ${r.fracos} fracos) ` +
                    `em ${conferencia.ms} ms`);
            } catch (e) {
                console.error('[comparar-notas] pareamento falhou:', e.message);
                conferencia = { disponivel: false, motivo: e.message };
            }
        }

        console.log(`[comparar-notas] ${periodo}: pasta ${pasta.total}, banco ${banco.total}, planilha ${planilha.total}`);

        return res.json({ success: true, mes, ano, periodo, pasta, banco, planilha, conferencia });

    } catch (e) {
        console.error('[comparar-notas] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
