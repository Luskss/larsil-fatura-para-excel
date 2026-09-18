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
const RE_CPV = /^\s*\d+\s*[.\-]\s*CPV\b/i;
const RE_PDF_NUMERICO = /^\s*\d+\s*\.pdf$/i;
const ehPdfIgnoradoNaLista = nome => RE_CPV.test(String(nome || ''))
    || RE_PDF_NUMERICO.test(String(nome || ''));

// Chave para os PDFs cujo mês não se descobre (nem no nome, nem na pasta). Não é um
// período válido, e por isso não colide com nenhum "MM.AAAA".
const SEM_DATA = 'sem-data';

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

// ── Repescagem: o documento cortado que PROVA ser o pagamento ────────────────
// `categoriaNaoFiscal` decide pelo NOME, sozinho, antes de existir lançamento algum.
// Isso é certo para consórcio e financiamento, e erra para PIX e guia: a planilha lança
// `DETRAN PR` como fornecedor, e o comprovante do DETRAN é o documento daquele
// lançamento — cortá-lo deixa o lançamento órfão no painel.
//
// Medido regra a regra em 18/09/2026 (jan–jun, varredura bruta de 6.606 documentos):
// **15 dos 21 padrões custam ZERO pares** e ficam como estão. O custo estava em 6, e o
// julgamento caso a caso separou par legítimo de colisão:
//
//   padrão                          corta  casaria  legítimo
//   PIX enviado/recebido               71       36     24
//   Taxa de governo (DETRAN)           51       29     21   ← 29 de 29 do mesmo fornecedor
//   Guia de governo (RCB 9039xx)      136        7      7
//   Compensação de cheque              28       14      4
//   Guia de tributo (GOVERNO/IPVA)    382        4      2
//   Folha/RH (pgto ...)                99        5      1
//
// A regra que separa NÃO é a categoria — é exigir os DOIS sinais fortes contra um
// lançamento real: mesmo fornecedor (token em comum) E mesmo valor. Desligar um padrão
// inteiro reprova: sem o PIX entram 11 pares falsos junto com os 24 bons, e sem o CHEQUE
// entra o `TRACADO EQUIP. R$ 22.456,93 × JONAS BONFIM CHEQUE`, colisão de valor redondo
// que se repete nos 6 meses.
//
// Efeito medido com o motor real: **+73 pares, 0 perdas**, 78,2% → 79,8% de pares que
// conferem pelo fornecedor. As 26 trocas são todas melhora — o comprovante legítimo
// tomando o lugar de um par falso (`PATRICIA LIMA` sai de `KATRINY PEREIRA` e vai para
// `PIX ENVIADO PATRICIA LIMA`).
//
// O corte continua valendo para a CONTAGEM da pasta: estes documentos não são nota
// fiscal e não entram em `porMes`. A repescagem é só para o PAREAMENTO, onde a pergunta
// é outra — "este lançamento tem papel?", não "este papel é nota fiscal?".
function admiteNoPareamento(doc, lancamentos) {
    const vDoc = doc.valorAlt != null ? doc.valorAlt : doc.valor;
    if (vDoc == null) return false;               // sem valor não há segundo sinal
    const tks = pareamento.tokens(doc.arquivo);
    for (const l of lancamentos) {
        if (Math.abs(Math.abs(l.valor || 0) - Math.abs(vDoc)) >= TOL_VALOR_REPESCAGEM) continue;
        for (const t of pareamento.tokens(l.entidade)) if (tks.has(t)) return true;
    }
    return false;
}
// Mesma tolerância de centavos que o pareamento usa para dizer "é o mesmo valor".
const TOL_VALOR_REPESCAGEM = 0.02;

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
// O mês de um PDF sai da SUBPASTA primeiro, do nome do arquivo só como fallback
// (`mesDoDocumento`). A ordem era a inversa — o nome ganhava, como em
// process-folder.js — e foi trocada em 03/09/2026 (§15) depois que a auditoria de
// 02/2026 achou o documento
//
//   .../2026.02.../SANTANDER/2026.02.09/045.DOC- 1824,00-2026.09.02.ARPSEG ...
//
// arquivado em fevereiro, indexado em SETEMBRO por causa do dia/mês trocado no
// nome digitado à mão. Medido: 144 dos 4.238 arquivos têm nome e pasta
// discordando, 37 deles a mais de 3 meses — fora de qualquer janela.
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

// A pasta é criada pelo processo de arquivamento; o nome é digitado à mão — a
// mesma fonte de erro que §12 mediu no emitente. Quando discordam, a pasta vale.
// Medido em jan–jun/2026: +5 pares (2.026 → 2.031) com a confirmação por 2º campo
// inalterada em 91,3%.
function mesDoDocumento(nome, rel) {
    return mesDaPasta(rel) || mesDoNome(nome);
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
    // "MM.AAAA" → [{ nome, rel, bytes, mtime, classe, categoria }] de TODO PDF do mês,
    // inclusive os que as contagens acima descartam. É o que a seção "PDFs na pasta"
    // mostra: ali a pergunta não é "quantas notas há?" mas "o que existe no disco?", e
    // para essa pergunta o CPV e o extrato do dia são resposta, não ruído. Sai desta
    // mesma varredura porque uma segunda seria a operação mais cara da rota.
    // Os sem data ficam sob a chave SEM_DATA — não têm mês a que pertencer, e omiti-los
    // faria a seção contradizer o rodapé, que os conta.
    const todosPorMes = {};
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

            const mes = mesDoDocumento(e.name, rel);
            // Tamanho e data NÃO são lidos aqui. Um `statSync` por PDF custa caro no
            // compartilhamento de rede — medido em 09/09/2026: a varredura dos 15.908
            // arquivos passa de 5,0 s para 12,7 s a frio. E seria cobrado de todo mundo
            // que abre o painel, inclusive de quem nunca abre esta seção. Quem chama
            // `detalharPdfsDoMes` paga o stat só do mês que está na tela (~2.200).
            const registrar = (classe, categoria) => {
                if (ehPdfIgnoradoNaLista(e.name)) return;
                const chave = mes || SEM_DATA;
                (todosPorMes[chave] || (todosPorMes[chave] = []))
                    .push({ nome: e.name, rel: relFilho, classe, categoria: categoria || null });
            };

            if (!ehDoc(e.name)) { ignorados++; registrar('anexo'); continue; }
            docs++;
            if (!mes) { pdfsSemData++; registrar('sem_data'); continue; }

            const categoria = categoriaNaoFiscal(e.name);
            if (categoria) {
                if (!naoFiscalPorMes[mes]) naoFiscalPorMes[mes] = { total: 0, porCategoria: {} };
                naoFiscalPorMes[mes].total++;
                naoFiscalPorMes[mes].porCategoria[categoria] = (naoFiscalPorMes[mes].porCategoria[categoria] || 0) + 1;
                registrar('nao_fiscal', categoria);
                continue;
            }
            porMes[mes] = (porMes[mes] || 0) + 1;
            (arquivosPorMes[mes] || (arquivosPorMes[mes] = [])).push({ nome: e.name, rel: relFilho });
            registrar('fiscal');
        }
    };
    andar(raiz, '');
    return { porMes, naoFiscalPorMes, arquivosPorMes, todosPorMes, docs, ignorados, pdfsSemData };
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

