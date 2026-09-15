/**
 * routes/process-folder.js
 * Processa PDFs de uma pasta recursivamente, replicando a lógica do frontend
 * (conferencia-notas.html): extrai texto via pdf-parse, faz OCR via ocr_server.py
 * para PDFs-imagem, classifica e roda os parsers locais, e salva os resultados
 * nos relatórios mensais (M) e diários (D) em nfs.RELATORIOS_CONFERENCIA.
 *
 * Retorna: { success, processed, unchanged, errors, message, noChanges? }
 */
'use strict';

const path = require('path');
const fs = require('fs').promises;
const { PDFParse } = require('pdf-parse');
const { getConnection, sql } = require('../config');
const { classify, mk, norm, extrairCnpj, extrairEmitente, CTE_STRONG_RE, TRANSPORT_HINT_RE,
        enriquecerComChaveAcesso, enriquecerComBoleto } = require('./_nf-parsers');
const { extrairBoletosAI } = require('./_boletos-ai');
const { extrairNotaAI, TIPOS_VALIDOS } = require('./_nf-ai-full');
const { extrairNotaFiscal, camposParaDadosParser } = require('./_nf-itens');
const { lerPorVisao } = require('./_nf-visao');
const { transcrever } = require('./_nf-transcricao');
const { decidirValorPago } = require('./_valor-do-pagamento');

const OCR_URL = 'http://127.0.0.1:5001/ocr';

// ── Visão para PDF-imagem ────────────────────────────────────────────────────
// Liga a leitura por IA multimodal nos PDFs sem texto selecionável. MEDIDO em
// 10/09/2026 (`_medir/_visao-vs-ocr.js`): OCR + parsers preencheu 0 campos em 10
// documentos-imagem; a visão preencheu 37, a US$ 0,0022 cada.
//
// Desligável por variável de ambiente porque consome API paga: `VISAO_PDF=0`
// devolve o comportamento anterior (só OCR) sem tocar no código.
const VISAO_ATIVA = String(process.env.VISAO_PDF ?? '1') !== '0';

// ── Transcrição por IA no lugar do OCR ───────────────────────────────────────
// Para PDF-imagem, a IA transcreve a página e o texto segue pelo pipeline NORMAL
// (classify + parsers + FULL_PROMPT). MEDIDO em 16 PDF-imagem
// (`_medir/_transcrever-pdf-imagem.js`, 11/09/2026):
//
//                 campos certos   docs com campo   VALOR certo
//   hoje (OCR)          0            0/16             0/16
//   transcrição        16           14/16            14/16
//   visão direta       12           11/16            10/16
//
// A transcrição vence a visão direta porque NÃO decide qual campo é o quê — só
// converte pixels em caracteres e deixa o `FULL_PROMPT` decidir, com suas regras
// de precedência. Ver [[transcrever-nao-e-extrair]].
//
// Desligável porque consome API paga: `TRANSCRICAO_PDF=0` devolve o comportamento
// anterior (só OCR). Custo medido: ~US$ 2,41 pelos 1.037 PDF-imagem de março.
const TRANSCRICAO_ATIVA = String(process.env.TRANSCRICAO_PDF ?? '1') !== '0';

// O `tipo` que a visão devolve → as categorias que `classify` usa. Sem este mapa
// um "EXTRATO" viraria tipo desconhecido e o documento cairia em "Não
// identificado" mesmo tendo sido lido corretamente.
const TIPOS_VISAO = {
    NF: 'NF', NFS: 'NFS', FATURA: 'FATURA', RECIBO: 'RECIBO',
    BOLETO: 'FATURA',      // boleto avulso é cobrança — mesma prateleira de FATURA
    IMPOSTO: 'IMPOSTO', CONSORCIO: 'CONSORCIO',
    EXTRATO: 'RECIBO',     // extrato/comprovante bancário: documento de pagamento
};

// Valor no NOME do arquivo — gabarito independente para conferir o que a IA leu.
//
// A lógica é a de `valorDoNome` em _pareamento.js, e a ordem das alternativas é o
// que importa: ancorar em `.DOC-` e tentar COM separador de milhar antes de sem
// ele. Uma regex ingênua (`\d{1,3}(\.\d{3})*,\d{2}`) casa o SUFIXO — em
// "3505,50" ela devolve 505,50, e em "10034,63" devolve 34,63. Errado por um
// fator de 10 ou 100, e com cara de certo.
//
// Duplicado aqui em vez de importado: _pareamento é do comparador e este módulo é
// do scan; acoplá-los faria uma mudança no pareamento alterar silenciosamente o
// que se grava no banco.
function valorDoNomeArquivo(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i);
    if (!m) return null;
    if (/^\d{8}$/.test(m[1])) return null;      // "20260102" é data, não dinheiro
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
}

// Número da NOTA/FATURA no nome do arquivo — a âncora de `_valor-do-pagamento.js`.
//
// A contabilidade digita "NFS 886", "FT 245650", "NF 11283" no nome porque é o que
// identifica o documento; nos PDFs que trazem o boleto esse mesmo número está impresso
// ao lado do valor DAQUELA fatura, e é o que distingue um pagamento de outro numa
// ordem de compra coletiva (medido em 11/09/2026 nos 86 documentos da BIOS NET: 12
// pontos de internet numa OCP só, PDF idêntico, valores diferentes).
//
// Duplicado de `numeroDoNome` (_pareamento.js) pela MESMA razão que `valorDoNomeArquivo`
// acima: o comparador e o scan não devem se acoplar.
// `\d{1,12}` e não `\d{3,}`: há nota de número curto no acervo ("NFS 77", "NFS 113"),
// e descartá-la foi exatamente o erro que [[piso-digitos-numero-curto]] registra.
// A âncora se protege sozinha do número curto — ela exige ≥4 dígitos para procurar no
// texto —, então aqui o piso só perderia informação.
const RE_NUM_NOME = /\b(?:NFS-?e?|NFS|NF-?e?|NF|FT|FAT|FATURA|CT-?e?|RPS|RCB|REC|NOTA)\s*[.\-nN°ºo]*\s*(\d{1,12})\b/i;
function numeroDoNomeArquivo(nome) {
    const m = String(nome || '').match(RE_NUM_NOME);
    if (!m) return null;
    const d = m[1];
    // "20260102" é data no nome, não número de documento.
    if (/^(19|20)\d{6}$/.test(d)) return null;
    return d;
}

// Colunas do CSV — DEVE espelhar routes/relatorio.js
const COLS = ['arquivo', 'pasta', 'paginas', 'conteudo', 'tipo', 'evidencia', 'origem', 'ocr_usado', 'dados_parser', 'cnpj'];

// ── CSV helpers (espelham routes/relatorio.js) ────────────────────────────────
function csvEscape(val) {
    const s = String(val ?? '');
    return (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
}
function rowsToCsv(rows) {
    const lines = rows.map(row => COLS.map(col => csvEscape(row[col] ?? '')).join(';'));
    return '﻿' + [COLS.join(';'), ...lines].join('\r\n');
}
function parseCsvLine(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQ = false;
            else cur += ch;
        } else {
            if (ch === '"') inQ = true;
            else if (ch === ';') { fields.push(cur); cur = ''; }
            else cur += ch;
        }
    }
    fields.push(cur);
    return fields;
}
function csvToRows(csv) {
    const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
        const fields = parseCsvLine(line);
        const row = {};
        COLS.forEach((col, i) => { row[col] = fields[i] ?? ''; });
        return row;
    });
}

// ── Arquivos que não são documento ───────────────────────────────────────────
// A pasta guarda, ao lado da nota, o comprovante de pagamento (NNN.CPV.pdf) e o
// extrato do dia (000.pdf). O comparador já os ignora (RE_DOC em comparar-notas.js),
// mas até 09/09/2026 o SCAN lia todos: extraía texto, chamava OCR e gravava row —
// trabalho jogado fora, porque nada disso chega a ser comparado.
//
// Medido sobre os 15.761 PDFs de \\larsil-dell\LA26.EXT.BANC (_medir/_quanto-e-doc.js):
//
//   CPV (NNN.CPV)            8.858   56,2%
//   DOC (NNN.DOC)            6.265   39,8%
//   extrato do dia (000.*)     540    3,4%
//   outros                      86    0,5%
//
// O filtro é pelo que se PROVOU não ser documento, e não pelo prefixo NNN.DOC.
// A diferença importa (_medir/_risco-filtro.js): dos CPVs lidos, 0/120 são fiscais
// e dos extratos 0/40 — pular é seguro. Mas dos 86 "outros", 6,7% SÃO fiscais, e
// entre eles "021.ODC-...ESSOR" (DOC com as letras trocadas na digitação) e três
// NFS-e da SASCAR em débito automático, que nunca receberam o prefixo. Filtrar por
// `^NNN.DOC` descartaria essas notas de verdade; excluir só CPV/extrato, não.
const RE_CPV          = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_EXTRATO_DIA  = /^0+\s*[.\-]/;

function ehAnexoIgnoravel(nome) {
    const n = String(nome || '');
    return RE_CPV.test(n) || RE_EXTRATO_DIA.test(n);
}

// ── Coleta de PDFs ────────────────────────────────────────────────────────────
// Devolve { files, ignorados } — `ignorados` alimenta o log, para a economia ficar
// visível e um filtro errado não passar despercebido.
async function collectPdfs(dirPath, rootPath = dirPath, files = [], contagem = { ignorados: 0 }) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
                if (ehAnexoIgnoravel(entry.name)) { contagem.ignorados++; continue; }
                // pasta = caminho relativo da subpasta (sem o nome do arquivo), com "/"
                const rel = path.relative(rootPath, dirPath).split(path.sep).join('/');
                files.push({ path: fullPath, name: entry.name, folder: rel });
            } else if (entry.isDirectory()) {
                await collectPdfs(fullPath, rootPath, files, contagem);
            }
        }
    } catch (e) {
        console.error(`[process-folder] erro ao ler pasta ${dirPath}:`, e.message);
    }
    files.ignorados = contagem.ignorados;
    return files;
}