// ── "PDFs na pasta": o que existe no DISCO, não o que entrou na conferência ───
// As contagens acima respondem "quantas notas há?" e por isso descartam o que não é
// nota. Esta seção responde outra pergunta — "o que está arquivado nesta pasta?" —, e
// para ela o consórcio e os demais anexos são resposta, mas comprovantes CPV e PDFs
// cujo nome é só numérico são ruído operacional. Eles ficam fora da lista; os demais
// PDFs continuam trazendo a classe que diz por que entraram ou não na contagem fiscal.
//
// O `stat` sai daqui, e não da varredura, porque custa caro no compartilhamento de
// rede e só interessa ao mês que está na tela (ver comentário em `contarNaPasta`).
// `bytes: null` é um stat que falhou (arquivo removido entre a varredura e agora, ou
// sem permissão) — a linha continua valendo, só sem tamanho.
//
// O resultado é cacheado por mês: o `stat` de 2.221 arquivos custa 24 s a FRIO no
// compartilhamento de rede e 0,7 s a quente (medido em 09/09/2026, 03/2026). Sem
// cache, cada troca de mês e cada F5 pagaria de novo o pior caso — e como é síncrono,
// pagaria bloqueando o event loop, travando o servidor inteiro para todo mundo.
const TTL_PDFS_MS = 5 * 60 * 1000;
const cachePdfs = new Map();   // "raiz|periodo" → { em, resultado }
async function detalharPdfsDoMesCacheado(raiz, todosPorMes, periodo) {
    const chave = `${raiz}|${periodo}`;
    const agora = Date.now();
    const guardado = cachePdfs.get(chave);
    if (guardado && (agora - guardado.em) < TTL_PDFS_MS) return guardado.resultado;
    const resultado = await detalharPdfsDoMes(raiz, todosPorMes, periodo);
    cachePdfs.set(chave, { em: agora, resultado });
    // O acervo tem ~10 meses; o teto evita que o Map cresça sem limite se a raiz mudar.
    if (cachePdfs.size > 24) cachePdfs.delete(cachePdfs.keys().next().value);
    return resultado;
}

// `async` e em lotes de propósito. A versão síncrona (`statSync` em série) segurava o
// event loop por 24 s no primeiro acesso a um mês — o servidor inteiro parava, para
// todos os usuários, por causa de UMA seção da tela. Com `fs.promises.stat` em lotes
// o disco é consultado em paralelo e o loop respira entre eles.
const LOTE_STAT = 64;
async function detalharPdfsDoMes(raiz, todosPorMes, periodo) {
    const lista = (todosPorMes && todosPorMes[periodo]) || [];
    const t0 = Date.now();
    const arquivos = [];
    for (let i = 0; i < lista.length; i += LOTE_STAT) {
        const lote = await Promise.all(lista.slice(i, i + LOTE_STAT).map(async a => {
            let bytes = null, mtime = null;
            try { const st = await fs.promises.stat(path.join(raiz, a.rel)); bytes = st.size; mtime = st.mtimeMs; }
            catch (_) { /* sem stat: a linha ainda vale */ }
            const corte = a.rel.lastIndexOf('/');
            // `caminho` NÃO vai no JSON: é `pasta + '/' + nome`, e repeti-lo em 2.221
            // linhas custava 250 KB de resposta. A tela remonta em `caminhoDoPdf`.
            return {
                nome: a.nome,
                pasta: corte >= 0 ? a.rel.slice(0, corte) : '',
                classe: a.classe,
                categoria: a.categoria,
                bytes, mtime,
            };
        }));
        arquivos.push(...lote);
    }
    // Ordenar pela subpasta (que é a pasta-dia) e depois pelo nome põe o arquivo na
    // mesma ordem em que ele aparece no Explorer — é assim que quem confere procura.
    arquivos.sort((a, b) => a.pasta.localeCompare(b.pasta, 'pt-BR')
                         || a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true }));

    const porClasse = {};
    let bytesTotal = 0, semStat = 0;
    for (const a of arquivos) {
        porClasse[a.classe] = (porClasse[a.classe] || 0) + 1;
        if (a.bytes == null) semStat++; else bytesTotal += a.bytes;
    }
    if (arquivos.length)
        console.log(`[comparar-notas] ${periodo}: stat de ${arquivos.length} PDFs em ${Date.now() - t0} ms`);
    return { arquivos, total: arquivos.length, porClasse, bytesTotal, semStat };
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
        const iTipo = cols.indexOf('tipo');
        if (iArq < 0) continue;
        // Última coluna que interessa: a varredura para nela (ver separarCsvAte).
        const iUltima = Math.max(iArq, iPasta, iParser, iTipo);
        for (let i = 1; i < ls.length; i++) {
            // O CSV usa ; como separador e aspas duplas com escape "" nos campos
            // (dados_parser é um JSON inteiro). Só precisamos das colunas 'arquivo'
            // e 'pasta', mas é preciso respeitar as aspas para não quebrar errado.
            const campos = separarCsvAte(ls[i], iUltima);
            const arq = arquivoBase(campos[iArq] || '');
            if (!arq) continue;
            linhas++;
            if (!ehDoc(arq)) { ignorados++; continue; }

            const pastaRel = iPasta >= 0 ? (campos[iPasta] || '') : '';

            // O índice do OCR é montado ANTES do corte por mês e por categoria:
            // o pareamento consulta pastas vizinhas, então precisa dos campos de
            // documento que esta contagem descarta.
            //
            // Os campos são FUNDIDOS entre as linhas do mesmo arquivo, não fixados
            // na primeira: carnê grava uma linha por parcela (#p1, #p2…) e cada uma
            // traz um pedaço — a parcela tem o valor dela, o cabeçalho tem o da
            // nota. Ficar só com a primeira perdia campo em 1.035 arquivos.
            //
            // Indexado sob DUAS chaves: `pasta|arquivo`, que identifica o documento
            // sem ambiguidade, e o nome sozinho, como reserva. O nome sozinho não
            // basta porque o mesmo nome se repete em pastas diferentes — medido em
            // jan–jun/2026: 6 nomes em 16 documentos (0,4%), todos documento
            // recorrente arquivado todo mês (seguro prestamista da SICRED, endosso
            // HDI, tarifa do Santander). Nesses o OCR compartilhado até é o certo,
            // mas a chave por nome só funciona por sorte — e o extrator hoje tem
            // PRECEDÊNCIA sobre o nome do arquivo (§19), então um OCR trocado
            // sobrescreve número e valor bons. `chaveOcr` prefere a composta.
            const chaveComposta = `${pastaRel}|${arq}`;
            const funde = (chave) => {
                if (iParser >= 0) {
                    const campo = camposOcr(campos[iParser]);
                    if (campo) {
                        const at = ocrPorArquivo[chave] || (ocrPorArquivo[chave] = {});
                        // `retencao` entrou aqui em 18/09/2026. Faltava, e a falta era
                        // INVISÍVEL: `camposOcr` calculava o objeto {bruto, liquido,
                        // retido} corretamente, `enriquecerComOcr` (_pareamento.js:393)
                        // já sabia usá-lo como valor de casamento — e esta fusão o
                        // descartava no meio do caminho, porque a lista só tinha quatro
                        // campos. O comentário de CHAVES_VALOR ("retencaoDoParser já põe
                        // o bruto em out.retencao e enriquecerComOcr o usa") descrevia
                        // uma cadeia que nunca se completou.
                        // Achado ao gravar a retenção de 15 NFS-e e o painel não mudar:
                        // o dado estava no banco, o cálculo estava certo, e o índice não
                        // levava. Ver §17.13.
                        for (const k of ['numero', 'emitente', 'valor', 'dtEmissao', 'retencao'])
                            if (at[k] == null && campo[k] != null) at[k] = campo[k];
                        // `detalhe` é só exibição (CFOP/Itens/valor da nota/código da
                        // receita) — não participa do pareamento, então não segue a
                        // regra de precedência acima; primeira leitura não-vazia vale.
                        if (at.detalhe == null && campo.detalhe != null) at.detalhe = campo.detalhe;
                    }
                }
                if (iTipo >= 0 && String(campos[iTipo] || '').trim()) {
                    const at = ocrPorArquivo[chave] || (ocrPorArquivo[chave] = {});
                    if (at.tipo == null) at.tipo = String(campos[iTipo]).trim();
                }
            };
            funde(chaveComposta);
            funde(arq);

            const mes = mesDoDocumento(arq, pastaRel);
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
// 'Nº da NFS-e' entrou em 10/09/2026 com o parser de nota de serviço. Faltava, e a
// falta era INVISÍVEL: `parseNfse` lia o número certo, gravava sob essa chave, e
// `camposOcr` não a procurava — o número era descartado depois de extraído.
// Medido no efeito: 3 notas da ARPSEG (NF 530/531/534) perderam o par que tinham,
// porque `numero+entidade` deixou de existir para elas. Ver §15.16.
const CHAVES_NUMERO   = ['Nº da NF-e', 'Nº da NF-e (chave)', 'Nº da NFS-e',
                         'Número do documento', 'Numero da NF'];
// 'Razão social (nota)' e 'Nome social' são a razão social e o nome fantasia lidos
// do MIOLO da nota (09/09/2026). Vêm depois de 'Emitente' de propósito: o nome do
// arquivo é o que casa com a planilha, e estes entram como fonte adicional de
// tokens (_pareamento.js:364 UNE os tokens, não substitui) — o "BOBIG" do arquivo
// continua valendo, e "CONTATTO"/"HIDRAUFLEX" passam a valer também.
const CHAVES_EMITENTE = ['Emitente', 'Razão social', 'Nome do emitente',
                         'Razão social (nota)', 'Nome social'];
// 'Valor do serviço' é o BRUTO da NFS-e — o que a planilha lança. Vem por último:
// quando a retenção fecha, `retencaoDoParser` já põe o bruto em `out.retencao` e
// `enriquecerComOcr` o usa como valor de casamento; esta entrada cobre a NFS-e em
// que a conta NÃO fecha e o bruto seria o único valor disponível.
const CHAVES_VALOR    = ['Valor total da nota', 'Valor total', 'Valor do boleto',
                         'Valor do serviço'];
const CHAVES_EMISSAO  = ['Data de emissão', 'Data emissao'];

function primeiroDe(obj, chaves) {
    for (const k of chaves) {
        const v = obj[k];
        if (v != null && String(v).trim() !== '') return v;
    }
    return null;
}

// Junta o conteúdo de TODAS as chaves presentes, sem repetir. Só faz sentido para
// campos em que várias leituras somam (o emitente) — ver o uso em `camposOcr`.
function todosDe(obj, chaves) {
    const vistos = new Set();
    const partes = [];
    for (const k of chaves) {
        const v = obj[k];
        if (v == null) continue;
        const s = String(v).trim();
        if (!s) continue;
        const chaveDedup = s.toUpperCase();
        if (vistos.has(chaveDedup)) continue;
        vistos.add(chaveDedup);
        partes.push(s);
    }
    return partes.length ? partes.join(' ') : null;
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

// Campos de EXIBIÇÃO — não entram no pareamento (por isso ficam fora de `camposOcr`,
// que só devolve o que `enriquecerComOcr` usa para casar documento×lançamento). São
// para o clique em "notas encontradas" mostrar itens/valor/CFOP/código da receita
// sem reabrir o PDF. Vêm de `_nf-itens.js` (CFOP/Itens) e `_nf-parsers.js` (guia de
// imposto), já gravados em `dados_parser` — só precisavam ser lidos daqui.
const CHAVES_CODIGO_RECEITA = ['Código da receita'];

// ── Retenção na fonte (NFS-e) ────────────────────────────────────────────────
// Numa nota de SERVIÇO com imposto retido, o papel traz DOIS valores e a planilha
// lança o primeiro: o BRUTO (o serviço contratado) e o LÍQUIDO (o que o boleto
// cobra, já descontado o tributo). A diferença é o imposto, e não é divergência
// nenhuma — foi o caso que motivou esta regra: CORREA TRUCK HOUSE NF 377, bruto
// 3.690,00, ISSRF 184,50, líquido 3.505,50. O card acusava R$ 184,50 de erro.
//
// `parseNfse` (_nf-parsers.js) grava esses campos desde 10/09/2026. Aqui eles são
// lidos para `divergenciasDeValor` poder separar retenção de erro de verdade.
const CHAVES_VALOR_BRUTO   = ['Valor do serviço', 'Valor total dos serviços'];
const CHAVES_VALOR_LIQUIDO = ['Valor líquido'];
const CHAVES_RETIDOS = ['ISS retido', 'IRRF retido', 'INSS retido',
                        'CSLL retido', 'COFINS retido', 'PIS retido'];

// O parser grava "—" (travessão) quando não achou o campo — mesmo placeholder
// tratado no comentário de camposOcr. Sem filtrar, o travessão vira "código da
// receita" e o botão de copiar copia lixo.
const semValorReal = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

// O acervo tem itens gravados em DUAS formas. A atual é 'Itens' com rótulos
// ('Descrição', 'Valor unitário'), normalizada por `camposParaDadosParser`. A
// antiga é 'itens' com o objeto cru da IA ('descricao', 'valorUnitario'), de uma
// versão anterior do gravador. Medido em 09/09/2026 (`_medir/_forma-itens.js`):
// 960 linhas na forma nova e 802 na antiga, em 12.541 — e a divisão é por pasta,
// não por época, porque o upsert casa por `arquivo|pasta` e as pastas foram
// renomeadas ("SANTANDER/…" virou "2026.03.EXTRATOS CONTABILIDADE/SANTANDER/…").
// A releitura de hoje gravou a linha nova AO LADO da antiga em vez de substituí-la,
// e o pareamento pode casar com qualquer uma das duas. Ler só a forma nova deixava
// o modal de detalhe vazio nessas 802 — daí traduzir a antiga aqui, na leitura.
function itensDoParser(d) {
    if (Array.isArray(d['Itens']) && d['Itens'].length) return d['Itens'];
    if (!Array.isArray(d['itens']) || !d['itens'].length) return null;
    // A forma antiga guarda número JS (25, 450); a nova já vem em string "25,00".
    // Formatar aqui, e não na tela, faz as duas chegarem idênticas ao front.
    const num = v => {
        if (v == null || v === '') return '';
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        return Number.isFinite(n) ? n.toFixed(2).replace('.', ',') : String(v);
    };
    return d['itens'].map(it => ({
        'Descrição':     it.descricao || '',
        'NCM':           it.ncm || '',
        'CFOP':          it.cfop || '',
        'Unidade':       it.unidade || '',
        'Quantidade':    it.quantidade == null ? '' : it.quantidade,
        'Valor unitário': num(it.valorUnitario),
        'Valor total':    num(it.valorTotal),
        // A forma antiga não gravava confiança; deixar vazio é mais honesto que
        // inventar "alta" para item que ninguém conferiu.
        'Confiança':     it.confianca || '',
    }));
}

function detalheOcr(d) {
    const out = {};
    if (d['CFOP'] && !semValorReal(d['CFOP'])) out.cfop = String(d['CFOP']);
    const itens = itensDoParser(d);
    if (itens) out.itens = itens;
    const valorNota = valorDoParser(primeiroDe(d, CHAVES_VALOR));
    if (valorNota != null) out.valorNota = valorNota;
    const codigoReceita = primeiroDe(d, CHAVES_CODIGO_RECEITA);
    if (!semValorReal(codigoReceita)) out.codigoReceita = String(codigoReceita);
    // A chave já chega validada pelo DV (`chaveValida` em _nf-parsers.js zera o
    // campo quando não fecha — ver chave-acesso-valida-o-dv.md), então aqui é só
    // repassar o que já está limpo. Sem reformatar: o botão de copiar da tela
    // precisa da sequência crua de 44 dígitos, sem pontuação nem espaço.
    const chave = d['Chave de acesso'];
    if (!semValorReal(chave)) out.chaveAcesso = String(chave).replace(/\D/g, '');
    return Object.keys(out).length ? out : null;
}

// Os três números da retenção, quando o papel é NFS-e e os traz.
//
// A trava está no `fecha`: só devolvemos retenção quando bruto − retenções =
// líquido NO PRÓPRIO PAPEL. Isso não é rigor decorativo, é o que separa número de
// número parecido — medido em 10/09/2026 (`_medir/_parser-nfse.js`), a NFS-e da
// SKILLHUB imprime "IRRF 1,50 / COFINS 3,00 / PIS 0,65" que são ALÍQUOTAS, não
// valores (1,5% de 790,12 = 11,85, não 1,50). Somá-las daria 5,15 e "explicaria"
// um desconto de 48,59 como se fosse retenção parcial. Exigir que a conta feche
// recusa essas: sem bruto e sem líquido impressos, não há o que conferir.
//
// É a mesma disciplina que `totalDaNotaComOrigem` (_nf-itens.js) já aplica ao
// total da nota: a soma dos itens vale porque é aritmética verificada, e ler por
// posição de coluna está reprovado justamente por produzir número errado com cara
// de certo.
function retencaoDoParser(d) {
    const bruto = valorDoParser(primeiroDe(d, CHAVES_VALOR_BRUTO));
    const liquido = valorDoParser(primeiroDe(d, CHAVES_VALOR_LIQUIDO));
    if (bruto == null || liquido == null || liquido >= bruto) return null;

    const retidos = CHAVES_RETIDOS
        .map(k => valorDoParser(d[k]))
        .filter(v => v != null);

    // Duas candidatas para o total retido, testadas na ordem em que merecem
    // confiança. Ambas passam pelo MESMO teste de fechamento — nenhuma é aceita
    // por autoridade do rótulo.
    //
    //  1. `TOTAL TRIB. FEDERAIS`, que a própria nota soma. É mais robusta que
    //     somar rótulo a rótulo: dispensa acertar o nome de cada tributo (o
    //     layout de Cascavel usa `IR`, não `IRRF`) e não corre o risco de captar
    //     a coluna vizinha. Na GENUSCLIN NF 37846 é ela que faz a conta fechar.
    //     Somada ao ISS retido, quando os dois existem — o ISS é municipal e fica
    //     fora do total federal.
    //  2. a soma dos tributos lidos um a um, para as notas que não imprimem total.
    const federais = valorDoParser(d['Total trib. federais']);
    const issRetido = valorDoParser(d['ISS retido']);
    const somaRotulos = retidos.reduce((s, v) => s + v, 0);
    // Agrupados do layout NACIONAL de NFS-e, que não traz rótulo por tributo:
    // "PIS/COFINS/CSLL 4,65%: R$ 25,39" (G.A.R NF 216) e o par
    // "IRRF + CONTRIBUICOES SOCIAIS - RETIDAS" (MRD NF 107: 45,07 + 139,72 = 184,79).
    const pcc = valorDoParser(d['PIS/COFINS/CSLL retidos']);
    const sociais = valorDoParser(d['Contrib. sociais retidas']);
    const irrf = valorDoParser(d['IRRF retido']);

    const candidatas = [];
    if (federais != null) {
        candidatas.push(federais);
        if (issRetido != null) candidatas.push(federais + issRetido);
    }
    if (pcc != null) {
        candidatas.push(pcc);
        if (irrf != null) candidatas.push(pcc + irrf);
    }
    if (sociais != null && irrf != null) candidatas.push(sociais + irrf);
    if (sociais != null) candidatas.push(sociais);
    if (somaRotulos > 0) candidatas.push(somaRotulos);
    if (!candidatas.length) return null;

    // Um centavo de folga por tributo: cada retenção é arredondada na origem.
    const folga = 0.01 * Math.max(1, retidos.length);
    for (const soma of candidatas) {
        if (Math.abs(bruto - soma - liquido) <= folga)
            return { bruto, liquido, retido: Math.round(soma * 100) / 100 };
    }
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
    // O emitente é o único campo em que TODAS as fontes somam em vez de competir:
    // `enriquecerComOcr` une os tokens (não substitui), então juntar aqui a razão
    // social e o nome fantasia lidos da nota só acrescenta formas de casar a mesma
    // empresa — "BOBIG" (arquivo) + "CONTATTO"/"HIDRAUFLEX" (nota). Para os demais
    // campos `primeiroDe` continua valendo: número e valor têm de ser um só.
    const emitente = todosDe(d, CHAVES_EMITENTE);
    const valor = valorDoParser(primeiroDe(d, CHAVES_VALOR));
    const dtEmissao = dataDoParser(primeiroDe(d, CHAVES_EMISSAO));
    const detalhe = detalheOcr(d);
    const retencao = retencaoDoParser(d);
    if (numero == null && emitente == null && valor == null && dtEmissao == null
        && detalhe == null && retencao == null) return null;

    const out = {};
    if (numero != null) out.numero = String(numero);
    if (emitente != null) out.emitente = String(emitente);
    if (valor != null) out.valor = valor;
    if (dtEmissao != null) out.dtEmissao = dtEmissao;
    if (detalhe != null) out.detalhe = detalhe;
    // O BRUTO é o que a planilha lança. Quando a retenção confere, ele entra como
    // valor do documento para o pareamento — sem ele, o par tem de casar contra o
    // líquido, que é justamente o número que não bate com a planilha.
    if (retencao != null) out.retencao = retencao;
    return out;
}

// ── Onde o documento está × onde deveria estar ───────────────────────────────
// Medido em 09/09/2026 (`_medir/_por-que-deslocado.js`, 03.2026): dos 186 pares
// casados em pasta VIZINHA, 181 (97,3%) têm o nome do arquivo e a pasta
// CONCORDANDO entre si — o papel está bem arquivado pela data dele, e quem cai
// noutro mês é o lançamento (competência ≠ pagamento). Marcar esses como "fora do
// lugar" mandaria mexer em 180 arquivos corretos.
//
// Então o lugar devido do PAPEL é a pasta da data do PRÓPRIO documento, não a do
// lançamento. Sobram três casos que merecem ação, e são poucos: em março, 6 para
// mover e 5 para renomear, de 628 lançamentos.
const RE_DATA_NOME_ISO = /(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/;
const RE_DATA_NOME_BR  = /(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/;

function mesNoNomeArquivo(nome) {
    const n = String(nome || '');
    let m = n.match(RE_DATA_NOME_ISO);
    if (m) return `${m[1]}.${m[2]}`;
    m = n.match(RE_DATA_NOME_BR);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

function mesNaPastaDoCaminho(rel) {
    const s = String(rel || '').replace(/\\/g, '/');
    let m = s.match(/(?:^|\/)(20\d{2})\.(\d{2})\.(\d{2})(?:\/|$)/);
    if (m) return `${m[1]}.${m[2]}`;
    m = s.match(/(?:^|\/)(\d{2})\.(\d{2})\.(20\d{2})(?:\/|$)/);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

// Data que PARECE data mas não casa nenhum formato válido: "2026.04.414" (dia
// inválido), "226.04.22" (ano de 3 dígitos), "2026.04.1" (dia incompleto). Aqui a
// pasta costuma estar certa e o NOME é que precisa de conserto — ação oposta a
// mover o arquivo, por isso é situação própria.
function dataMalformadaNoNome(nome) {
    const n = String(nome || '');
    if (mesNoNomeArquivo(n)) return '';
    const m = n.match(/(?<!\d)(\d{1,4}\.\d{1,2}\.\d{1,4})(?!\d)/);
    return m ? m[1] : '';
}

/**
 * { situacao, ondeEsta, ondeDeveria, dataInvalida } para um documento casado.
 *   ok            pasta do mês do lançamento
 *   outro_mes     outra pasta, coerente com a data do nome — normal, sem ação
 *   fora_do_lugar nome diz um mês, pasta é outra — mover
 *   data_invalida data do nome malformada — renomear
 */
function localizacao(documento, periodoLancamento) {
    const mesLanc = (() => { const [m, a] = String(periodoLancamento).split('.'); return `${a}.${m}`; })();
    const nome = documento.arquivo || '';
    const caminho = documento.caminho || '';
    const ruim = dataMalformadaNoNome(nome);
    const mn = mesNoNomeArquivo(nome);
    const mp = mesNaPastaDoCaminho(caminho);

    if (ruim) return { situacao: 'data_invalida', ondeEsta: caminho, ondeDeveria: mp || mesLanc, dataInvalida: ruim };
    if (mn && mp && mn !== mp) return { situacao: 'fora_do_lugar', ondeEsta: caminho, ondeDeveria: mn, dataInvalida: '' };
    if (mp && mp !== mesLanc) return { situacao: 'outro_mes', ondeEsta: caminho, ondeDeveria: mp, dataInvalida: '' };
    return { situacao: 'ok', ondeEsta: caminho, ondeDeveria: mn || mesLanc, dataInvalida: '' };
}

// O OCR de um documento, preferindo a chave que o identifica sem ambiguidade.
// `rel` é o caminho relativo do arquivo (com o nome no fim); o índice é chaveado
// pela PASTA, então o nome sai do fim. Cai no nome sozinho quando a composta não
// existe — CSV antigo, gravado antes da coluna `pasta`, ou pasta vazia.
function ocrDoDocumento(ocrPorArquivo, nome, rel) {
    if (!ocrPorArquivo) return null;
    const s = String(rel || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    const pasta = i < 0 ? '' : s.slice(0, i);
    return ocrPorArquivo[`${pasta}|${nome}`] || ocrPorArquivo[nome] || null;
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
        // A tela limita a lista visual para não pesar o painel, mas a exportação
        // precisa representar todos os lançamentos faltantes do período.
        todosSemDocumento: semDocumento.map(l => ({
            entidade: l.entidade,
            nf: l.nf,
            valor: Math.abs(l.valor) || 0,
            dtLancamento: l.dtLancamento,
        })),
        listaSemDocumento: lista,
        listaTruncadaEm: semDocumento.length > MAX_LISTA ? MAX_LISTA : null,
    };
}

// ── Valores divergentes ──────────────────────────────────────────────────────
// O par existe — número E fornecedor confirmam que o papel é DAQUELE lançamento —,
// mas o dinheiro não bate. É a segunda pergunta da conferência: "o que está
// arquivado confere com o que foi lançado?".
//
// Só entram pares em DESACORDO de valor, não pares em que o valor falta: sem
// valor no documento não há divergência a apurar, há dado ausente (1 caso em
// 2.068 pares). A via `valor*` nunca aparece aqui por construção — nela bate.
//
// MEDIDO em 03/09/2026 (jan–jun/2026, `_medir/divergencias.js` e `divergencias2.js`),
// 2.068 pares, 247 com valor divergindo (11,9%). A composição é o que define o card:
//
//   parcela — razão inteira exata     110 (44,5%)   R$ 606 mil
//   divergência real                  137 (55,5%)   R$ 667 mil
//
// **Parcela não é divergência.** CIMAG R$ 30.600 ÷ 5 = R$ 6.120, AGRICOPEL
// R$ 20.995 ÷ 4 = R$ 5.248,75, YELUM ÷ 10 — o documento é UMA parcela da nota, e
// a distribuição dos N confirma (2x:33, 3x:42, 4x:23, o resto pulverizado até 12x).
// É o caso que PROGRESSO §13/§14 descreve. Sem essa separação o card viraria uma
// lista em que as 15 maiores linhas são todas falsas — e a maior de todas seria a
// CIMAG, que está certa.
//
// As 137 restantes se distribuem assim, e cada faixa quer uma leitura diferente:
//
//   ≤1%      1   arredondamento
//   1–5%    54   retenção de ISS/IR, desconto de boleto — legítimo e esperado
//   5–15%   40   idem, retenção maior
//   15–50%   7
//   >50%    35   é aqui que mora o problema
//
// A faixa >50% não é só "valor errado": parte dela é PAR errado. GIZELE FERREIRA
// NF 3764 (R$ 5.748,79) casada com `084.DOC- 614,30 ... FT13837`, WN AUTO ELETRICA
// NF 143 (R$ 150,00) com `021.DOC- 3040,00 ... FT511444` — o número do OCR bateu,
// o do nome do arquivo é outro, e o fornecedor bate por token. O card as expõe
// justamente por isso: é a única tela em que um par errado fica visível.
const MAX_DIVERGENCIAS = 200;

// Teto de parcelas aceito ao classificar. 36 cobre o que a medição encontrou
// (o maior N real foi 12) com folga, sem chegar ao consórcio de 60–80, que não
// aparece aqui.
const MAX_PARCELAS_DIV = 36;

// O documento pode ter dois valores: o lido pelo extrator (`valor`) e o do nome
// do arquivo (`valorAlt`), que numa parcela é o valor PAGO. Para medir a
// divergência vale o mais próximo do lançamento — senão uma parcela apareceria
// como divergência de milhares de reais, que é justamente o que ela não é.
function valorMaisProximo(l, d) {
    const cands = [d.valor, d.valorAlt].filter(v => v != null && v > 0);
    if (!cands.length) return null;
    return cands.reduce((a, b) =>
        Math.abs(l.valor - a) <= Math.abs(l.valor - b) ? a : b);
}

// N tal que `parte` × N = `total`, ou null. A tolerância cresce com N porque o
// arredondamento da parcela se acumula (R$ 0,01 por parcela é o pior caso real).
function razaoParcela(total, parte) {
    if (!(parte > 0) || parte >= total) return null;
    const n = Math.round(total / parte);
    if (n < 2 || n > MAX_PARCELAS_DIV) return null;
    return Math.abs(total - n * parte) <= 0.02 * n ? n : null;
}

// ── Empates: mais de um documento disputava o mesmo lançamento ───────────────
// Quando dois candidatos empatam em força e em distância de data, o desempate é
// pelo nome do arquivo (`parear` em _pareamento.js) — estável, mas arbitrário
// quanto ao mérito. Foi assim que o Pedido/PV da MACPONTA ganhou da nota
// escaneada, ambos "031.DOC- 1320000,00".
//
// A medição de 08/09/2026 tentou decidir isso automaticamente e REPROVOU: preferir
// o documento sem marcador de acessório ("+ AUT", "+ PV", PEDIDO) trocava 61 pares,
// e a inspeção mostrou os pares existentes CERTOS e as alternativas erradas —
// "+ AUT" quer dizer "nota MAIS autorização anexa". Sem sinal automático confiável,
// o caminho é mostrar o empate para conferência humana.
const MAX_EMPATES = 50;

// PARCELA não é empate. Medido em 02/2026: dos 50 empates brutos, a maioria era um
// carnê — SAVANA NF 162111 de R$ 16.000 com quatro documentos de R$ 4.000 em meses
// seguidos, UNIVERSAL FERRO NF 84179 com quatro de R$ 6.871,90. Os candidatos não
// disputam o mesmo papel: cada um é uma parcela distinta do mesmo lançamento, e
// listá-los como ambiguidade manda conferir o que está certo. Reusa `razaoParcela`,
// o mesmo teste que `divergenciasDeValor` já aplica.
//
// Está separado em função porque agora responde em DOIS lugares: nesta lista e no
// sinal `empatado` de cada linha de `encontradas`. Se o desconto do carnê valesse
// só num deles, a tela mostraria mais linhas ambíguas do que a lista de empates diz
// existir — dois números discordando na mesma tela.
function ehParcela(p) {
    const vDoc = valorMaisProximo(p.lancamento, p.documento);
    return vDoc != null && razaoParcela(p.lancamento.valor, vDoc) != null;
}

// O valor PAGO num documento. `valorAlt` vem do nome do arquivo e, num carnê, é o
// valor da parcela; `valor` é o total da nota lido pelo extrator. Para somar
// parcelas vale o pago — somar totais de nota daria N× o lançamento.
const valorPago = d => (d && d.valorAlt != null && d.valorAlt > 0) ? d.valorAlt
                     : (d && d.valor != null && d.valor > 0) ? d.valor : null;

// CARNÊ que `ehParcela` não pega. `ehParcela` testa se UM documento é fração exata
// do total, e falha quando as parcelas são desiguais — UNIVERSAL FERRO NF 84958 de
// R$ 19.473,80 tem entrada de R$ 5.242,01 e três de R$ 4.743,93: nenhuma é total÷4,
// mas a SOMA fecha no centavo. Idem MULTIBELT (2.377,00 + 2.130,00) e BRV
// (180,00 + 2.925,00).
//
// Medido em jan–jun/2026: dos 235 empates, 28 têm soma que fecha. Desses, 26 trazem
// a MESMA NF em todos os arquivos e os 2 restantes são erro de digitação da mesma NF
// (FLORESTEC "NF 13543" × "NF 13453"; R C TRATORES "NF 4+ BOL 1138" × "NF 41138") —
// por isso o teste NÃO exige NF igual: exigir devolveria à lista dois carnês reais.
// A soma fechar no centavo com 3–4 arquivos do mesmo fornecedor já é evidência mais
// forte que a NF, que aqui é digitada à mão.
//
// Estes documentos não disputam o mesmo papel: cada um é uma parcela distinta do
// mesmo lançamento, e listá-los como ambiguidade manda conferir o que está certo —
// a mesma razão que tirou o carnê da lista em `ehParcela`.
function ehCarne(p) {
    const cands = p.candidatosEmpatados || [];
    if (!cands.length) return false;
    const vals = [valorPago(p.documento), ...cands.map(valorPago)];
    // Soma parcial não fecha nada: um só candidato sem valor invalida o teste, senão
    // um documento ilegível viraria "carnê" por omissão.
    if (vals.some(v => v == null)) return false;
    const soma = vals.reduce((a, b) => a + b, 0);
    // Mesma escala de tolerância de `razaoParcela`: o arredondamento da parcela
    // acumula (FLORESTEC: 7.548,24 + 7.548,23).
    return Math.abs(soma - Math.abs(p.lancamento.valor)) <= 0.02 * vals.length;
}

// Os dois testes são COMPLEMENTARES e ambos valem: `ehParcela` pega o carnê de que a
// pasta tem uma parcela só (a soma não teria como fechar), `ehCarne` pega o de
// parcelas desiguais. Medido: dos 28 que a soma pega, `ehParcela` já pegava 14.
const ehParcelamento = p => ehParcela(p) || ehCarne(p);

// POR QUE este empate empatou. Medido em jan–jun/2026 sobre as 207 colisões reais:
// não há desempate automático disponível (a NF do lançamento aparece em um só
// arquivo em 6 casos, e em NENHUM arquivo em 165 — são recibos cujo "nf" na planilha
// é número interno que nunca esteve no papel). Como a regra não tem o que decidir,
// o que resta é dizer ao humano onde olhar. Por isso aqui se CLASSIFICA, não se
// escolhe: nenhum par troca de documento.
//
// A ordem importa — o primeiro que casar vence, do mais específico ao mais genérico.
function motivoDoEmpate(p) {
    const cands = p.candidatosEmpatados || [];
    const vEsc = valorPago(p.documento);
    const mesmoValor = cands.some(d => {
        const v = valorPago(d);
        return v != null && vEsc != null && Math.abs(v - vEsc) < 0.005;
    });

    // A NF do lançamento aparece no nome de UM só arquivo? É o caso mais acionável:
    // o humano decide num relance. Raro (6 em 207), e em 2 deles a NF aponta um
    // arquivo diferente do escolhido — mostrar é justamente o objetivo.
    const nfL = String(p.lancamento.nf ?? '').replace(/\D/g, '');
    if (nfL.length >= 3) {
        const temNF = nome => String(nome || '').replace(/\D/g, '').includes(nfL);
        const quantos = (temNF(p.documento.arquivo) ? 1 : 0)
                      + cands.filter(d => temNF(d.arquivo)).length;
        if (quantos === 1) {
            return temNF(p.documento.arquivo)
                ? { codigo: 'nf_no_escolhido', texto: 'só o escolhido tem a NF do lançamento' }
                : { codigo: 'nf_em_outro', texto: 'a NF do lançamento está em OUTRO arquivo' };
        }
    }

    // Mesmo fornecedor nos dois papéis: nem o nome desempata. É o UNIDAS — FAT 68383
    // e FAT 68634, mesmo dia, mesmo valor. Usa `tokens` de _pareamento.js, o mesmo
    // teste que o motor usa para casar entidade; escrever outro aqui faria a tela
    // discordar do pareamento sobre o que é "o mesmo fornecedor".
    const tl = pareamento.tokens(p.lancamento.entidade);
    if (tl.size) {
        const doLanc = nome => {
            const t = pareamento.tokens(nome);
            for (const x of tl) if (t.has(x)) return true;
            return false;
        };
        if (doLanc(p.documento.arquivo) && cands.every(d => doLanc(d.arquivo)))
            return mesmoValor
                ? { codigo: 'mesmo_fornecedor', texto: 'mesmo fornecedor, 2 papéis de valor igual' }
                : { codigo: 'mesmo_fornecedor_val', texto: 'mesmo fornecedor, valores diferentes' };
    }

    // Os papéis são do mesmo fornecedor ENTRE SI, ainda que a entidade da planilha não
    // case com todos? O teste acima compara cada arquivo com a ENTIDADE, e basta UM
    // nome que não tokenize para o grupo inteiro cair aqui como "fornecedor diferente".
    //
    // Achado em 18/09/2026: `060.DOC- 75,00-2026.01.12.BIOSNET . FT 248613.pdf` — com
    // "BIOSNET" grudado — não gera o token `BIOS`, e sozinho jogava para `colisao_valor`
    // lotes inteiros da BIOS NETWORKS em que todos os outros arquivos casavam. Medido:
    // 31 dos 90 `colisao_valor` são o mesmo fornecedor entre si. Não é ambiguidade, é
    // lote (a ordem de compra coletiva de §16.5) — e mandar conferir manda abrir 12 PDFs
    // idênticos para não decidir nada.
    //
    // Compara par a par em vez de contra a entidade: a pergunta "estes papéis são da
    // mesma empresa?" não depende de como a planilha escreveu o nome dela.
    if (mesmoValor) {
        const nomes = [p.documento.arquivo, ...cands.map(d => d.arquivo)];
        const tks = nomes.map(n => pareamento.tokens(n));
        const compartilham = (a, b) => { for (const t of a) if (b.has(t)) return true; return false; };
        let todosEntreSi = true;
        for (let i = 0; i < tks.length && todosEntreSi; i++)
            for (let j = i + 1; j < tks.length; j++)
                if (!compartilham(tks[i], tks[j])) { todosEntreSi = false; break; }
        if (todosEntreSi)
            return { codigo: 'mesmo_fornecedor', texto: 'mesmo fornecedor, papéis de valor igual' };
    }

    // O caso mais comum: valor idêntico, fornecedores distintos. R$ 1.000,00 é um valor
    // que muita gente recebe, e quando o lançamento não tem NF no papel o valor é o
    // único sinal — e ele não distingue.
    if (mesmoValor) return { codigo: 'colisao_valor', texto: 'mesmo valor, fornecedor diferente' };
    return { codigo: 'outro', texto: 'valores diferentes, casou por NF+fornecedor' };
}

function empatesParaTela(pares) {
    const linhas = [];
    let parcelados = 0;
    for (const p of pares) {
        if (!p.empatado) continue;
        if (ehParcelamento(p)) { parcelados++; continue; }

        linhas.push({
            entidade: p.lancamento.entidade,
            nf: p.lancamento.nf,
            valor: p.lancamento.valor,
            forca: p.forca,
            via: p.via,
            escolhido: p.documento.arquivo,
            caminho: p.documento.caminho || p.documento.arquivo,
            periodoDocumento: p.periodoDocumento || null,
            // Por que empatou — a coluna "Motivo" da tela. Ver `motivoDoEmpate`.
            motivo: motivoDoEmpate(p),
            // Os que ficaram de fora, para quem confere abrir e comparar.
            candidatos: (p.candidatosEmpatados || []).slice(0, 6),
            outros: (p.candidatosEmpatados || []).length,
        });
    }
    // Pelo valor: o empate de R$ 1,3 milhão importa mais que o de R$ 75.
    linhas.sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
    return {
        empatados: linhas.length,
        // Quantos empates eram carnê — fora da lista, mas visíveis para o número
        // não parecer ter sumido.
        empatadosParcela: parcelados,
        // O bruto, antes de descontar parcelamento. Existe para o medidor provar que
        // reclassificar MOVE o empate de coluna sem fazê-lo sumir: a invariante é
        // `empatados + empatadosParcela === empatadosBruto`. Sem isso o teste não
        // teria como distinguir "virou parcela" de "desapareceu".
        empatadosBruto: linhas.length + parcelados,
        listaEmpatados: linhas.slice(0, MAX_EMPATES),
        empatadosTruncadaEm: linhas.length > MAX_EMPATES ? MAX_EMPATES : null,
    };
}

// RETENÇÃO NA FONTE não é divergência, pelo mesmo motivo que parcela não é: o
// papel CONFERE com o lançamento, os dois números só descrevem coisas diferentes —
// a planilha lança o serviço bruto, o boleto cobra o líquido, e a diferença é o
// imposto que a própria nota declara reter.
//
// O teste é aritmético e usa só números lidos do papel: `retencaoDoParser` já
// exigiu que bruto − retenções = líquido NA NOTA, e aqui basta confirmar que o
// lançamento é o BRUTO. São duas verificações independentes — a nota consigo
// mesma, e a nota com a planilha.
//
// MEDIDO em 10/09/2026 (`_medir/_retencao-*.js`, jan–jun/2026): das 131
// divergências fora parcela, 110 têm documento menor que o lançado e 95 declaram
// retenção. A regra que classifica por vocabulário + teto de 15% pegava 85 com
// ZERO falsos positivos — e o que restava na lista era problema de verdade (par
// errado: GIZELE FERREIRA, WN AUTO ELETRICA; valor invertido: FERNANDO MENDES
// 10.044 × 10.440). Esta versão é mais estrita ainda: exige a conta fechando no
// papel, então não depende de teto nenhum.
function ehRetencao(l, d) {
    if (!(d.valorRetido > 0) || !(d.valorLiquido > 0)) return false;
    // O lançamento tem de ser o BRUTO. Se a planilha lançou outro número — o
    // líquido, ou um valor que não é nenhum dos dois —, a retenção não explica
    // nada e o caso segue para a lista como divergência, que é o certo.
    return Math.abs(l.valor - d.valor) <= 0.02;
}

function divergenciasDeValor(pares) {
    const linhas = [];
    let parcelas = 0, valorParcelas = 0;
    let retencoes = 0, valorRetencoes = 0;
    for (const p of pares) {
        const l = p.lancamento, d = p.documento;
        if (!(l.valor > 0)) continue;

        // A retenção é contada ANTES do teste de diferença, e não depois. Uma vez
        // que `enriquecerComOcr` põe o BRUTO em `d.valor`, `valorMaisProximo`
        // devolve justamente ele — o par passa a bater e cairia no `continue` de
        // tolerância abaixo, sem ser contado. O caso ficaria correto na lista e
        // invisível no rodapé: o usuário veria a divergência sumir sem explicação.
        // Contar aqui é o que sustenta "R$ X são imposto retido" na tela.
        if (ehRetencao(l, d)) {
            retencoes++; valorRetencoes += d.valorRetido;
            continue;
        }

        const vDoc = valorMaisProximo(l, d);
        if (vDoc == null) continue;              // sem valor no papel: não é divergência
        const dif = vDoc - l.valor;
        if (Math.abs(dif) < 0.005) continue;     // mesma tolerância de `valorBate`

        // Parcela sai da lista e vira contagem própria: o papel confere com o
        // lançamento, só cobre uma fração dele.
        const n = razaoParcela(l.valor, vDoc);
        if (n) { parcelas++; valorParcelas += Math.abs(dif); continue; }

        linhas.push({
            entidade: l.entidade,
            nf: l.nf,
            valorPlanilha: l.valor,
            valorDocumento: vDoc,
            diferenca: dif,
            // % sobre o lançamento: separa a retenção (poucos %) do erro grosso.
            percentual: (dif / l.valor) * 100,
            arquivo: d.arquivo,
            // Caminho relativo à raiz varrida acima (ARQUIVO_PATH, com MONITOR_PATH
            // como reserva) — é o que /api/pdf-viewer precisa para abrir o PDF na
            // tela, e por isso aquela rota procura nas MESMAS duas raízes, nesta
            // ordem. `arquivo` sozinho não basta: o mesmo nome aparece em subpastas
            // de meses diferentes.
            caminho: d.caminho || d.arquivo,
            via: p.via,
            // Onde o papel está, para quem for abrir a pasta conferir.
            periodoDocumento: p.periodoDocumento || null,
            // Idem `encontradas`: distingue par do mês de par de pasta vizinha.
            deslocamento: p.deslocamento ?? null,
        });
    }
    // Pela diferença absoluta: a retenção de centavos não compete com a nota
    // lançada com o valor errado.
    linhas.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));
    return {
        divergentes: linhas.length,
        valorDivergencia: linhas.reduce((s, x) => s + Math.abs(x.diferenca), 0),
        // Quantos dos divergentes passam de 50% do lançamento — a faixa em que a
        // medição achou par errado, não só valor errado.
        divergentesGraves: linhas.filter(x => Math.abs(x.percentual) > 50).length,
        // Parcela não entra na lista, mas o número aparece: sem ele o usuário
        // pergunta por que o card mostra menos do que o total que não bate.
        parcelas,
        valorParcelas,
        // Idem retenção na fonte: fora da lista, mas contada — é o imposto retido
        // (ISS/IRRF/PIS/COFINS/CSLL), não erro. Mostrar o valor deixa explícito
        // quanto do "que não bate" é tributo.
        retencoes,
        valorRetencoes,
        // A tabela da tela mostra apenas os maiores; o relatório para PDF precisa
        // incluir todos os pares divergentes devolvidos pelo pareamento.
        todosDivergentes: linhas,
        listaDivergentes: linhas.slice(0, MAX_DIVERGENCIAS),
        divergentesTruncadaEm: linhas.length > MAX_DIVERGENCIAS ? MAX_DIVERGENCIAS : null,
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

        // 2b) "PDFs na pasta" — a lista crua do disco, do mês pedido. Depende do banco
        // só para marcar quais o OCR já leu, e é a última coisa a ser montada porque o
        // `stat` é a parte cara. Cai fora sem derrubar o resto se a pasta sumir.
        let pdfs = { disponivel: false };
        if (pasta.disponivel && pastaBruta) {
            try {
                const d = await detalharPdfsDoMesCacheado(raiz, pastaBruta.todosPorMes, periodo);
                // O índice do OCR responde por `pasta|arquivo` e, como reserva, pelo
                // nome sozinho — as duas chaves que `contarNoCsv` grava.
                //
                // `lido` sai numa CÓPIA, não no objeto cacheado: o cache do disco e o do
                // banco expiram em ritmos diferentes, e gravar ali deixaria um "lido"
                // velho colado no arquivo depois que o banco já mudou.
                const ocr = (b && b.ocrPorArquivo) || {};
                const arquivos = d.arquivos.map(a => ({
                    ...a, lido: !!(ocr[`${a.nome}|${a.pasta}`] || ocr[a.nome]),
                }));
                pdfs = {
                    disponivel: true, raiz, ...d, arquivos,
                    lidos: arquivos.filter(a => a.lido).length,
                    // Os PDFs sem data não pertencem a mês nenhum, então não estão na
                    // lista acima. O número aparece para a seção não contradizer o
                    // rodapé do painel, que os conta.
                    semData: (pastaBruta.todosPorMes[SEM_DATA] || []).length,
                };
            } catch (e) {
                console.error('[comparar-notas] lista de PDFs falhou:', e.message);
                pdfs = { disponivel: false, motivo: e.message };
            }
        }

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
                // Os lançamentos vêm ANTES dos documentos: a repescagem
                // (`admiteNoPareamento`) precisa deles para decidir quais documentos
                // cortados provam ser o pagamento.
                const lancamentos = (itensPlanilha || []).map(pareamento.lancamentoDaPlanilha);
                const documentoDe = (a) => pareamento.enriquecerComOcr(
                    pareamento.documentoDoArquivo(a.nome, a.rel),
                    ocrDoDocumento(ocrPorArquivo, a.nome, a.rel));
                const documentosPorMes = {};
                for (const off of [0, ...pareamento.VIZINHANCA]) {
                    const alvo = pareamento.deslocarPeriodo(periodo, off);
                    const arquivos = (pastaBruta && pastaBruta.arquivosPorMes[alvo]) || [];
                    const docs = arquivos.map(documentoDe);
                    // Repescagem dos não-fiscais que provam fornecedor E valor. A lista
                    // crua (`todosPorMes`) é a mesma varredura, então não custa I/O; os
                    // repescados vão marcados para a tela poder distingui-los.
                    for (const a of ((pastaBruta && pastaBruta.todosPorMes[alvo]) || [])) {
                        // `classe` vem da própria varredura: só 'nao_fiscal' é candidato.
                        // Anexo e sem-data continuam de fora — não são documento de
                        // pagamento, e sem data o pareamento não tem como situá-los.
                        if (a.classe !== 'nao_fiscal') continue;
                        const categoria = a.categoria;
                        const d = documentoDe(a);
                        if (!admiteNoPareamento(d, lancamentos)) continue;
                        d.repescadoDe = categoria;
                        docs.push(d);
                    }
                    documentosPorMes[alvo] = docs;
                }
                const r = pareamento.conferirPeriodo(lancamentos, documentosPorMes, periodo);
                const porVia = [...r.pares, ...r.paresVizinhos].reduce((acc, p) => {
                    acc[p.via] = (acc[p.via] || 0) + 1;
                    return acc;
                }, {});
                conferencia = {
                    disponivel: true,
                    // Total conferido = com documento em qualquer pasta. É o número do card.
                    conferidos: r.pares.length + r.paresVizinhos.length,
                    encontradas: [...r.pares, ...r.paresVizinhos].map(p => ({
                        tipo: p.documento.tipo || 'Não identificado',
                        fornecedor: p.lancamento.entidade || '',
                        cnpj: p.lancamento.cnpj || '',
                        nf: p.lancamento.nf || '',
                        valor: p.lancamento.valor ?? null,
                        arquivo: p.documento.arquivo || '',
                        caminho: p.documento.caminho || '',
                        periodoDocumento: p.periodoDocumento || periodo,
                        // Quantos meses o documento está distante da pasta do mês
                        // consultado. `null` = achado na própria pasta. Sem isto,
                        // "no mês" e "pasta vizinha" ficam indistinguíveis no
                        // export: `periodoDocumento` cai no período do lançamento
                        // quando o par é do mês, e a coluna vira só o mês da pasta.
                        deslocamento: p.deslocamento ?? null,
                        via: p.via,
                        forca: p.forca,
                        // Documento que `categoriaNaoFiscal` havia cortado e voltou pela
                        // repescagem (ver `admiteNoPareamento`): traz o RÓTULO da
                        // categoria, ou null. Não é nota fiscal — é comprovante de
                        // pagamento (PIX, guia do DETRAN, cheque) que prova fornecedor E
                        // valor. Quem confere merece saber que o papel é de outra
                        // natureza, mesmo o par sendo legítimo.
                        repescadoDe: p.documento.repescadoDe || null,
                        // Outro documento servia para este mesmo lançamento com força
                        // igual, e quem desempatou foi o nome do arquivo — não o mérito.
                        // A lista `listaEmpatados` já mostra isso, mas ela é truncada em
                        // MAX_EMPATES; aqui a marca vale para TODAS as linhas, que é o
                        // que a tela precisa para pintar a pílula e filtrar.
                        // `ehParcela` desconta o carnê, senão todo pagamento parcelado
                        // apareceria como ambíguo (ver a função).
                        empatado: !!p.empatado && !ehParcelamento(p),
                        // POR QUE empatou — o mesmo `motivoDoEmpate` que a tabela de
                        // empates já usava, agora também por linha, para a tela poder
                        // separar o empate que PEDE DECISÃO do que não pede.
                        //
                        // MEDIDO em 18/09/2026: dos 310 empates, 308 têm TODOS os
                        // candidatos do mesmo fornecedor e mesmo valor — num lote da
                        // BIOS NET, 12 arquivos de R$ 75,00 disputam 12 lançamentos de
                        // R$ 75,00 da BIOS NET. São intercambiáveis: qualquer atribuição
                        // está certa, e mandar conferir faz abrir 12 PDFs para não
                        // decidir nada. É a ordem de compra coletiva de §16.5.
                        // Só 2 empates são ambiguidade real entre fornecedores.
                        //
                        // `null` quando não há empate — a tela testa a presença.
                        motivoEmpate: (p.empatado && !ehParcelamento(p))
                            ? motivoDoEmpate(p).codigo : null,
                        // Conferência do par por um campo que NÃO casou: a data de
                        // emissão da planilha × a que o extrator leu da nota. Três
                        // estados — true = divergem (suspeito), false = coincidem
                        // (confirmado), null = falta uma das duas (sem opinião).
                        //
                        // MEDIDO em 15/09/2026 (`_medir/_data-como-sinal.js`): coincide
                        // em 70,7% dos pares de força 3 e em 3,3% dos de força 1. Dos
                        // 171 fracos, 122 têm as duas datas e 118 divergem — é a
                        // evidência independente de que o par por valor sozinho quase
                        // sempre é colisão de valor.
                        //
                        // Só ROTULA. Virar 4º sinal foi medido e reprovado
                        // (`_medir/_data-quarto-sinal.js`): −4 pares bons, +2 duvidosos.
                        emissaoDiverge: p.emissaoDiverge ?? null,
                        // Só os nomes, e no mesmo teto de 6 da lista de empates: quem
                        // precisa abrir o PDF usa aquela lista, que leva `caminho` e o
                        // botão. Levar caminho em ~2.100 linhas incharia o JSON à toa.
                        candidatosEmpatados: (p.candidatosEmpatados || []).slice(0, 6).map(x => x.arquivo),
                        // CFOP/Itens/valor da nota/código da receita, quando o parser
                        // achou — a tela abre isso ao clicar na linha. `null` quando o
                        // documento não tem nada desse tipo (a maioria: são campos de
                        // NF-e e guia de imposto).
                        detalhe: p.documento.detalhe || null,
                        ...localizacao(p.documento, periodo),
                    })),
                    // Resumo de localização: quantos estão no lugar, quantos em outra
                    // pasta por competência (normal) e quantos pedem ação.
                    porSituacao: [...r.pares, ...r.paresVizinhos].reduce((acc, p) => {
                        const s = localizacao(p.documento, periodo).situacao;
                        acc[s] = (acc[s] || 0) + 1;
                        return acc;
                    }, {}),
                    // Quantos vieram da pasta DESTE mês, e quantos de pasta vizinha.
                    noMes: r.pares.length,
                    emPastaVizinha: r.paresVizinhos.length,
                    porPastaVizinha: r.paresVizinhos.reduce((acc, p) => {
                        acc[p.periodoDocumento] = (acc[p.periodoDocumento] || 0) + 1;
                        return acc;
                    }, {}),
                    fracos: r.fracos,                                // apoiados num sinal só
                    lancamentosSemDocumento: r.lancamentosSemDocumento,
                    // Líquido de irmãos: quem arquiva grava todos os papéis de um
                    // pagamento sob o mesmo prefixo NNN, na mesma pasta-dia (nota +
                    // pedido + autorização). O resto do maço não é documento sem
                    // dono, e contá-lo assim superestimava o que falta conciliar.
                    documentosSemLancamento: r.documentosSemLancamento,
                    documentosSemLancamentoBruto: r.documentosSemLancamentoBruto,
                    irmaosAgrupados: r.irmaosAgrupados,
                    // Pares em que outro documento disputava o mesmo lançamento com
                    // força igual — o desempate é alfabético, então é onde o olho
                    // humano decide melhor que a regra. Ver `parear` em _pareamento.js.
                    ...empatesParaTela([...r.pares, ...r.paresVizinhos]),
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
                    // Segunda pergunta: dos que TÊM documento, em quantos o valor
                    // arquivado difere do lançado. Vizinhos entram junto — o par é
                    // o mesmo, só a pasta é outra.
                    ...divergenciasDeValor([...r.pares, ...r.paresVizinhos]),
                };
                console.log(`[comparar-notas] ${periodo}: pareamento ${conferencia.conferidos} de ` +
                    `${lancamentos.length} lançamentos (${r.pares.length} no mês, ` +
                    `${r.paresVizinhos.length} em pasta vizinha, ${r.fracos} fracos, ` +
                    `${conferencia.divergentes} com valor divergente) ` +
                    `em ${conferencia.ms} ms`);
            } catch (e) {
                console.error('[comparar-notas] pareamento falhou:', e.message);
                conferencia = { disponivel: false, motivo: e.message };
            }
        }

        console.log(`[comparar-notas] ${periodo}: pasta ${pasta.total}, banco ${banco.total}, planilha ${planilha.total}`);

        return res.json({ success: true, mes, ano, periodo, pasta, banco, planilha, conferencia, pdfs });

    } catch (e) {
        console.error('[comparar-notas] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