// Extrai DD.MM.YYYY do caminho relativo (subpasta YYYY.MM.DD ou DD.MM.YYYY)
function folderToDay(folder) {
    const mNew = folder.match(/(?:^|\/)(\d{4})\.(\d{2})\.(\d{2})(?:\/|$)/);
    if (mNew) return `${mNew[3]}.${mNew[2]}.${mNew[1]}`;
    const mOld = folder.match(/(?:^|\/)(\d{2})\.(\d{2})\.(\d{4})(?:\/|$)/);
    if (mOld) return `${mOld[1]}.${mOld[2]}.${mOld[3]}`;
    return null;
}

// Extrai DD.MM.YYYY da DATA embutida no nome do arquivo. Os nomes seguem o
// padrão "NNN.DOC- valor - YYYY.MM.DD. EMITENTE ..." (a data do documento), com
// o ano entre 2000-2099. Aceita também DD.MM.YYYY. Retorna null se não achar.
function filenameToDay(name) {
    const n = String(name || '');
    const mNew = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (mNew) return `${mNew[3]}.${mNew[2]}.${mNew[1]}`;
    const mOld = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (mOld) return `${mOld[1]}.${mOld[2]}.${mOld[3]}`;
    return null;
}
// ── Conserto da data do nome pela subpasta ───────────────────────────────────
// O nome do arquivo é digitado à mão e às vezes erra a data. A subpasta
// (".../SANTANDER/2026.02.09/") é criada pelo processo de arquivamento e não tem
// esse erro. Medido em 03/09/2026 sobre os 4.238 PDFs do arquivo permanente
// (_medir/classificar-divergencia.js), nas 144 divergências de mês entre os dois:
//
//   causa                                       n   veredito
//   dia/mês trocado (2026.09.02 na pasta 02.09) 10   erro de digitação -> corrigir
//   ANO errado, dia e mês idênticos             33   erro de digitação -> corrigir
//   ano errado, mesmo mês, dia difere            1   erro de digitação -> corrigir
//   documento de mês anterior, até 3 meses      63   LEGÍTIMO -> não mexer
//   resto (vencimento futuro, conta antiga)     37   ambíguo   -> não mexer
//
// Por isso o conserto é CIRÚRGICO, e não "a pasta sempre ganha": 63 dos 144 são
// conta antiga paga agora, em que o nome está certo e a pasta é a data de
// arquivamento. Trocar tudo pela pasta também perderia o DIA correto de 644
// arquivos cujo nome diverge só no dia, com o mês concordando.
//
// Só as duas assinaturas inequívocas são corrigidas:
//   (a) desinverter dia/mês no nome dá exatamente a data da pasta;
//   (b) o MÊS do nome bate com o da pasta e só o ano difere — aí o ano é engano de
//       digitação e o resto do nome está certo, então preserva-se o DIA DO NOME
//       (que é a data do documento) e troca-se só o ano.
// Em ambos os casos existe prova de que foi erro de digitação, não data real.
//
// A regra (b) não exige o dia igual porque a assinatura do erro é o ano: a ESSOR
// 2505 é uma parcela mensal arquivada com "2025." em janeiro a maio de 2026 e com
// "2026." em junho — em março o nome diz dia 06 e a pasta é dia 05 (arquivado um
// dia antes). Exigir o dia idêntico deixaria justamente esse caso passar.
function consertarDataPelaPasta(diaNome, diaPasta) {
    if (!diaNome || !diaPasta || diaNome === diaPasta) return diaNome;
    const [dn, mn, yn] = diaNome.split('.');
    const [dp, mp, yp] = diaPasta.split('.');
    // (a) dia/mês trocado na digitação
    if (dn === mp && mn === dp && yn === yp) return diaPasta;
    // (b) ano errado, mês correto — corrige só o ano, preservando o dia do nome
    if (mn === mp && yn !== yp) return `${dn}.${mn}.${yp}`;
    return diaNome;
}

function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * A data lida pela IA é plausível? "DD/MM/AAAA", dia 1-31, mês 1-12, ano do
 * anterior ao próximo.
 *
 * Esta trava existia SÓ no caminho da visão (`_nf-visao.js`, sanidade de ANO) e
 * faltava no caminho da IA de texto, que gravava a string crua. MEDIDO em
 * 11/09/2026 (`_medir/_datas-ruins-no-banco.js`): 31 datas inválidas em 5.899
 * linhas, 25 pela origem `IA` —
 *
 *   19  "31/12/1970"   epoch 0: a IA devolveu 0/vazio e virou data
 *    6  "06/06/23"     ano de 2 dígitos
 *    4  "10/04/2017"   fora da janela
 *    2  "26/12/2029"   futuro
 *
 * O dano é o que o comentário de `_nf-visao.js` já descrevia: data no futuro
 * desloca o documento para uma pasta-mês inexistente e ele SOME da conferência.
 * Melhor não gravar data do que gravar data errada — o campo vazio é lacuna
 * visível, a data errada é dano silencioso.
 *
 * A janela é a MESMA de `_nf-visao.js` de propósito: dois caminhos de leitura com
 * réguas diferentes foi justamente o que produziu este bug.
 */
function dataPlausivel(s) {
    const t = String(s || '').trim();
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return false;
    const [dia, mes, ano] = t.split('/').map(Number);
    const anoAgora = new Date().getFullYear();
    return dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12
        && ano >= anoAgora - 6 && ano <= anoAgora + 1;
}

// ── Extração de texto (pdf-parse) ─────────────────────────────────────────────
async function extractText(buffer) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        // pdf-parse 2.x insere "-- N of M --" entre páginas — remove para não poluir o regex
        const text = (result.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        const pages = result.total || (Array.isArray(result.pages) ? result.pages.length : 1);
        const isImage = text.replace(/\s/g, '').length < 15;
        return { text, pages, isImage };
    } finally {
        try { await parser.destroy(); } catch (_) {}
    }
}

// ── OCR via servidor Python ────────────────────────────────────────────────────
// Erro em que o OCR NÃO chegou a opinar sobre o documento: serviço fora do ar,
// sem memória, timeout. É diferente de "o OCR rodou e não achou texto", que é
// resultado legítimo. A distinção existe porque um documento-imagem sem OCR não
// tem conteúdo nenhum para classificar — gravá-lo como "Não identificado"
// apagaria o dado bom de uma leitura anterior (ver `ocrIndisponivel` abaixo).
class ErroOcrIndisponivel extends Error {
    constructor(msg) { super(msg); this.name = 'ErroOcrIndisponivel'; }
}

// Falhas CONSECUTIVAS de OCR indisponível que caracterizam serviço fora do ar (e
// não arquivo problemático). 5 é baixo o bastante para abortar em segundos e alto
// o bastante para tolerar um soluço isolado — na queda medida em 10/09/2026 as
// falhas vieram em rajada, sem nenhum sucesso entre elas.
const MAX_FALHAS_OCR = 5;

async function ocrViaBackend(buffer) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'application/pdf' }), 'upload.pdf');
    let res;
    try {
        res = await fetch(OCR_URL, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(120_000),
        });
    } catch (e) {
        // fetch falhou: processo morto, conexão recusada ou timeout.
        throw new ErroOcrIndisponivel(e.message || 'OCR inacessível');
    }
    if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        const msg = error || `OCR server ${res.status}`;
        // 5xx é falha DO SERVIDOR (o PaddleOCR estourou memória, por exemplo),
        // não veredito sobre o documento. Medido em 10/09/2026: uma rodada de
        // releitura acumulou 45 destes com "Unable to allocate 7.38 MiB" e
        // "could not create a primitive" enquanto o serviço agonizava.
        if (res.status >= 500) throw new ErroOcrIndisponivel(msg);
        throw new Error(msg);
    }
    const { text, error } = await res.json();
    if (error) throw new Error(error);
    return text || '';
}

// ── Detecção de candidato a multi-boleto (carnê) ──────────────────────────────
// Pré-filtro BARATO que decide quando vale a pena chamar a IA. É recall-oriented:
// pode ter falso positivo (custa 1 chamada de IA, que então responde "1 boleto"),
// mas evita chamar a IA em todo documento. Funciona em texto real e em OCR.
function pareceMultiBoleto(text, pages) {
    const t = norm(text);
    const ehBoleto = /NOSSO N[UÚ]MERO|FICHA DE COMPENSA|\bCEDENTE\b|BENEFICI[AÁ]RIO|LINHA DIGIT[AÁ]VEL|\bPAGADOR\b|\bSACADO\b/.test(t);
    if (!ehBoleto) return false;
    // sinal 1: ≥2 linhas digitáveis distintas (47 dígitos em 5 blocos)
    const linhas = new Set((t.match(/\d{5}[.\s]\d{5}\s+\d{5}[.\s]\d{6}\s+\d{5}[.\s]\d{6}\s+\d\s+\d{14}/g) || []));
    if (linhas.size >= 2) return true;
    // sinal 2: ≥2 "nosso número" distintos
    const nossos = new Set((t.match(/NOSSO N[UÚ]MERO\D{0,8}([\d./-]{6,})/g) || []));
    if (nossos.size >= 2) return true;
    // sinal 3: ≥2 vencimentos com datas distintas (só GATEIA a IA; ela é a árbitra)
    const vencs = new Set((t.match(/VENCIMENTO\D{0,8}(\d{2}[/.]\d{2}[/.]\d{2,4})/g) || []));
    if (vencs.size >= 2) return true;
    // sinal 4: boleto com várias páginas (carnê escaneado)
    const np = parseInt(pages, 10);
    if (Number.isFinite(np) && np >= 2) return true;
    return false;
}

// "DD/MM/AAAA" → "DD.MM.AAAA" (chave de dia usada no pipeline). null se inválida.
function vencToDay(venc) {
    const m = String(venc || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// Se a row é uma parcela de carnê, devolve seu vencimento "DD/MM/AAAA"; senão null.
function parcelaVenc(row) {
    if (!/#p\d+$/i.test(row.arquivo || '')) return null;
    try {
        const pd = JSON.parse(row.dados_parser);
        return pd && pd['Parcela'] ? (pd['Data de vencimento'] || null) : null;
    } catch (_) { return null; }
}

// Chave do dados_parser onde o número do documento é gravado, por tipo. O
// comparar-notas lê via OR ('Nº da NF-e' || 'Nº do CT-e' || 'Número do documento'),
// então basta gravar na chave semântica do tipo.
function chaveNumeroPorTipo(tipo) {
    if (tipo === 'CTE') return 'Nº do CT-e';
    if (tipo === 'IMPOSTO') return 'Número do documento';
    return 'Nº da NF-e';
}

// ── Leitura COMPLETA via IA (modo "Forçar Leitura via IA") ────────────────────
// Manda o texto (real ou OCR) para a IA, que devolve tipo/emitente/cnpj/data/
// número/valor/parcelas de uma vez. Monta as rows no MESMO formato que os parsers
// locais produzem (dados_parser + coluna tipo + coluna cnpj), com origem "IA" para
// o cache reconhecer. Retorna array de rows, ou null se a IA não trouxe nada útil
// (aí o chamador faz fallback para o parser local).
// `camposVisao` / `tipoVisao`: o que a VISÃO leu da página, quando o PDF é imagem.
// Chegam preenchidos só no modo IA sobre PDF-imagem (ver analyzePdf). São a leitura
// do PAPEL; `r` é a leitura do TEXTO que a transcrição produziu a partir do papel.
async function analyzeViaAI(pdf, text, pages, ocrUsed, isImage, camposVisao = null, tipoVisao = null) {
    let r;
    try {
        r = await extrairNotaAI({ text, filename: pdf.name, pages });
    } catch (e) {
        console.warn(`[process-folder] IA full erro em ${pdf.name}: ${e.message}`);
        return null;
    }
    if (r.error) console.warn(`[process-folder] IA full em ${pdf.name}: ${r.error}`);
    // Sem nada aproveitável → deixa o parser local tentar.
    // A visão conta como aproveitável: ela leu a página, e desistir aqui mandaria o
    // documento para o parser local, que em PDF-imagem não tem texto nativo para ler.
    if (!r.tipo && !r.emitente && !r.numero && r.parcelas.length === 0
        && !(camposVisao && Object.keys(camposVisao).length)) return null;

    // A classificação da VISÃO tem precedência quando a IA de texto não classificou:
    // ela viu a página, enquanto `r.tipo` vem do texto transcrito. Mesma regra do
    // caminho local (ver o bloco de visão em analyzePdf).
    const tipoIA = TIPOS_VALIDOS.includes(r.tipo) ? r.tipo : 'Não identificado';
    const tipo = (tipoIA === 'Não identificado' && tipoVisao) ? tipoVisao : tipoIA;
    const numKey = chaveNumeroPorTipo(tipo);

    // Do texto, sempre e antes da IA: a chave de acesso (a IA lê campos de boleto e não
    // olha a DANFE anexa, onde a chave está) e a linha digitável (valor e vencimento são
    // aritmética do código, não leitura). Nenhum sobrescreve o que a IA leu direto.
    const pdComum = enriquecerComBoleto(enriquecerComChaveAcesso({}, text), text);

    // Campos fiscais: as DUAS fontes rodam, e cada uma cobre o buraco da outra.
    // Medido em 09/09/2026: o extrator local acha itens em 70% dos DANFEs (falha
    // quando o layout quebra a linha do item) e unidade em só 27%; a IA lê layout
    // quebrado bem, mas alucina onde não há o que ler. Por isso o determinístico
    // entra PRIMEIRO e a IA preenche o que ficou vazio — nunca o contrário: chave
    // e CNPJ do extrator são validados por construção (UF, modelo, CNPJ embutido),
    // e trocá-los por uma leitura seria perder a única evidência verificável.
    try {
        const local = camposParaDadosParser(extrairNotaFiscal(text));
        Object.assign(pdComum, { ...local, ...pdComum });
    } catch (e) {
        console.warn(`[process-folder] extração fiscal local falhou em ${pdf.name}: ${e.message}`);
    }

    // ── O PARSER ESPECÍFICO DO TIPO (parseNfse, parseDanfe, parseCte, parseImposto)
    //
    // Até 15/09/2026 este caminho NÃO o chamava, e o caminho local chamava (linha
    // ~830: `c.parser ? c.parser(text) : null`). Como o modo IA é o de produção desde
    // §16.1, o efeito era estrutural: campos que só o parser de tipo produz nunca
    // chegavam ao banco, em nenhum documento, de nenhum mês.
    //
    // O que se perdia, medido em 12 NFS-e reais de 03.2026 após a releitura de hoje:
    //   - RETENÇÃO em 5 deles (ISS 4,80 · COFINS 690,38 · PIS 149,89 …) — 0 no banco
    //   - `Valor do serviço` em 11 — 0 no banco
    // O schema do `extrairNotaAI` não tem campo algum de retenção, então a IA também
    // não supre a falta. §15.4 mediu R$ 13.019,88 em retenções em jan–jun.
    //
    // Isso importa além do número: `retencao-na-fonte-nao-e-divergencia` registra que o
    // imposto retido fazia a NFS-e PARECER errada na conferência — o líquido pago não
    // batia com o total da nota, e sem os campos de retenção não havia como explicar.
    //
    // PRECEDÊNCIA: preenche só o que está VAZIO. Tudo que veio antes tem prioridade —
    // chave de acesso e linha digitável são validadas por construção (DV mod-11, fator
    // de vencimento) e uma leitura não substitui prova aritmética
    // ([[chave-acesso-valida-o-dv]]); o extrator fiscal genérico já rodou.
    //
    // `classify` roda sobre o MESMO texto que a IA recebeu (nativo, transcrito ou de
    // OCR), então em PDF-imagem ele enxerga o que a transcrição produziu — e quando
    // não há texto, `c.parser` simplesmente não acha nada e nada é sobrescrito.
    try {
        const cLocal = classify(text, pdf.name);
        if (cLocal.parser) {
            const doTipo = cLocal.parser(text) || {};
            for (const [k, v] of Object.entries(doTipo)) {
                if (v == null || String(v).trim() === '' || String(v).trim() === '—') continue;
                if (pdComum[k] == null || String(pdComum[k]).trim() === '') pdComum[k] = v;
            }
        }
    } catch (e) {
        console.warn(`[process-folder] parser de tipo falhou em ${pdf.name}: ${e.message}`);
    }

    // ── O que a VISÃO leu da PÁGINA ──────────────────────────────────────────
    // Entra DEPOIS do extrator determinístico e ANTES da IA de texto, preenchendo só
    // o que está vazio. A ordem não é arbitrária:
    //
    //   - chave de acesso, CNPJ e linha digitável saem do extrator VALIDADOS por
    //     construção (DV mod-11, UF, modelo). Uma leitura — por melhor que seja —
    //     não substitui prova aritmética ([[chave-acesso-valida-o-dv]]).
    //   - a visão vem ANTES da IA de texto porque, em PDF-imagem, ela leu o PAPEL e a
    //     IA leu a TRANSCRIÇÃO do papel: uma geração a menos de ruído.
    //
    // `lerPorVisao` já aplica a trava do gabarito do nome: valor que diverge não entra
    // como 'Valor total', vai para campo separado marcado como não-confiável. Por isso
    // o merge aqui não precisa re-julgar o valor.
    if (camposVisao) {
        for (const [k, v] of Object.entries(camposVisao)) {
            if (v == null || String(v).trim() === '' || String(v).trim() === '—') continue;
            if (pdComum[k] == null || String(pdComum[k]).trim() === '') pdComum[k] = v;
        }
    }

    if (r.numero)      pdComum[numKey] = r.numero;
    if (r.ordemCompra) pdComum['Ordem de Compra'] = r.ordemCompra;
    if (r.cnpj)        pdComum['CNPJ emitente'] = r.cnpj;
    // Data da IA passa pela MESMA sanidade que a visão já aplicava. Ver
    // `dataPlausivel` — sem ela, 25 linhas do acervo ficaram com data inválida,
    // 19 delas "31/12/1970".
    if (dataPlausivel(r.dataEmissao)) pdComum['Data de emissão'] = r.dataEmissao;

    // EMITENTE — o nome do ARQUIVO manda, como em analyzePdf (ver o comentário longo
    // lá e a memória [[emitente-nao-vem-do-extrator]]). Esta precedência existia só no
    // caminho local; aqui a IA gravava o nome que leu do PDF, direto.
    //
    // Medido em 09/09/2026 (`_medir/_emitente-larsil.js`): 1.752 documentos (16% dos
    // que têm emitente) ficaram com "LARSIL …" no campo — o nome do PAGADOR, porque em
    // recibo e NFS de serviço prestado A NÓS o único nome com destaque na página é o
    // nosso. Em 214 deles o CNPJ ao lado já era de terceiro, provando que o errado era
    // o nome. E `extrairEmitente` acertava esses mesmos casos pelo nome do arquivo
    // ("PRIMO ROSSI", "DALIANI CRISTINI"), mas o valor era descartado aqui.
    //
    // Mesma doença de [[cnpj-do-emitente-pega-o-pagador]], no campo do nome.
    const emitenteDoNome = extrairEmitente(pdf.name);
    if (emitenteDoNome) {
        // A razão social lida da nota não se perde: vai para campo próprio, e
        // `_pareamento.js` UNE os tokens das duas fontes em vez de substituir.
        if (r.emitente && norm(r.emitente) !== norm(emitenteDoNome)) pdComum['Razão social (nota)'] = r.emitente;
        pdComum['Emitente'] = emitenteDoNome;
    } else if (r.emitente) {
        pdComum['Emitente'] = r.emitente;
    }

    // Os campos fiscais da IA só preenchem o que o extrator não achou.
    if (r.nomeSocial && !pdComum['Nome social']) pdComum['Nome social'] = r.nomeSocial;
    if (r.cfop && !pdComum['CFOP']) pdComum['CFOP'] = r.cfop;
    if (r.chaveAcesso && !pdComum['Chave de acesso']) pdComum['Chave de acesso'] = r.chaveAcesso;
    if (r.itens && r.itens.length && !pdComum['Itens']) {
        pdComum['Itens'] = r.itens.map(it => ({
            'Descrição': it.descricao,
            'NCM': it.ncm,
            'CFOP': it.cfop,
            'Unidade': it.unidade,
            'Quantidade': it.quantidade,
            'Valor unitário': it.valorUnitario == null ? '' : String(it.valorUnitario.toFixed(2)).replace('.', ','),
            'Valor total': it.valorTotal == null ? '' : String(it.valorTotal.toFixed(2)).replace('.', ','),
            'Confiança': it.confianca,
        }));
        pdComum['Qtd. de itens'] = String(r.itens.length);
        pdComum['Origem dos itens'] = 'IA';
    }

    const baseRow = {
        arquivo:      pdf.name,
        pasta:        pdf.folder || '',
        paginas:      String(pages),
        // A procedência fica VISÍVEL na coluna: quem confere precisa saber se o dado
        // veio do papel (visão), da transcrição ou do OCR. Sem distinguir, "Imagem"
        // cobriria as três e a conferência perderia a pista — mesma razão do rótulo
        // no caminho local.
        conteudo:     isImage
            ? `Imagem${camposVisao ? ' (visão)' : ocrUsed ? ' (OCR)' : ''}`
            : 'Texto',
        tipo,
        evidencia:    r.emitente ? `IA: ${r.emitente}` : (camposVisao ? 'visão (IA)' : 'IA'),
        origem:       camposVisao ? 'IA + visão' : 'IA',
        ocr_usado:    String(ocrUsed),
        dados_parser: '',
        cnpj:         r.cnpj || '',
    };

    // QUAL dos valores do documento é o que se paga. Ver `_valor-do-pagamento.js`:
    // 46% dos erros de valor tinham o número certo já lido, em outra chave, e a âncora
    // pelo nº da fatura resolve a ordem de compra coletiva, que releitura nenhuma
    // resolve. Medido (amostra aleatória de 300): 55% → 71% de acerto.
    //
    // Roda DEPOIS de `pdComum` estar completo e ANTES do carnê: nas parcelas quem
    // decide valor é a IA de boletos, e o bloco abaixo apaga `Valor do boleto` de
    // propósito para não replicar a parcela errada em todas as linhas.
    Object.assign(pdComum, decidirValorPago(pdComum, {
        text,
        numeroDoNome: numeroDoNomeArquivo(pdf.name),
    }));

    // Carnê confirmado pela IA (Nosso Número distintos) → uma row por parcela.
    if (r.parcelas.length > 1) {
        console.log(`[process-folder] IA: carnê em ${pdf.name} — ${r.parcelas.length} parcelas`);
        // Os campos do boleto saem: extraímos UMA linha digitável, e num carnê ela é de
        // uma parcela só — replicá-la em todas daria o mesmo valor/vencimento para N
        // parcelas diferentes. Aqui quem sabe separar as parcelas é a IA.
        const semBoleto = { ...pdComum };
        delete semBoleto['Linha digitável'];
        delete semBoleto['Valor do boleto'];
        delete semBoleto['Banco do boleto'];
        delete semBoleto['Data de vencimento'];
        return r.parcelas.map((b, i) => {
            const pd = {
                ...semBoleto,
                'Data de vencimento': b.vencimento,
                'Valor total':        b.valor > 0 ? String(b.valor).replace('.', ',')
                                                  : (r.valorTotal > 0 ? String(r.valorTotal).replace('.', ',') : ''),
                'Nosso Número':       b.nossoNumero || '',
                'Parcela':            `${i + 1}/${r.parcelas.length}`,
                'arquivo_original':   pdf.name,
            };
            return { ...baseRow, arquivo: `${pdf.name}#p${i + 1}`, dados_parser: JSON.stringify(pd) };
        });
    }

    // Boleto/documento único. Captura o vencimento (campo próprio ou a única parcela)
    // para alimentar o alerta de data do comparar-notas.
    const pd = { ...pdComum, 'Valor total': r.valorTotal > 0 ? String(r.valorTotal).replace('.', ',') : '' };
    // O vencimento do fator de vencimento tem precedência sobre o lido: é aritmética do
    // código de barras, e o campo lido costuma vir vazio. Só cai para a IA se não houver.
    // O vencimento LIDO pela IA passa pela mesma sanidade da data de emissão (foi
    // por aqui que entrou um "26/12/2029"). O vencimento que vem do FATOR DE
    // VENCIMENTO não passa por aqui e nem deve: é aritmética do código de barras,
    // já gravado acima, e um boleto pode legitimamente vencer além da janela.
    const vencUnico = r.dataVencimento || (r.parcelas.length === 1 ? r.parcelas[0].vencimento : '');
    if (vencUnico && dataPlausivel(vencUnico) && !pd['Data de vencimento']) pd['Data de vencimento'] = vencUnico;
    return [{ ...baseRow, dados_parser: JSON.stringify(pd) }];
}

// ── Analisa um PDF e devolve array de rows prontas para o CSV ─────────────────
// Caso normal: array com 1 row. Multi-boleto (carnê confirmado pela IA): N rows,
// cada uma com arquivo = "original.pdf#p{n}" e dados_parser com a parcela específica.
// opts.forceAI → faz a leitura inteira pela IA (com fallback p/ parser local).
async function analyzePdf(pdf, opts = {}) {
    const forceAI = !!opts.forceAI;
    const buffer = await fs.readFile(pdf.path);

    let text, pages, isImage;
    try {
        ({ text, pages, isImage } = await extractText(buffer));
    } catch (e) {
        text = ''; pages = '?'; isImage = true;
    }

    // Modo IA: garante texto (OCR p/ imagem) e manda tudo p/ a IA. Fallback ao local.
    if (forceAI) {
        let ocrUsed = false;
        let camposVisaoIA = null, tipoVisaoIA = null;
        if (isImage) {
            // ── VISÃO primeiro, como no caminho local ────────────────────────
            // Até 14/09/2026 este ramo ia direto para transcrição/OCR e retornava na
            // chamada a `analyzeViaAI` ABAIXO — antes do bloco de visão, que fica no
            // caminho do parser local. Resultado: no modo IA (o de produção desde
            // §16.1) a imagem virava TEXTO e o texto ia para a IA; a via de visão,
            // medida e aprovada em §15.10 (OCR preencheu 0 campos, visão preencheu
            // 37), era inalcançável. O baseline de 03.2026 mostra a consequência:
            // 7 documentos de origem `visão (IA)` em 548 fiscais.
            //
            // NÃO MEDIDO A/B — é correção de coerência, não otimização. O universo
            // é pequeno demais para um veredito: em 01..06/2026 há 3.087 documentos
            // fiscais com gabarito e apenas 22 são PDF-imagem (0,7%). Com 22 casos
            // uma diferença de 3 ou 4 é ruído ([[inspecao-anima-medicao-decide]]).
            // O que justifica a mudança é a COERÊNCIA: o modo IA passa a usar para
            // imagem a mesma via que o modo local já usa, em vez de duas leituras
            // diferentes para o mesmo papel.
            //
            // A visão não dispensa a transcrição: ela devolve CAMPOS e não texto, e
            // sem texto `enriquecerComChaveAcesso` e `enriquecerComBoleto` (que
            // decodificam chave e linha digitável por ARITMÉTICA, não por leitura)
            // ficam sem o que ler. Por isso a transcrição continua logo abaixo.
            if (VISAO_ATIVA) {
                try {
                    const rv = await lerPorVisao(buffer, pdf.name, valorDoNomeArquivo(pdf.name));
                    if (rv.campos) {
                        camposVisaoIA = rv.campos;
                        if (rv.tipo && rv.tipo !== 'OUTRO') tipoVisaoIA = TIPOS_VISAO[rv.tipo] || null;
                        if (rv.veredito === 'diverge') {
                            console.warn(`[process-folder] visão (modo IA): valor de ${pdf.name} não confere ` +
                                `com o nome — gravado como não-confiável`);
                        }
                    } else if (rv.erro) {
                        console.warn(`[process-folder] visão falhou em ${pdf.name}: ${rv.erro}`);
                    }
                } catch (e) {
                    console.warn(`[process-folder] visão falhou em ${pdf.name}: ${e.message}`);
                }
            }

            // TRANSCRIÇÃO depois da visão, OCR como reserva. A ordem vem da medição:
            // nos PDF-imagem a transcrição acertou o valor em 14/16 e o OCR em 0.
            //
            // Isto também conserta um bug real: antes, com o OCR fora do ar, a IA
            // de texto era chamada com texto VAZIO e o `FULL_PROMPT` manda deduzir
            // do NOME DO ARQUIVO (linha 89 e 95 do prompt) — foi assim que entrou
            // "31/12/1970" e outros campos sem leitura nenhuma do papel. Ver
            // [[ia-le-nome-do-arquivo-sem-ocr]].
            if (TRANSCRICAO_ATIVA) {
                try {
                    const t = await transcrever(buffer);
                    if (t.texto && t.texto.replace(/\s/g, '').length >= 15) {
                        text = t.texto;
                        ocrUsed = true;   // o texto NÃO é nativo: a flag diz isso ao resto
                        if (t.falhas) console.warn(`[process-folder] transcrição de ${pdf.name}: ` +
                            `${t.falhas}/${t.nPaginas} página(s) não transcritas`);
                    } else if (t.erro) {
                        console.warn(`[process-folder] transcrição falhou em ${pdf.name}: ${t.erro}`);
                    }
                } catch (e) {
                    console.warn(`[process-folder] transcrição falhou em ${pdf.name}: ${e.message}`);
                }
            }
            // OCR: só se a transcrição não resolveu.
            if (!ocrUsed) {
                try {
                    const ocrText = await ocrViaBackend(buffer);
                    if (ocrText) { text = ocrText; ocrUsed = true; }
                } catch (e) {
                    console.warn(`[process-folder] OCR (IA) falhou em ${pdf.name}: ${e.message}`);
                    // Mesma recusa do caminho local, e aqui ela vale ainda mais: sem
                    // texto, o prompt manda a IA extrair os dados do NOME DO ARQUIVO
                    // (_nf-shared.js). O resultado seria dado DEDUZIDO gravado como se
                    // tivesse sido lido do papel.
                    if (e instanceof ErroOcrIndisponivel) {
                        throw new ErroOcrIndisponivel(
                            `${pdf.name}: PDF é imagem e o OCR está indisponível (${e.message})`);
                    }
                }
            }

            // Nada leu o papel: nem a visão, nem a transcrição, nem o OCR. Recusar é
            // obrigatório — seguir daqui chama a IA com texto VAZIO, e o prompt manda
            // deduzir do nome do arquivo. Foi assim que 32 registros ganharam dado
            // inventado com cara de lido ([[ia-le-nome-do-arquivo-sem-ocr]]) e assim
            // que entrou o "31/12/1970". Melhor erro visível do que leitura falsa.
            //
            // A VISÃO conta como leitura do papel: ela devolve campos lidos da página,
            // com a trava do gabarito do nome aplicada. Quando ela leu, seguir sem
            // texto é seguro — `analyzeViaAI` grava os campos da visão, e a IA de
            // texto não tem o que inventar porque o texto vazio não produz campos.
            if (!ocrUsed && !camposVisaoIA) {
                throw new ErroOcrIndisponivel(
                    `${pdf.name}: PDF é imagem e nem a visão, nem a transcrição, nem o OCR conseguiram ler`);
            }
        }
        const rowsIA = await analyzeViaAI(pdf, text, pages, ocrUsed, isImage, camposVisaoIA, tipoVisaoIA);
        if (rowsIA) return rowsIA;
        console.warn(`[process-folder] IA sem resultado em ${pdf.name} — usando parser local`);
    }

    let ocrUsed = false;
    let c = classify(text, pdf.name);

    // ── PDF-imagem: VISÃO antes do OCR ───────────────────────────────────────
    // MEDIDO em 10/09/2026 (`_medir/_visao-vs-ocr.js`), 10 PDFs-imagem de 03.2026:
    // o OCR + parsers preencheu ZERO campos (10× "Não identificado"); a visão
    // preencheu 37 e classificou corretamente (RECIBO/EXTRATO/FATURA). Custo de
    // US$ 0,0022 por documento.
    //
    // A ordem importa: para o que é imagem, a visão é a leitura melhor e o OCR
    // vira a reserva. Para PDF com texto nativo nada muda — ali `pdf-parse` já
    // entrega o que o emissor gravou, e reconhecimento visual seria pior.
    let visaoUsada = false, camposVisao = null;
    if (isImage && VISAO_ATIVA) {
        try {
            const r = await lerPorVisao(buffer, pdf.name, valorDoNomeArquivo(pdf.name));
            if (r.campos) {
                camposVisao = r.campos;
                visaoUsada = true;
                if (r.tipo && r.tipo !== 'OUTRO') {
                    // A visão classificou; `classify` não teria o que ler.
                    c = mk(TIPOS_VISAO[r.tipo] || 'Não identificado', 'lido da imagem', 'visão (IA)');
                }
                if (r.veredito === 'diverge') {
                    console.warn(`[process-folder] visão: valor de ${pdf.name} não confere com o nome ` +
                        `(leu de "${r.dados && r.dados.ondeAcheiOValor}") — gravado como não-confiável`);
                }
            } else if (r.erro) {
                console.warn(`[process-folder] visão falhou em ${pdf.name}: ${r.erro}`);
            }
        } catch (e) {
            console.warn(`[process-folder] visão falhou em ${pdf.name}: ${e.message}`);
        }
    }

    // ── TRANSCRIÇÃO: dá TEXTO ao pipeline de parsers ─────────────────────────
    // A visão (acima) devolve CAMPOS, e é a melhor leitura de imagem. Mas ela não
    // devolve texto, então `classify` e os parsers ficam sem nada para ler — o
    // documento vale pelos campos da visão e mais nada. A transcrição preenche
    // essa lacuna: com texto, `classify` acha o tipo, `enriquecerComChaveAcesso`
    // acha a chave de 44 dígitos e `enriquecerComBoleto` decodifica a linha
    // digitável (valor e vencimento por aritmética, não por leitura).
    //
    // Roda mesmo quando a visão já leu, porque as duas trazem coisas diferentes —
    // e nunca sobrescreve o texto de um PDF que já tem texto nativo.
    let transcricaoUsada = false;
    if (isImage && TRANSCRICAO_ATIVA && !ocrUsed) {
        try {
            const t = await transcrever(buffer);
            if (t.texto && t.texto.replace(/\s/g, '').length >= 15) {
                text = t.texto;
                transcricaoUsada = true;
                const c2 = classify(text, pdf.name);
                // A classificação da VISÃO tem precedência: ela viu a página, e o
                // `classify` lê texto que a própria IA produziu. Só entra se a visão
                // não classificou.
                if (c2.tipo !== 'Não identificado' && c.tipo === 'Não identificado') c = c2;
                if (t.falhas) console.warn(`[process-folder] transcrição de ${pdf.name}: ` +
                    `${t.falhas}/${t.nPaginas} página(s) não transcritas`);
            } else if (t.erro) {
                console.warn(`[process-folder] transcrição falhou em ${pdf.name}: ${t.erro}`);
            }
        } catch (e) {
            console.warn(`[process-folder] transcrição falhou em ${pdf.name}: ${e.message}`);
        }
    }

    // OCR: continua valendo como RESERVA quando a visão e a transcrição não
    // resolveram, e como caminho principal para o PDF que tem texto mas não foi
    // classificado.
    if ((isImage || c.tipo === 'Não identificado') && !ocrUsed && !visaoUsada && !transcricaoUsada) {
        try {
            const ocrText = await ocrViaBackend(buffer);
            const c2 = classify(ocrText, pdf.name);
            if (c2.tipo !== 'Não identificado') { text = ocrText; ocrUsed = true; c = c2; }
            else if (isImage) { text = ocrText || text; ocrUsed = true; }
        } catch (e) {
            console.warn(`[process-folder] OCR falhou em ${pdf.name}: ${e.message}`);
            // O PDF é imagem e o OCR não está disponível: não há UM CARACTERE
            // para analisar. Seguir daqui produz uma row "Não identificado" com
            // `dados_parser` vazio que, numa releitura (`forceLocal` regrava tudo),
            // SOBRESCREVE o que uma leitura anterior bem-sucedida havia extraído.
            //
            // MEDIDO em 10/09/2026: o serviço de OCR caiu no meio da releitura de
            // 03.2026 e 45 documentos entraram nesse estado em poucos minutos —
            // entre eles notas de R$ 29.655, R$ 25.333 e R$ 100.000. O log final
            // teria dito "processados N, 0 erros": perda silenciosa.
            //
            // Recusar é a única resposta segura. Quem chama trata como erro do
            // arquivo e mantém o que já estava gravado.
            // Se a VISÃO ou a TRANSCRIÇÃO já leram o documento, o OCR fora do ar não
            // é impeditivo — há conteúdo para gravar. A recusa vale só quando nada
            // leu o papel.
            if (isImage && !visaoUsada && !transcricaoUsada && e instanceof ErroOcrIndisponivel) {
                throw new ErroOcrIndisponivel(
                    `${pdf.name}: PDF é imagem e o OCR está indisponível (${e.message})`);
            }
        }
    }

    if (c.tipo !== 'CTE' && c.origem !== 'conteúdo' && !ocrUsed
        && TRANSPORT_HINT_RE.test(norm(text))) {
        try {
            const ocrText = await ocrViaBackend(buffer);
            if (CTE_STRONG_RE.test(norm(ocrText))) {
                text = text + '\n' + ocrText; ocrUsed = true;
                c = mk('CTE', 'DACTE confirmado', 'OCR');
            }
        } catch (_) {}
    }

    // Vale para todo tipo, não só NF/CTE: RECIBO e FATURA com DANFE anexa também têm chave.
    let parserData = enriquecerComBoleto(enriquecerComChaveAcesso(c.parser ? c.parser(text) : null, text), text);

    // Campos fiscais detalhados (nome, nome social, CNPJ, chave, CFOP, itens com
    // unidade e valor unitário, valor total). Roda em TODO documento, não só nos
    // classificados como NF: medido em 09/09/2026, uma FATURA ou RECIBO com DANFE
    // anexa carrega os mesmos campos, e é justamente o caso que o parser de tipo
    // não olha. O extrator devolve vazio quando o documento não os tem, então não
    // há custo em tentar.
    //
    // `Object.assign` na ORDEM abaixo é deliberado: o que o parser específico do
    // tipo já produziu tem precedência, porque foi escrito contra o layout daquele
    // documento. O extrator preenche as lacunas e acrescenta os campos novos.
    try {
        const novos = camposParaDadosParser(extrairNotaFiscal(text));
        if (Object.keys(novos).length) {
            // O parser de tipo vence — mas só onde ele ACHOU algo. Os parsers
            // gravam '—' no campo que não encontraram, e um travessão com
            // precedência APAGA o valor bom que o extrator trouxe.
            //
            // MEDIDO em 10/09/2026: as notas da ARPSEG perderam o `Emitente`
            // ("ARPSEG LTDA - ARPSEG GESTAO E CONSULTORIA" virou o "ARPESEG" do
            // nome do arquivo) porque `parseNfse` não devolve emitente e o vazio
            // dele venceu. Três lançamentos perderam o par que tinham. Ver §15.16.
            const util = {};
            for (const [k, v] of Object.entries(parserData || {})) {
                const s = typeof v === 'string' ? v.trim() : v;
                if (s !== '' && s !== '—' && s != null) util[k] = v;
            }
            parserData = { ...novos, ...util };
        }
    } catch (e) {
        console.warn(`[process-folder] extração fiscal falhou em ${pdf.name}: ${e.message}`);
    }

    // Campos lidos da IMAGEM pela visão. Entram por ÚLTIMO com precedência menor
    // (`{ ...visao, ...parserData }`), pela mesma razão que rege o resto do
    // pipeline: o que foi extraído do TEXTO do documento vence, e a visão preenche
    // o que ficou vazio.
    //
    // ── A TRANSCRIÇÃO QUEBROU UMA PREMISSA DESTE MERGE ───────────────────────
    // O comentário original dizia "num PDF-imagem o texto não existe, então na
    // prática a visão preenche tudo". Desde 11/09/2026 isso é FALSO: a transcrição
    // dá texto ao parser, o parser produz `Valor total`, e esse valor sobrescreve o
    // da visão SEM passar pelo gabarito do nome do arquivo.
    //
    // MEDIDO no scan de 11/09 (`_medir/_auditar-pos-scan.js`, invariante TRAVA): 2
    // linhas ficaram com `Valor lido (não confere com o nome)` E `Valor total` ao
    // mesmo tempo — estado contraditório que a trava da visão existe para impedir.
    // Num deles o parser gravou "0,00" como Valor total; no outro, 1.450,53 onde o
    // nome diz 1.459,72, e a visão já havia marcado a leitura como não-confiável.
    //
    // Regra: quando a VISÃO julgou o valor não-confiável, o valor do parser sobre
    // texto TRANSCRITO não pode entrar como `Valor total` — a transcrição é leitura
    // da mesma imagem que a visão já disse não conferir, logo não é fonte
    // independente. O valor do parser vai para um campo próprio, rotulado, e a
    // conferência humana decide. Ver [[transcrever-nao-e-extrair]].
    if (camposVisao && Object.keys(camposVisao).length) {
        const visaoDuvidou = !!camposVisao['Valor lido (não confere com o nome)'];
        if (visaoDuvidou && transcricaoUsada && parserData) {
            const doParser = parserData['Valor total'] || parserData['Valor total da nota'];
            if (doParser) {
                parserData = { ...parserData };
                delete parserData['Valor total'];
                delete parserData['Valor total da nota'];
                parserData['Valor lido do texto transcrito'] = doParser;
            }
        }
        parserData = { ...camposVisao, ...(parserData || {}) };
    }

    if (parserData && !Object.keys(parserData).length) parserData = null;
    let cnpjRaw = parserData ? (parserData['CNPJ emitente'] || parserData['CNPJ / CPF'] || '') : '';
    if (!cnpjRaw || cnpjRaw === '—') cnpjRaw = extrairCnpj(text);

    // EMITENTE — aqui a regra "extrator primeiro" NÃO se aplica, e a exceção foi
    // medida (09/09/2026, `_medir/_pipeline-nf.js` sobre 250 PDFs).
    //
    // A regra do projeto vale para número e valor, que descrevem a NOTA. O emitente
    // é diferente: o campo responde "qual a contraparte do LANÇAMENTO", e num PDF
    // que junta contrato + DANFE anexa essas são entidades distintas. O extrator
    // leria GENERAL MOTORS num contrato Daycoval — nome perfeitamente válido, e
    // errado para o pareamento.
    //
    // Sem esta precedência, 60 dos 250 documentos teriam o `Emitente` trocado: por
    // rótulo ("DO DOCUMENTO", em 5 MULTIPLIKE), pelo próprio pagador ("LARSIL
    // FLORESTAL"), ou pela entidade errada. Como o comparador casa por ESTE campo,
    // seria regressão direta no pareamento.
    //
    // Então: o nome do arquivo manda no campo que o comparador lê, e a razão social
    // lida da nota entra em campo PRÓPRIO. Nada se perde — `_pareamento.js:364` une
    // os tokens das duas fontes em vez de substituir, então a razão social completa
    // ainda ajuda a casar; ela só não pode expulsar o nome que já funciona.
    const emitenteNome = extrairEmitente(pdf.name);
    if (emitenteNome) {
        parserData = parserData || {};
        const lido = parserData['Emitente'];
        if (lido && norm(lido) !== norm(emitenteNome)) parserData['Razão social (nota)'] = lido;
        parserData['Emitente'] = emitenteNome;
    }

    // QUAL valor é o que se paga — mesma decisão do caminho de IA, ver
    // `_valor-do-pagamento.js`. Aqui ela importa ainda mais: este caminho não tem a IA
    // para desempatar, e é o que lia `Valor total da nota` em pacote "+ BOL".
    //
    // Não roda quando a visão marcou o valor como não-confiável: ali a TRAVA acima já
    // decidiu tirar o número da coluna principal de propósito, e sobrepor essa decisão
    // reintroduziria o bug que a trava existe para impedir.
    if (parserData && !parserData['Valor lido (não confere com o nome)']) {
        parserData = decidirValorPago(parserData, {
            text,
            numeroDoNome: numeroDoNomeArquivo(pdf.name),
        });
    }

    const baseRow = {
        arquivo:      pdf.name,
        pasta:        pdf.folder || '',
        paginas:      String(pages),
        // A procedência do texto fica VISÍVEL na coluna: quem confere precisa saber
        // se o dado veio do papel, do OCR ou de transcrição por IA. Sem distinguir,
        // "Imagem (OCR)" cobriria as três e a conferência perderia a pista.
        conteudo:     isImage
            ? `Imagem${transcricaoUsada ? ' (transcrição IA)' : ocrUsed ? ' (OCR)' : ''}`
            : 'Texto',
        tipo:         c.tipo,
        evidencia:    c.evidencia,
        origem:       c.origem,
        // `ocr_usado` significa "o texto NÃO é nativo" para o resto do sistema
        // (cache, releitura, telas). Transcrição também não é nativa, então conta.
        ocr_usado:    String(ocrUsed || transcricaoUsada),
        dados_parser: JSON.stringify(parserData),
        cnpj:         cnpjRaw && cnpjRaw !== '—' ? cnpjRaw : '',
    };

    // Multi-boleto: pré-filtro barato gateia a IA; a IA confirma quantos boletos
    // DISTINTOS existem. Só divide quando a IA retorna ≥2. Qualquer falha → 1 row.
    if (pareceMultiBoleto(text, pages)) {
        try {
            const { boletos, error } = await extrairBoletosAI({ text, filename: pdf.name });
            if (error) console.warn(`[process-folder] IA boletos falhou em ${pdf.name}: ${error}`);
            if (boletos.length > 1) {
                console.log(`[process-folder] carnê confirmado pela IA em ${pdf.name}: ${boletos.length} parcelas`);
                return boletos.map((b, i) => {
                    const pd = {
                        ...(parserData || {}),
                        'Data de vencimento': b.vencimento,
                        'Valor total':        b.valor > 0 ? String(b.valor).replace('.', ',') : (parserData?.['Valor total'] || ''),
                        'Nosso Número':       b.nossoNumero || '',
                        'Parcela':            `${i + 1}/${boletos.length}`,
                        'arquivo_original':   pdf.name,
                    };
                    return { ...baseRow, arquivo: `${pdf.name}#p${i + 1}`, dados_parser: JSON.stringify(pd) };
                });
            }
        } catch (e) {
            console.warn(`[process-folder] erro IA boletos em ${pdf.name}: ${e.message}`);
        }
    }

    return [baseRow];
}

// ── Match empresa-conta ───────────────────────────────────────────────────────
function normEmpresa(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cnpjDigitos(s) {
    return (s || '').replace(/\D/g, '');
}

/** Retorna o ID da empresa que bate com a row, ou null */
function matchEmpresa(row, empresas) {
    const cnpjRow = cnpjDigitos(row.cnpj);
    const dadosParser = (() => { try { return JSON.parse(row.dados_parser); } catch (_) { return null; } })();
    const emitente = normEmpresa(dadosParser?.emitente?.nome || dadosParser?.['Emitente'] || '');
    const nomeArquivo = normEmpresa(row.arquivo || '');

    for (const emp of empresas) {
        // 1) CNPJ é o critério forte (preciso)
        if (cnpjRow && cnpjDigitos(emp.CNPJ) === cnpjRow) return emp.ID;
        if (!emp.NOME) continue;
        const nomeEmp = normEmpresa(emp.NOME);
        if (!nomeEmp) continue;
        // 2) nome do emitente no parser
        if (emitente && emitente === nomeEmp) return emp.ID;
        // 3) nome da empresa aparece no nome do arquivo (ex.: "...SANTANDER...")
        if (nomeArquivo.includes(nomeEmp)) return emp.ID;
    }
    return null;
}

// ── Upsert do relatório (espelha o MERGE de routes/relatorio.js) ──────────────
async function upsertRelatorio(pool, tipo, periodo, novasRows) {
    // Carrega existente para upsert por (arquivo + pasta) — preserva entradas antigas
    const existing = await pool.request()
        .input('tipo',    sql.Char(1),     tipo)
        .input('periodo', sql.VarChar(20), periodo)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO = @periodo');

    let finalRows = novasRows;
    if (existing.recordset.length) {
        const map = new Map(csvToRows(existing.recordset[0].CONTEUDO).map(r => [`${r.arquivo}|${r.pasta}`, r]));

        // ── Parcelas: o PDF inteiro é reescrito, nunca mesclado ──────────────
        // O upsert é por `arquivo|pasta`, e a parcela leva o sufixo #pN no nome.
        // Quando uma releitura detecta MENOS parcelas que a anterior (a IA disse 6
        // numa rodada e 3 noutra), as sobras #p4..#p6 da rodada antiga ficavam para
        // sempre: nada as apagava, porque a chave delas não aparece entre as novas.
        //
        // Medido em 09/09/2026 (`_medir/_carne-detalhe.js`): a NF 218459 da
        // MAQNELSON tinha 6 boletos distintos ocupando 38 LINHAS, com "#p1 1/3" e
        // "#p1 1/6" convivendo no banco — leituras de execuções diferentes. No total,
        // 682 PDFs desmembrados respondiam por 58,7% das linhas do banco.
        //
        // A correção é tratar o conjunto de parcelas como um bloco: ao gravar
        // qualquer linha de um PDF, some TODAS as linhas antigas daquele PDF (a de
        // boleto único e as #pN) antes de inserir as novas. Assim o que fica é
        // exatamente o que a leitura atual encontrou.
        const pdfsTocados = new Set();
        for (const row of novasRows) {
            const base = String(row.arquivo).replace(/#p\d+$/i, '');
            pdfsTocados.add(`${base}|${row.pasta}`);
        }
        for (const k of [...map.keys()]) {
            const i = k.lastIndexOf('|');
            const arq = k.slice(0, i), pasta = k.slice(i + 1);
            const base = arq.replace(/#p\d+$/i, '');
            if (pdfsTocados.has(`${base}|${pasta}`)) map.delete(k);
        }

        // ── Pasta renomeada: a linha velha some, não fica ao lado ─────────────
        // A chave inclui a pasta, então renomear a raiz do acervo fazia a releitura
        // INSERIR em vez de atualizar: o mesmo PDF passava a ter duas linhas, com
        // leituras de épocas diferentes, e o pareamento casava com qualquer uma.
        //
        // Medido em 09/09/2026 (`_medir/_orfas.js`): 1.606 PDFs em 12.541 linhas
        // estavam assim, depois de "SANTANDER/…" virar "2026.03.EXTRATOS
        // CONTABILIDADE/SANTANDER/…". O acervo foi consertado por
        // `_medir/fundir-orfas.js`; isto impede que volte a acontecer.
        //
        // A identidade usada é só o NOME do arquivo, sem a pasta. É seguro porque o
        // nome já carrega número sequencial, valor e data ("070.DOC- 72,57 -
        // 2026.03.10. DALIANI…"), o que o torna único no acervo na prática. Para não
        // apagar por engano quando não for, a remoção só ocorre se houver EXATAMENTE
        // uma linha antiga com aquele nome — havendo mais de uma, a ambiguidade é
        // real e as linhas ficam para inspeção manual.
        const antigasPorNome = new Map();
        for (const k of map.keys()) {
            const i = k.lastIndexOf('|');
            const nome = k.slice(0, i);
            if (!antigasPorNome.has(nome)) antigasPorNome.set(nome, []);
            antigasPorNome.get(nome).push(k);
        }
        for (const row of novasRows) {
            const iguais = antigasPorNome.get(String(row.arquivo));
            if (!iguais || iguais.length !== 1) continue;
            const k = iguais[0];
            if (k !== `${row.arquivo}|${row.pasta}`) map.delete(k);
        }
        for (const row of novasRows) map.set(`${row.arquivo}|${row.pasta}`, row);
        finalRows = Array.from(map.values());
    }

    const csvContent = rowsToCsv(finalRows);
    await pool.request()
        .input('tipo',     sql.Char(1),           tipo)
        .input('periodo',  sql.VarChar(20),       periodo)
        .input('conteudo', sql.NVarChar(sql.MAX), csvContent)
        .input('total',    sql.Int,               finalRows.length)
        .query(`
            MERGE nfs.RELATORIOS_CONFERENCIA WITH (HOLDLOCK) AS tgt
            USING (SELECT @tipo AS TIPO, @periodo AS PERIODO) AS src
               ON tgt.TIPO = src.TIPO AND tgt.PERIODO = src.PERIODO
            WHEN MATCHED THEN
                UPDATE SET CONTEUDO = @conteudo, TOTAL_ARQUIVOS = @total, ATUALIZADO_EM = GETDATE()
            WHEN NOT MATCHED THEN
                INSERT (TIPO, PERIODO, CONTEUDO, TOTAL_ARQUIVOS)
                VALUES (@tipo, @periodo, @conteudo, @total);
        `);
}

/**
 * Processa uma pasta inteira de PDFs.
 * @param {string} folderPath
 * @param {function} [onProgress]  callback({ current, total, percent, filename })
 * @param {function} [isPaused]    retorna true quando pausado
 * @param {function} [isStopped]   retorna true quando deve parar
 */
async function processFolderAuto(folderPath, onProgress, isPaused, isStopped, opts = {}) {
    // `forceAITudo` IMPLICA `forceAI`: a leitura por IA em `analyzePdf` é decidida por
    // `opts.forceAI`, então sem esta implicação quem passasse só `forceAITudo` releria
    // tudo com os PARSERS LOCAIS — o oposto da intenção, e sem erro visível.
    const forceAI = !!opts.forceAI || !!opts.forceAITudo;
    // opts.forceLocal → relê os PDFs com os PARSERS LOCAIS, ignorando o cache.
    //
    // Existe porque o cache é por `arquivo|pasta` e reaproveita a row inteira: quando
    // a lógica de EXTRAÇÃO muda (campos fiscais novos em 09/09/2026), um scan comum
    // devolve os dados velhos para sempre — o arquivo no disco não mudou, então nada
    // é reprocessado. Diferente de forceAI, não chama IA nenhuma: relê o texto do PDF
    // e roda os parsers, então o custo é tempo de CPU, não tokens.
    const forceLocal = !!opts.forceLocal;

    // opts.forceAITudo → relê pela IA TUDO, inclusive o que JÁ tem origem "IA".
    //
    // `forceAI` sozinho reaproveita do cache a row que já foi lida por IA, e isso está
    // certo no uso normal: evita pagar de novo pelo que a IA já leu. Mas quando o
    // defeito está NA LEITURA DA PRÓPRIA IA, ele torna a releitura inócua — o cache
    // protege exatamente as linhas que precisam ser substituídas.
    //
    // MOTIVO CONCRETO (14/09/2026): em 03.2026 há 149 rows de origem "IA" gravadas
    // pelo `parseNfse` com o bug de §15.16 (número sob a chave 'Nº da NFS-e', que
    // CHAVES_NUMERO não lia, e campo '—' sobrescrevendo emitente bom). Um
    // `forceAI` comum pularia as 149 e consertaria só as de parser local, deixando de
    // pé justamente o dano que motivou a releitura.
    //
    // É a mesma lição que `forceLocal` já aprendeu (ver o comentário de `precisaReler`
    // abaixo): preservar a row de IA "para não perder informação" fez 33 de 7.160
    // linhas ganharem os campos novos. A informação não se perde — `analyzePdf` a relê
    // do mesmo PDF.
    //
    // Custo: paga a IA por todos os arquivos do escopo, sem reaproveitamento. Por isso
    // é opção explícita e não o padrão do botão "Ler pasta".
    const forceAITudo = !!opts.forceAITudo;
    try {
        await fs.access(folderPath);

        const pdfs = await collectPdfs(folderPath);
        console.log(`[process-folder] coletado ${pdfs.length} PDF(s) de ${folderPath}` +
            (pdfs.ignorados ? ` (${pdfs.ignorados} CPV/extrato ignorados)` : ''));

        if (pdfs.length === 0) {
            return { success: true, processed: 0, unchanged: 0, errors: 0, message: 'Nenhum PDF encontrado.' };
        }

        const pool = await getConnection();

        // Carrega empresas-conta para match tipo C
        let empresas = [];
        try {
            const empResult = await pool.request()
                .query('SELECT ID, NOME, CNPJ FROM nfs.EMPRESAS_CONTAS');
            empresas = empResult.recordset;
        } catch (e) {
            console.warn('[process-folder] não foi possível carregar EMPRESAS_CONTAS:', e.message);
        }

        // Cada PDF → dia (DD.MM.YYYY) e mês (MM.YYYY) conforme a DATA do documento:
        // 1º a data embutida no nome do arquivo, 2º a subpasta. Arquivos sem data
        // caem no mês predominante do lote (dia 01); se o lote inteiro for sem data,
        // em hoje. Os sem data são registrados em log de aviso.
        const semData = [];
        let consertados = 0;
        for (const pdf of pdfs) {
            const dNome = filenameToDay(pdf.name);
            const dPasta = folderToDay(pdf.folder);
            // O nome continua tendo precedência (é a data do DOCUMENTO, e a pasta é
            // a de arquivamento), mas passa pelo conserto quando a subpasta prova
            // que houve erro de digitação — ver consertarDataPelaPasta.
            const d = dNome ? consertarDataPelaPasta(dNome, dPasta) : dPasta;
            if (d) {
                if (dNome && d !== dNome) {
                    consertados++;
                    console.warn(`[process-folder] data corrigida pela subpasta: ` +
                        `"${pdf.name}" ${dNome} → ${d}`);
                }
                pdf.day = d;
            }
            else { semData.push(pdf); }
        }
        if (consertados) console.log(`[process-folder] ${consertados} data(s) corrigida(s) pela subpasta`);

        // Mês predominante entre os arquivos datados
        const monthCount = new Map();
        for (const pdf of pdfs) {
            if (!pdf.day) continue;
            const mon = pdf.day.slice(3);
            monthCount.set(mon, (monthCount.get(mon) || 0) + 1);
        }
        const fallbackDay = monthCount.size
            ? `01.${[...monthCount.entries()].sort((a, b) => b[1] - a[1])[0][0]}`
            : todayStr();

        for (const pdf of semData) pdf.day = fallbackDay;
        if (semData.length) {
            console.warn(`[process-folder] ⚠ ${semData.length} arquivo(s) sem data no nome → arquivado(s) em ${fallbackDay}: ${semData.map(p => p.name).join(', ')}`);
        }

        for (const pdf of pdfs) pdf.month = pdf.day.slice(3);

        // ── Cache em dois níveis ──────────────────────────────────────────────
        // 1) cacheMensal: já existe no relatório M do mês → resultado pronto, não toca.
        // 2) cacheGlobal: dados (row) já extraídos em QUALQUER relatório (D/M/C de
        //    qualquer período) → reaproveita sem reler o PDF nem chamar OCR.
        //    Assim, apagar um relatório D/M apenas reconstrói o CSV; só relê do disco
        //    arquivos que nunca foram processados em lugar nenhum.
        const cacheMensal = new Set();          // "arquivo|pasta" presentes no M do mês
        const cacheGlobal = new Map();          // "arquivo|pasta" → row já extraída
        const meses = new Set(pdfs.map(p => p.month));

        try {
            const todos = await pool.request()
                .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');
            for (const rec of todos.recordset) {
                for (const row of csvToRows(rec.CONTEUDO)) {
                    const chave = `${row.arquivo}|${row.pasta}`;
                    if (!cacheGlobal.has(chave) || (row.dados_parser && row.dados_parser !== 'null')) {
                        cacheGlobal.set(chave, row);
                    }
                    if (rec.TIPO === 'M' && meses.has(rec.PERIODO)) {
                        cacheMensal.add(chave);
                    }
                }
            }
        } catch (e) {
            console.warn(`[process-folder] erro ao carregar cache: ${e.message}`);
        }
        console.log(`[process-folder] cache: ${cacheMensal.size} no mês, ${cacheGlobal.size} global`);

        // No modo forceAI, uma row só é reaproveitável se JÁ foi lida por IA (origem
        // "IA"). Rows de parser local precisam ser relidas pela IA para serem substituídas.
        const ehIA     = (chave) => { const r = cacheGlobal.get(chave); return !!(r && /\bIA\b/i.test(r.origem || '')); };

        // Precisa reler o PDF do disco (em vez de aproveitar a row do cache)?
        //
        // forceAI:    tudo que ainda não foi lido por IA.
        // forceLocal: TUDO — inclusive o que já é IA. A primeira versão excluía as
        //   rows de IA para "não perder informação", e o resultado medido foi que só
        //   33 de 7.160 linhas ganharam os campos novos: as 499 já lidas por IA nunca
        //   entravam em `pendentes`. Como a IA atual não extrai CFOP nem unidade dos
        //   itens para `dados_parser`, preservá-las era preservar justamente as
        //   lacunas que o reprocessamento existe para fechar. A informação da IA não
        //   se perde: `analyzePdf` a relê do mesmo PDF.
        // forceAITudo: ignora `ehIA` — a row de IA também é relida. Ver o comentário
        // da opção no topo desta função (o cache protegia justamente as linhas ruins).
        const precisaReler = (chave) => (forceAI && !ehIA(chave)) || forceLocal || forceAITudo;

        // "Pendentes" = não estão no M do mês (precisam entrar no relatório), OU — nos
        // modos forceAI/forceLocal — já estão mas precisam ser relidos. Destes, alguns
        // serão reaproveitados do cache global; só os de fato inéditos passam pelo
        // analyzePdf (que no forceLocal roda os parsers locais, sem IA).
        const pendentes = pdfs.filter(p => {
            const chave = `${p.name}|${p.folder}`;
            return !cacheMensal.has(chave) || precisaReler(chave);
        });
        const unchanged = pdfs.length - pendentes.length;

        if (pendentes.length === 0) {
            return {
                success: true, processed: 0, unchanged, errors: 0,
                message: 'Nenhuma alteração nas notas!', noChanges: true,
            };
        }

        const ineditos = pendentes.filter(p => {
            const chave = `${p.name}|${p.folder}`;
            return !cacheGlobal.has(chave) || precisaReler(chave);
        });
        const reaproveitados = pendentes.length - ineditos.length;
        console.log(`[process-folder] ${pendentes.length} pendente(s): ${reaproveitados} reaproveitado(s) do cache, ${ineditos.length} a reler do disco`);

        // Acumula as rows (sejam reaproveitadas do cache ou recém-extraídas)
        let errors = 0;
        const rowsPorMes   = new Map(); // MM.YYYY → [row]
        const rowsPorDia   = new Map(); // DD.MM.YYYY → [row]
        const rowsPorConta = new Map(); // "empId|MM.YYYY" → [row]

        const acumular = (pdf, row) => {
            // Parcela de carnê: arquiva no mês/dia do SEU vencimento (não no do arquivo),
            // para que a parcela de cada mês caia no relatório do mês correspondente.
            let day = pdf.day, month = pdf.month;
            const pv = parcelaVenc(row);
            if (pv) { const d = vencToDay(pv); if (d) { day = d; month = d.slice(3); } }

            if (!rowsPorMes.has(month)) rowsPorMes.set(month, []);
            rowsPorMes.get(month).push(row);

            if (!rowsPorDia.has(day)) rowsPorDia.set(day, []);
            rowsPorDia.get(day).push(row);

            if (empresas.length) {
                const empId = matchEmpresa(row, empresas);
                if (empId !== null) {
                    const chaveC = `${empId}|${month}`;
                    if (!rowsPorConta.has(chaveC)) rowsPorConta.set(chaveC, []);
                    rowsPorConta.get(chaveC).push(row);
                }
            }
        };

        // 1) Reaproveita do cache global — instantâneo, sem reler PDF. No modo forceAI,
        //    pula os que ainda não são "IA" (serão relidos pela IA no passo 2).
        for (const pdf of pendentes) {
            const chave = `${pdf.name}|${pdf.folder}`;
            if (precisaReler(chave)) continue;
            const cached = cacheGlobal.get(chave);
            if (cached) acumular(pdf, cached);
        }

        // 2) Relê do disco apenas os inéditos (extração + OCR) — passo caro, com progresso
        let stopped = false;
        // Conta falhas CONSECUTIVAS de OCR indisponível; zera a cada sucesso. Ver o
        // disjuntor no catch abaixo.
        let falhasOcrSeguidas = 0;
        for (let i = 0; i < ineditos.length; i++) {
            if (isPaused) {
                while (isPaused() && !(isStopped && isStopped())) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            if (isStopped && isStopped()) { stopped = true; break; }

            const pdf = ineditos[i];
            const current = i + 1;
            const percent = Math.round((current / ineditos.length) * 100);
            if (onProgress) onProgress({ current, total: ineditos.length, percent, filename: pdf.name });

            try {
                const rows = await analyzePdf(pdf, { forceAI }); // agora retorna array
                for (const row of rows) acumular(pdf, row);
                falhasOcrSeguidas = 0;
            } catch (e) {
                errors++;
                console.error(`[process-folder] erro ao processar ${pdf.name}: ${e.message}`);

                // ── Disjuntor: o OCR caiu, pare antes de gravar ──────────────
                // Um erro isolado é do arquivo. Vários seguidos de OCR
                // indisponível são do SERVIÇO, e aí continuar é perigoso: os
                // relatórios são regravados no fim com o que sobrou, então uma
                // rodada que perdeu centenas de documentos-imagem por falta de
                // OCR os APAGA do relatório mensal.
                //
                // MEDIDO em 10/09/2026: o PaddleOCR morreu por falta de memória
                // no meio da releitura de 03.2026 e acumulou 45 falhas em poucos
                // minutos. Sem este corte, a gravação final teria removido do
                // relatório todo documento-imagem daquela pasta.
                if (e instanceof ErroOcrIndisponivel) {
                    if (++falhasOcrSeguidas >= MAX_FALHAS_OCR) {
                        throw new Error(
                            `OCR indisponível: ${falhasOcrSeguidas} falhas seguidas ` +
                            `(última em ${pdf.name}). Processamento abortado ANTES de gravar, ` +
                            `para não remover dos relatórios os documentos que dependem de OCR. ` +
                            `Verifique o servidor em ${OCR_URL} e rode de novo.`);
                    }
                } else {
                    falhasOcrSeguidas = 0;
                }
            }
        }

        // Salva relatórios mensais (M), diários (D) e por conta (C)
        for (const [mes, rows] of rowsPorMes)   await upsertRelatorio(pool, 'M', mes, rows);
        for (const [dia, rows] of rowsPorDia)   await upsertRelatorio(pool, 'D', dia, rows);
        for (const [chave, rows] of rowsPorConta) {
            const [empId, mes] = chave.split('|');
            await upsertRelatorio(pool, 'C', `${empId}-${mes}`, rows);
        }

        const processed = Array.from(rowsPorMes.values()).reduce((s, r) => s + r.length, 0);

        if (stopped) {
            return {
                success: true, stopped: true,
                processed, unchanged, errors,
                message: `Leitura interrompida. ${processed} arquivo(s) salvos.`,
            };
        }

        const detalhe = reaproveitados > 0
            ? ` (${ineditos.length - errors} lido(s) do disco, ${reaproveitados} reaproveitado(s) do cache)`
            : '';
        const avisoSemData = semData.length
            ? ` ⚠ ${semData.length} sem data no nome → ${fallbackDay}`
            : '';
        return {
            success: true,
            processed,
            unchanged,
            errors,
            reaproveitados,
            relidos: ineditos.length - errors,
            semData: semData.map(p => p.name),
            fallbackDay,
            message: `Processados ${processed} arquivo(s)${detalhe}${errors ? `, ${errors} com erro` : ''}, ${unchanged} sem alterações.${avisoSemData}`,
        };

    } catch (e) {
        console.error('[process-folder] erro:', e.message);
        return { success: false, processed: 0, unchanged: 0, errors: 1, message: e.message };
    }
}

module.exports = {
    processFolderAuto, collectPdfs,
    // reaproveitados pela rota scan-empresas
    matchEmpresa, upsertRelatorio, csvToRows, rowsToCsv, parseCsvLine, COLS,
    // `analyzePdf` lê UM PDF e devolve as rows dele. Exportada em 11/09/2026 para
    // permitir reprocessar arquivos específicos (`_medir/_reprocessar-arquivos.js`)
    // em vez da pasta inteira: consertar 2 linhas custava 933 arquivos e 34 minutos.
    // Quem chamar precisa gravar com `upsertRelatorio`, que faz merge por
    // `arquivo|pasta` e preserva o que não vier no lote.
    analyzePdf,
};
