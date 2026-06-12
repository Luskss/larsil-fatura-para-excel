/**
 * routes/comparar-notas.js
 * POST /api/comparar-notas  body: { mes, ano }
 * Compara notas da planilha Delsoft com o que foi processado no banco.
 * Faz match por: Nº NF + Emitente (fuzzy) + Valor (tolerância 0.02)
 */
'use strict';
const TOLERANCIA_DIAS_PRINCIPAL = 3;
const { getConnection } = require('../config');
const { setFullSecurityHeaders, requireAuth } = require('./_helpers');
const XLSX = require('xlsx');
const fs = require('fs');

function norm(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normVal(v) {
    // Valor absoluto: a planilha guarda despesas/saídas como negativo (ex.: -110.20),
    // enquanto o PDF traz o valor positivo. Comparamos sempre pela magnitude.
    return parseFloat(Math.abs(parseFloat(v || 0)).toFixed(2));
}

function excelDateToMonthYear(serial) {
    if (!serial || typeof serial !== 'number') return null;
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return { mes: date.getUTCMonth() + 1, ano: date.getUTCFullYear() };
}

function excelDateToStr(serial) {
    if (!serial || typeof serial !== 'number') return '—';
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return `${String(date.getUTCDate()).padStart(2,'0')}/${String(date.getUTCMonth()+1).padStart(2,'0')}/${date.getUTCFullYear()}`;
}

// Serial Excel → timestamp em ms (UTC, meia-noite). null se inválido.
function excelDateToMs(serial) {
    if (!serial || typeof serial !== 'number') return null;
    return Math.round((serial - 25569) * 86400 * 1000);
}

// Converte "DD/MM/AAAA" (ou DD-MM-AAAA, DD.MM.AAAA) extraída de PDF → timestamp ms (UTC).
// Aceita ano com 2 dígitos. null se não parsear.
function brDateToMs(str) {
    const m = String(str || '').match(/([0-3]?\d)[\/.-]([01]?\d)[\/.-](\d{2,4})/);
    if (!m) return null;
    let [, d, mo, y] = m;
    y = y.length === 2 ? '20' + y : y;
    const ts = Date.UTC(+y, +mo - 1, +d);
    return isNaN(ts) ? null : ts;
}

// Diferença absoluta em dias inteiros entre dois timestamps (ms).
function diffDias(msA, msB) {
    if (msA == null || msB == null) return null;
    return Math.round(Math.abs(msA - msB) / 86400000);
}

const MESES_PT = ['', 'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
// "4.2026" ou "04.2026" → "Abril/2026"
function nomeMesPeriodo(periodo) {
    const [m, a] = String(periodo).split('.');
    const mi = parseInt(m, 10);
    return (MESES_PT[mi] || m) + '/' + a;
}

// Remove sufixos societários e ruído para comparar o "miolo" do nome da empresa.
// Ex.: "ELEKTRO REDES S.A. 02.328.280/0001-97" → "ELEKTRO REDES"
function nucleoEntidade(s) {
    return norm(s)
        .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}\b/g, ' ') // CNPJ
        .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, ' ')             // CPF
        .replace(/\b(S\/?A|S\.?A\.?|LTDA|ME|EPP|EIRELI|CIA|COMPANHIA|REDES?|DISTRIBUIDORA|COMERCIO|COM|IND(USTRIA)?|SERVICOS?|S\.A|EI)\b/g, ' ')
        .replace(/[.,\/\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function entidadeMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // 1) Comparação por prefixo de palavras (lógica original)
    const wa = na.split(' ').slice(0, 3).join(' ');
    const wb = nb.split(' ').slice(0, 3).join(' ');
    if (wa === wb || na.includes(wb) || nb.includes(wa)) return true;

    // 2) Comparação pelo "núcleo" (sem CNPJ/CPF e sufixos societários).
    //    Resolve "ELEKTRO" vs "ELEKTRO REDES S.A. 02.328.280/0001-97".
    const ca = nucleoEntidade(a), cb = nucleoEntidade(b);
    if (ca && cb) {
        if (ca === cb) return true;
        if (ca.includes(cb) || cb.includes(ca)) return true;
    }
    return false;
}

const TOL_VAL = 0.02;

// VALIDA o valor do banco contra a nota da planilha. Considera correto se o valor
// do banco bate com QUALQUER um destes da planilha:
//   • VL_TOTAL_CAB (total do cabeçalho)
//   • soma dos VL_ITEM (itens da nota)
//   • um VL_ITEM individual (uma parcela específica)
//   • uma FRAÇÃO total ÷ N (compra parcelada: banco traz 1 parcela, planilha o total)
// Retorna { ok, base } onde base descreve com qual valor casou (p/ mensagem).
const MAX_PARCELAS = 24;
function valorBate(valorBanco, nota) {
    if (!(valorBanco > 0)) return { ok: false, base: null };
    if (nota.valor > 0 && Math.abs(valorBanco - nota.valor) <= TOL_VAL)
        return { ok: true, base: 'cabeçalho' };
    if (nota.valorItem > 0 && Math.abs(valorBanco - nota.valorItem) <= TOL_VAL)
        return { ok: true, base: 'soma itens' };
    if ((nota.itens || []).some(v => Math.abs(valorBanco - v) <= TOL_VAL))
        return { ok: true, base: 'parcela' };
    // Parcelamento: o banco traz UMA parcela (≈ total ÷ N) e a planilha o total.
    // Folga de ~1,5 centavo por parcela cobre o arredondamento (centavos vão p/ a 1ª/última).
    if (nota.valor > valorBanco) {
        for (let n = 2; n <= MAX_PARCELAS; n++) {
            if (Math.abs(valorBanco * n - nota.valor) <= n * 0.015 + TOL_VAL)
                return { ok: true, base: `parcela ${n}x` };
        }
    }
    return { ok: false, base: null };
}

// VALIDA o tipo. Só compara quando a planilha tem um TIPO mapeável (tipoBanco)
// e o banco classificou algo conhecido. Retorna true se compatível ou se não há
// base para comparar (não inventa divergência).
function tipoBate(tipoBanco, nota, rowB) {
    const tb = norm(tipoBanco);
    const tp = norm(nota.tipoBanco);
    if (tp === '*') return true; // 'RECIBO E OUTROS' (guarda-chuva) aceita qualquer tipo
    if (!tp || !tb || tb === 'NÃO IDENTIFICADO') return true; // sem base p/ comparar
    if (tb === tp) return true;
    // NF (produto) e NFS (serviço) são intercambiáveis: a planilha Delsoft costuma
    // lançar nota de serviço como "NOTA FISCAL RFB" (→ NF), então não é divergência.
    if ((tb === 'NF' || tb === 'NFS') && (tp === 'NF' || tp === 'NFS')) return true;
    // Fatura em lote (FT no nome do arquivo): um boleto/duplicata que paga em lote
    // NFS-e/NF-e anexas. A planilha lança como FATURA, mas o PDF é classificado como
    // NFS/NF pelo conteúdo. Só vale para docs "FT..." → não afeta notas normais.
    if (tp === 'FATURA' && (tb === 'NF' || tb === 'NFS') && ehFaturaLote(rowB)) return true;
    return false;
}

// "Fatura em lote": doc do banco cujo NOME traz número de FATURA (FT.../FATURA) — um
// boleto que paga em lote uma ou mais NFS-e/NF-e anexas (ex.: FT9476 = NFS-e 58676 +
// NF-e 20294). Marcador exclusivo dessa convenção: o "FT" no nome do arquivo.
function ehFaturaLote(rowB) {
    const arq = String((rowB && rowB.arquivo) || '').replace(/#p\d+$/i, '').toUpperCase();
    return /\bFT\s*\.?\s*\d/.test(arq) || /\bFATURA\b/.test(arq);
}

// ── Cache da planilha ─────────────────────────────────────────────────────────
// Guarda as notas já parseadas e indexadas por "mes.ano", recalculando só quando
// o arquivo for modificado (mtime diferente). Assim, percorrer/normalizar todas as
// linhas e converter datas Excel acontece uma única vez, não a cada comparação.
const planilhaCache = { path: null, mtime: 0, porPeriodo: null, porNF: null, porVal: null };

// Mapeia o TIPO textual da planilha Delsoft → categoria do banco (classify).
// Usado APENAS para VALIDAR (não para achar). TIPOs sem equivalente fiscal
// (PREVISAO, FINANC*, DUPLICATA, etc.) retornam '' → validação de tipo é pulada.
function tipoPlanilhaParaBanco(tipoPlanilha) {
    const t = norm(tipoPlanilha);
    if (t === 'NOTA FISCAL RFB')      return 'NF';
    if (t === 'NOTA FISCAL SERVICO')  return 'NFS';
    if (t === 'FATURA')               return 'FATURA';
    if (t === 'IMPOSTO')              return 'IMPOSTO';
    // 'RECIBO E OUTROS' é categoria guarda-chuva do Delsoft (engloba recibo, consórcio,
    // imposto, NF avulsa, etc.) → '*' aceita qualquer tipo do banco sem divergência.
    if (t === 'RECIBO E OUTROS')      return '*';
    return ''; // sem equivalente → não valida tipo
}

// Detecta lançamentos da planilha que não correspondem a notas fiscais e devem ser
// ignorados na conferência — atualmente cartões de crédito. A NF desses lançamentos
// é um código contábil (CC117, CR.LAR...) e a entidade traz "CAR/CARTAO CRED".
// `nf` é o valor bruto da coluna NF; `ent` é a ENTIDADE já normalizada (norm()).
function isLancamentoIgnoravel(nf, ent) {
    const n = String(nf || '').toUpperCase().trim();
    const e = ent || '';
    // Código contábil de cartão: começa com "CC" + dígitos, ou "CR." / "CR " prefixando.
    const nfCartao = /^CC\d/.test(n) || /^CR[.\s]/.test(n);
    // Entidade de cartão de crédito.
    const entCartao = /\bCAR(TAO)?\s*CRED/.test(e) || /\bCARTAO\s+DE\s+CREDITO\b/.test(e);
    return nfCartao || entCartao;
}

// Lê a planilha e devolve { porPeriodo, porNF, porVal }:
//   porPeriodo → Map "mes.ano" → [nota, ...]   (por DT_LANCAMENTO)
//   porNF      → Map nfClean   → [nota, ...]   (todos os meses, p/ fallback por NF)
//   porVal     → Map valor*100 → [nota, ...]   (todos os meses, p/ fallback por valor)
// Resultado é cacheado por mtime do arquivo.
function lerPlanilhaIndexada(planilhaPath) {
    const mtime = fs.statSync(planilhaPath).mtimeMs;
    if (planilhaCache.path === planilhaPath && planilhaCache.mtime === mtime && planilhaCache.porPeriodo) {
        return { porPeriodo: planilhaCache.porPeriodo, porNF: planilhaCache.porNF, porVal: planilhaCache.porVal };
    }

    const wb = XLSX.readFile(planilhaPath, { cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const header = rows[1] || [];

    const idxNF          = header.indexOf('NF');
    const idxEntidade    = header.indexOf('ENTIDADE');
    const idxValor       = header.indexOf('VL_TOTAL_CAB');
    const idxValItem     = header.indexOf('VL_ITEM');       // valor do item (somado por NF)
    const idxEmissao     = header.indexOf('DT_EMISSAO');
    const idxData        = header.indexOf('DATA');          // data do documento (p/ alerta de divergência)
    const idxLancamento  = header.indexOf('DT_LANCAMENTO'); // data de pagamento/lançamento
    const idxVencimento  = header.indexOf('DT_VENCIMENTO'); // vencimento do título/boleto
    const idxLancOrig    = header.indexOf('LANC_ORIG');     // lançamento de origem
    const idxFilial      = header.indexOf('FILIAL');
    const idxTipo        = header.indexOf('TIPO');
    const idxOrig        = header.indexOf('ORIG');

    // Agrupa por DT_LANCAMENTO (data do pagamento efetivo, alinhada ao mês do banco).
    // DT_EMISSAO é mantida apenas para exibição e detecção de data divergente.
    // Falls back para DT_EMISSAO se DT_LANCAMENTO ausente.
    const porPeriodo = new Map();   // "mes.ano" → [nota, ...]  (por DT_LANCAMENTO)
    const porNF = new Map();        // nfClean   → [nota, ...]  (todos os meses)
    const porVal = new Map();       // valor*100  → [nota, ...]  (todos os meses, p/ fallback sem NF)
    // Agrupa itens da MESMA nota (mesma NF+entidade+período) para somar VL_ITEM.
    // Ex.: NF 311 com vários itens → uma nota com valorItem = soma de todos.
    const notaPorChave = new Map(); // "periodo|nf|ent" → nota

    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.length) continue;

        // Filtro pedido: considerar APENAS lançamentos de Conta a Pagar (ORIG = 'CP').
        const orig = norm(row[idxOrig]);
        if (orig !== 'CP') continue;

        const dtEmissao = excelDateToMonthYear(row[idxEmissao]);
        const dtLanc    = excelDateToMonthYear(row[idxLancamento]) || dtEmissao;
        if (!dtLanc) continue;

        const periodo = `${String(dtLanc.mes).padStart(2,'0')}.${dtLanc.ano}`; // agrupamento por lançamento

        const nf  = String(row[idxNF] || '').trim();
        const ent = norm(row[idxEntidade]);

        // Lançamentos de cartão de crédito (CR.../CC..., "CAR CRED"/"CARTAO CRED")
        // são lançamentos contábeis da planilha que NUNCA têm nota fiscal no banco.
        // Ignoramos de vez para não poluírem o "faltando no banco".
        if (isLancamentoIgnoravel(nf, ent)) continue;

        const valItem = idxValItem >= 0 ? normVal(row[idxValItem]) : 0;
        const chave = `${periodo}|${nf}|${ent}`;
        const existente = notaPorChave.get(chave);

        if (existente) {
            // Mesma nota, item adicional: acumula VL_ITEM (caso da NF com vários itens).
            existente.valorItem = parseFloat((existente.valorItem + valItem).toFixed(2));
            if (valItem > 0) existente.itens.push(valItem); // p/ validar parcela individual
            continue;
        }

        const tipoStr = norm(row[idxTipo]);
        const nota = {
            nf, entidade: ent,
            nfClean: nf.replace(/^[A-Za-z]+/, '').replace(/^0+/, '') || nf.replace(/^0+/, ''),
            valor:     normVal(row[idxValor]),            // VL_TOTAL_CAB (cabeçalho da nota)
            valorItem: valItem,                            // soma de VL_ITEM (itens da nota)
            itens:     valItem > 0 ? [valItem] : [],       // VL_ITEM individuais (validar parcela)
            emissao: excelDateToStr(row[idxEmissao]),     // data de emissão (exibição)
            dataStr: idxData >= 0 ? excelDateToStr(row[idxData]) : '—',
            dataMs:  idxData >= 0 ? excelDateToMs(row[idxData]) : null, // DATA (p/ alerta de divergência)
            lancStr: idxLancamento >= 0 ? excelDateToStr(row[idxLancamento]) : '—',
            lancamentoMs: excelDateToMs(row[idxLancamento]), // p/ agrupamento por período
            periodo,                                       // período de lançamento (agrupamento)
            periodoEmissao: dtEmissao ? `${String(dtEmissao.mes).padStart(2,'0')}.${dtEmissao.ano}` : periodo,
            filial:  norm(row[idxFilial]),
            tipo:    tipoStr,                              // TIPO textual da planilha (exibição)
            tipoBanco: tipoPlanilhaParaBanco(tipoStr),     // categoria equivalente p/ validar
            orig,
            lancOrig: idxLancOrig >= 0 ? norm(row[idxLancOrig]) : '',
            vencimento:   idxVencimento >= 0 ? excelDateToStr(row[idxVencimento]) : '—',
            vencimentoMs: idxVencimento >= 0 ? excelDateToMs(row[idxVencimento]) : null,
        };
        notaPorChave.set(chave, nota);

        if (!porPeriodo.has(periodo)) porPeriodo.set(periodo, []);
        porPeriodo.get(periodo).push(nota);

        if (nota.nfClean) {
            let arr = porNF.get(nota.nfClean);
            if (!arr) { arr = []; porNF.set(nota.nfClean, arr); }
            arr.push(nota);
        }
        if (nota.valor > 0) {
            const vk = Math.round(nota.valor * 100);
            let arr = porVal.get(vk);
            if (!arr) { arr = []; porVal.set(vk, arr); }
            arr.push(nota);
        }
    }

    planilhaCache.path       = planilhaPath;
    planilhaCache.mtime      = mtime;
    planilhaCache.porPeriodo = porPeriodo;
    planilhaCache.porNF      = porNF;
    planilhaCache.porVal     = porVal;
    console.log(`[comparar-notas] planilha reindexada (${rows.length} linhas, ${porPeriodo.size} períodos, ${porNF.size} NFs)`);
    return { porPeriodo, porNF, porVal };
}

// Mescla vários CSVs de relatório (cada um com seu header) num único CSV:
// mantém o header do primeiro e concatena as linhas de dados de todos.
// Usado ao comparar dias específicos (junta os D-DD.MM.AAAA num só conjunto).
function mesclarCsv(csvs) {
    const limpos = (csvs || []).filter(c => c && c.trim());
    if (limpos.length === 0) return '';
    if (limpos.length === 1) return limpos[0];
    let header = null;
    const dados = [];
    for (const csv of limpos) {
        const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (lines.length === 0) continue;
        if (!header) header = lines[0];
        dados.push(...lines.slice(1));
    }
    return '﻿' + [header, ...dados].join('\r\n');
}

// ── Cache do banco por período ────────────────────────────────────────────────
// Parsear o CSV do banco (incl. JSON.parse por linha) e montar o índice por NF é
// custoso. Cacheamos por período + comprimento do conteúdo: se o relatório do mês
// for regravado, o tamanho muda e o cache é invalidado automaticamente.
const bancoCache = new Map(); // periodo → { len, indiceNF, total }

function indexarBanco(periodo, csv) {
    const len = csv ? csv.length : 0;
    const hit = bancoCache.get(periodo);
    if (hit && hit.len === len) return hit;

    const indiceNF  = new Map();   // nf            → [rowB, ...]
    const indiceVal = new Map();   // valor*100|int → [rowB, ...]  (p/ fallback sem NF)
    const indiceOCP = new Map();   // ocp           → [rowB, ...]  (ordem de compra)
    const linhas    = [];          // todos os docs do banco (incl. sem NF, só OCP)
    let total = 0;

    if (csv) {
        const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (lines.length > 1) {
            const cols = lines[0].split(';');
            const idxA = cols.indexOf('arquivo');
            const idxP = cols.indexOf('pasta');
            const idxT = cols.indexOf('tipo');
            const idxD = cols.indexOf('dados_parser');
            for (let i = 1; i < lines.length; i++) {
                const rowB = parseCsvLine(lines[i], idxA, idxP, idxT, idxD);
                linhas.push(rowB);
                total++;
                if (rowB.nf) {
                    let arr = indiceNF.get(rowB.nf);
                    if (!arr) { arr = []; indiceNF.set(rowB.nf, arr); }
                    arr.push(rowB);
                }
                // Indexa também pelo nº do nome do arquivo (fatura "guarda-chuva"), quando
                // difere do nº primário — permite casar via fatura mesmo se a IA gravou a
                // NFS-e/NF-e anexa. O guard de entidade/valor no match evita falso positivo.
                if (rowB.nfAlt && rowB.nfAlt !== rowB.nf) {
                    let arr = indiceNF.get(rowB.nfAlt);
                    if (!arr) { arr = []; indiceNF.set(rowB.nfAlt, arr); }
                    arr.push(rowB);
                }
                if (rowB.ocp) {
                    let arr = indiceOCP.get(rowB.ocp);
                    if (!arr) { arr = []; indiceOCP.set(rowB.ocp, arr); }
                    arr.push(rowB);
                }
                if (rowB.valor > 0) {
                    const vk = Math.round(rowB.valor * 100);
                    let arr = indiceVal.get(vk);
                    if (!arr) { arr = []; indiceVal.set(vk, arr); }
                    arr.push(rowB);
                }
            }
        }
    }

    const entry = { len, indiceNF, indiceOCP, indiceVal, linhas, total };
    bancoCache.set(periodo, entry);
    return entry;
}

// Remove sufixo de parcela (#p1, #p2...) adicionado a boletos multi-parcela.
function arquivoBase(s) { return String(s || '').replace(/#p\d+$/i, ''); }

// ── Helpers de extração — recebem o parser já parseado (ou null) ──────────────
// Número extraído SÓ do nome do arquivo (sem olhar o parser). Usado como chave
// alternativa de match: a IA às vezes grava o nº de um sub-documento do pacote
// (ex.: NFS-e 1639) enquanto o nome traz o nº da fatura "guarda-chuva" (FT11610).
function extrairNFDoArquivo(arquivo) {
    const arq = arquivoBase(arquivo);
    // Com marcador explícito (RCB/RC/FAT/FT/NF etc.) — aceita 1+ dígitos
    const m = arq.match(/\b(?:NFS?|NF-?e|CTE|CT-?e|RCB|RC|FAT|FT)\s*\.?\s*(\d+)/i);
    if (m) return m[1].replace(/^0+/, '') || m[1];
    // Sem marcador: último bloco numérico isolado antes da extensão (ex: "SANESUL . 503843.pdf")
    // Exige pelo menos 3 dígitos para evitar falso positivo com anos/valores do nome
    const mSem = arq.replace(/\.pdf$/i, '').match(/[.\s](\d{3,})\s*$/i);
    if (mSem) return mSem[1].replace(/^0+/, '') || mSem[1];
    return '';
}

function extrairNFDeParsed(parser, arquivo) {
    if (parser) {
        const nf = parser['Nº da NF-e'] || parser['Nº do CT-e'] || parser['Número do documento'] || '';
        const clean = String(nf).replace(/\D/g, '');
        if (clean) return clean.replace(/^0+/, '');
    }
    return extrairNFDoArquivo(arquivo);
}

function extrairOCPDeParsed(parser, arquivo) {
    if (parser) {
        const ocp = parser['Ordem de Compra'] || parser['ordemCompra'] || '';
        const clean = String(ocp).replace(/\D/g, '');
        if (clean) return clean.replace(/^0+/, '');
    }
    // Tenta extrair do nome do arquivo: "OCP 900699", "OC 900699"
    const m = arquivoBase(arquivo).match(/\bOC[P]?\s*[-#.]?\s*(\d{4,})/i);
    if (m) return m[1].replace(/^0+/, '');
    return '';
}

function extrairEmitenteDeParsed(parser, arquivo) {
    if (parser) {
        const e = parser['Razão social emitente'] || parser['Emitente'] || parser['Nome fantasia'] || '';
        if (e) return e;
    }
    const nome = arquivoBase(arquivo).replace(/\.pdf$/i, '').trim();

    // Padrão 1: "YYYY.MM.DD , EMITENTE , NF NNNNN"  (formato legado com data ISO)
    const m1 = nome.match(/\d{4}\.\d{2}\.\d{2}\s*[.,]?\s*(.+?)\s*[.,]?\s*\b(?:NFS?|NF-?e|CTE|CT-?e|RCB|RC|FAT|FT)\s*\.?\s*\d/i);
    if (m1) return m1[1].replace(/[.,\s]+$/, '').trim();

    // Padrão 2: "NNN.DOC- valor - data. EMITENTE. NF NNNNN"  (ex.: "037.DOC- 1780,00 - 202605.15. CAMPNEUS. NF 23773 + BOL")
    const m2 = nome.match(/\bDOC[-\s]+[\d.,]+\s*[-–]\s*[\d.]+\s*[.,]\s*(.+?)\s*[.,]?\s*\bNF\s+\d/i);
    if (m2) return m2[1].replace(/[.,\s]+$/, '').trim();

    // Padrão 3: "NNN.DOC- valor - YYYY-MM-DD- EMITENTE - NF NNNNN"  (ex.: "006.DOC- 72,66-2026-05-17- COMERCIAL IVAIPORA - NF 138719")
    const m3 = nome.match(/\bDOC[-\s]+[\d.,]+[-–]\d{4}-\d{2}-\d{2}[-–\s]+(.+?)\s*[-–]\s*NF\s+\d/i);
    if (m3) return m3[1].replace(/[.,\s]+$/, '').trim();

    return '';
}

// Data do documento extraída do nome do arquivo (YYYY.MM.DD ou DD.MM.YYYY) → ms UTC.
// Usada como fallback quando não há NF/OCP para casar com DT_LANCAMENTO da planilha.
function extrairDataDoArquivo(arquivo) {
    const n = arquivoBase(arquivo);
    let m = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return null;
}

// Data de vencimento do boleto extraída pelo parser (DANFE/CTE/IMPOSTO).
function extrairVencimentoDeParsed(parser) {
    if (!parser) return '';
    const v = parser['Data de vencimento'] || parser['Data de Vencimento'] || '';
    return v && v !== '—' ? String(v).trim() : '';
}

function extrairValorDeParsed(parser, arquivo) {
    if (parser) {
        const rawVal = parser['Valor total'] || parser['Total da NF-e'] || parser['Valor'] || '';
        if (rawVal) {
            const num = parseFloat(String(rawVal).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
            if (!isNaN(num) && num > 0) return normVal(num);
        }
    }
    const m = arquivoBase(arquivo).match(/DOC[-\s]*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i);
    if (m) {
        const num = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
        if (!isNaN(num)) return normVal(num);
    }
    return 0;
}

// ── Parse CSV do banco uma vez por linha ─────────────────────────────────────
function parseCsvLine(line, idxArquivo, idxPasta, idxTipo, idxDadosParser) {
    const fields = [];
    let cur = '', inQ = false;
    
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                // Se for aspas duplas seguidas de aspas duplas (""), é o escape do CSV
                if (i + 1 < line.length && line[i + 1] === '"') {
                    cur += '"';
                    i++; // pula o próximo caractere pois já processamos
                } else {
                    inQ = false;
                }
            } else {
                cur += ch;
            }
        } else {
            if (ch === '"') inQ = true;
            else if (ch === ';') { fields.push(cur); cur = ''; } 
            else cur += ch;
        }
    }
    fields.push(cur);

    const arquivo     = fields[idxArquivo] ?? '';
    const dadosParser = fields[idxDadosParser] ?? '';

    // Parse JSON uma única vez por linha
    let parser = null;
    if (dadosParser) { 
        try { 
            parser = JSON.parse(dadosParser); 
        } catch (e) {
            console.error(`[comparar-notas] Erro ao fazer parse do JSON no arquivo ${arquivo}:`, e.message);
        } 
    }

    const venc = extrairVencimentoDeParsed(parser);
    const ehParcela = parser && parser['Parcela'];
    const dataMs = (ehParcela && venc) ? brDateToMs(venc) : extrairDataDoArquivo(arquivo);

    // nf  = número primário (parser, ou nome do arquivo se não houver parser).
    // nfAlt = número do NOME DO ARQUIVO quando difere do primário — chave de match
    //         alternativa (pacote multi-documento: parser pega a NFS-e, nome traz a fatura).
    const nf = extrairNFDeParsed(parser, arquivo);
    const nfArq = extrairNFDoArquivo(arquivo);
    const nfAlt = (nfArq && nfArq !== nf) ? nfArq : '';

    return {
        arquivo,
        pasta:       fields[idxPasta] ?? '',
        tipo:        fields[idxTipo]  ?? '',
        nf,
        nfAlt,
        ocp:         extrairOCPDeParsed(parser, arquivo),
        emitente:    norm(extrairEmitenteDeParsed(parser, arquivo)),
        valor:       extrairValorDeParsed(parser, arquivo),
        vencimento:  venc,
        dataMs,
    };
}
module.exports = async function compararNotasRoute(req, res) {
    setFullSecurityHeaders(res);
    if (!requireAuth(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Método não permitido.' });
    }

    try {
        const body = req.body || {};
        const mes  = parseInt(body.mes, 10);
        const ano  = parseInt(body.ano, 10);
        // dias: array opcional de DD (1-31). Vazio/ausente → mês inteiro.
        const dias = Array.isArray(body.dias)
            ? body.dias.map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 31)
            : [];
        const porDia = dias.length > 0;

        if (!mes || !ano) {
            return res.status(400).json({ success: false, message: 'Parâmetros mes e ano obrigatórios.' });
        }

        const planilhaPath = process.env.PLANILHA_PATH;
        if (!planilhaPath || !fs.existsSync(planilhaPath)) {
            return res.status(400).json({ success: false, message: 'Planilha não configurada.' });
        }

        const periodo = `${String(mes).padStart(2,'0')}.${ano}`;
        const pool = await getConnection();

        // ── 1) Lê planilha já indexada por período (cache por mtime) ─────────
        const { porPeriodo, porNF: planilhaPorNF, porVal: planilhaPorVal } = lerPlanilhaIndexada(planilhaPath);
        let notasPlanilha = porPeriodo.get(periodo) || [];
        // Filtro por dia: mantém só notas cujo DT_LANCAMENTO cai num dos dias pedidos.
        if (porDia) {
            const diasSet = new Set(dias);
            notasPlanilha = notasPlanilha.filter(n => {
                if (!n.lancamentoMs) return false;
                return diasSet.has(new Date(n.lancamentoMs).getUTCDate());
            });
        }

        // ── 2) Lê notas do banco ─────────────────────────────────────────────
        // Mês inteiro → relatório M. Dias específicos → concatena os D-DD.MM.AAAA.
        let csv;
        if (porDia) {
            const periodosD = dias.map(d => `${String(d).padStart(2,'0')}.${periodo}`); // DD.MM.AAAA
            const reqDb = pool.request();
            const ins = periodosD.map((p, i) => { reqDb.input(`d${i}`, p); return `@d${i}`; });
            const rs = await reqDb.query(
                `SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'D' AND PERIODO IN (${ins.join(',')})`
            );
            csv = mesclarCsv(rs.recordset.map(r => r.CONTEUDO));
            } else {
            const result = await pool.request()
                .input('tipo', 'M')
                .input('data', periodo)
                .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo AND PERIODO = @data');
            
            // CORREÇÃO: Junta todas as partes do relatório mensal (se houver mais de uma linha) no banco
            csv = mesclarCsv(result.recordset.map(r => r.CONTEUDO));
        }

        // ── 3+4) Parse do CSV do banco e índice por NF (cache por período) ───
        // Chave de cache distinta quando filtra por dia (conteúdo difere do mês).
        const cacheKey = porDia ? `${periodo}#D:${[...dias].sort((a,b)=>a-b).join(',')}` : periodo;
        const banco = indexarBanco(cacheKey, csv);
        const bancoIndiceNF = banco.indiceNF;

        console.log(`[comparar-notas] ${porDia ? `dias [${dias.join(',')}] ` : ''}planilha ${notasPlanilha.length} notas, banco ${banco.total} notas`);

        // ── 5) Compara ────────────────────────────────────────────────────────
        const encontradas    = [];
        const usadasBanco    = new Set(); // rows do banco que já casaram com a planilha
        const planilhaUsada  = new Set(); // notas da planilha já consumidas por algum match
        const tributos       = [];        // DAMs/guias de tributo — não existem como NF na planilha

        // DAMs e guias de tributo (GOVERNO, PREFEITURA) nunca constam na planilha como NF.
        // Identificados pela NF no range 9039xx/9049xx ou emitente contendo GOVERNO/PREFEITURA.
        function isTributo(rowB) {
            if (/^9039\d{2}$|^9049\d{2}$/.test(rowB.nf)) return true;
            const e = rowB.emitente.toUpperCase();
            return e.includes('GOVERNO') || e.includes('PREFEITURA');
        }

        // Lançamentos de cartão de crédito (código contábil "CC278" no nome do arquivo)
        // são lançamentos da planilha que NUNCA têm NF — ignoramos automaticamente.
        function isCartaoBanco(rowB) {
            const nome = arquivoBase(rowB.arquivo).toUpperCase();
            return /\bCC\s?\d{2,}\b/.test(nome) || /\bCART[ÃA]O\s+DE\s+CR[ÉE]DITO\b/.test(nome);
        }

        // MÊS PELO VENCIMENTO (opção A). A planilha Delsoft NÃO tem coluna de vencimento
        // (a coluna DATA espelha a emissão), então não dá para "alertar divergência de data".
        // Em vez disso usamos o VENCIMENTO que a IA extrai do documento (rowB.vencimento):
        // se ele cai no mês conferido, lançar a nota nesse mês está CORRETO mesmo que a
        // emissão seja de um mês anterior — não é divergência. Sem vencimento (ex.: parser
        // local de NF não extrai), mantém-se o comportamento por emissão.
        function vencimentoNoMes(rowB, periodo) {
            const ms = brDateToMs(rowB.vencimento);
            if (ms == null) return false;
            const d = new Date(ms);
            return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` === periodo;
        }

        // Verifica se o campo DATA da planilha cai no período consultado.
        // (A planilha não tem DT_VENCIMENTO; DATA é a data do documento — pode ser o
        // vencimento agendado quando DT_LANCAMENTO registra a entrada contábil.)
        // Usado em section 6: nota emitida em outro mês mas com DATA no mês atual
        // não é "outro mês" — é um pagamento lançado no vencimento correto.
        function planilhaVencNoMes(rowP, periodo) {
            const ms = rowP.dataMs;
            if (ms == null) return false;
            const d = new Date(ms);
            return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` === periodo;
        }

        // Notas da planilha consumidas por uma CONSOLIDAÇÃO: um único doc do banco
        // (fatura/duplicata) cujo valor é a SOMA de várias notas do MESMO emitente,
        // lançadas como linhas separadas na planilha (ex.: FT131313 R$308,32 = NF
        // 138719 + 138720 + 138750). Essas notas saem de "faltando no banco".
        const consolidadas = new Set();

        // Tenta explicar `valorBanco` como a SOMA de um subconjunto de notas NÃO usadas
        // do MESMO emitente no período (fatura consolidada). Heurística: só vale quando
        // 1 nota não basta — exige ≥2 notas e soma exata (folga ~2 centavos por nota,
        // p/ arredondamento). `notaObrigatoria`, se dada, precisa estar no subconjunto.
        // Limita a 12 candidatos (custo 2^N) e prefere o menor conjunto que fecha a soma.
        function acharConsolidacao(valorBanco, emitente, notaObrigatoria) {
            if (!(valorBanco > 0) || !emitente) return null;
            let pool = (porPeriodo.get(periodo) || []).filter(p =>
                p.valor > 0 && !planilhaUsada.has(p) && !consolidadas.has(p) &&
                p.entidade && entidadeMatch(emitente, p.entidade)
            );
            if (notaObrigatoria && !pool.includes(notaObrigatoria)) pool = [notaObrigatoria, ...pool];
            if (pool.length < 2) return null;
            pool = pool.slice(0, 12);
            const n = pool.length;
            const alvo = Math.round(valorBanco * 100);
            const baseIdx = notaObrigatoria ? pool.indexOf(notaObrigatoria) : -1;
            let melhor = null;
            for (let mask = 1; mask < (1 << n); mask++) {
                if (baseIdx >= 0 && !(mask & (1 << baseIdx))) continue;
                let soma = 0, cnt = 0;
                for (let i = 0; i < n; i++) if (mask & (1 << i)) { soma += Math.round(pool[i].valor * 100); cnt++; }
                if (cnt < 2) continue;
                if (Math.abs(soma - alvo) <= cnt * 2 + 1) {
                    if (!melhor || cnt < melhor.cnt) melhor = { mask, cnt };
                }
            }
            if (!melhor) return null;
            const out = [];
            for (let i = 0; i < n; i++) if (melhor.mask & (1 << i)) out.push(pool[i]);
            return out;
        }

        // Registra um match achado por NF/OCP, VALIDANDO tipo e valor.
        // O match já foi decidido por NÚMERO (NF ou OCP); aqui só validamos e geramos
        // os alertas de tipo/valor/data. Sempre conta como "encontrada".
        const registrarMatch = (nota, rowB, via) => {
            usadasBanco.add(rowB);
            planilhaUsada.add(nota);

            const partes = [];
            let valorDiverge = false, tipoDiverge = false;

            // VALIDA VALOR (cabeçalho / soma itens / parcela / fração total÷N)
            const vRes = valorBate(rowB.valor, nota);
            if (rowB.valor > 0 && !vRes.ok) {
                // Antes de marcar divergência: o doc do banco pode ser uma FATURA que
                // CONSOLIDA várias notas do mesmo emitente (valor = soma). Só tenta
                // quando o valor do banco é MAIOR que a nota (1 nota não explica o total).
                let grupo = null;
                if (rowB.valor > nota.valor + TOL_VAL)
                    grupo = acharConsolidacao(rowB.valor, rowB.emitente || nota.entidade, nota);
                if (grupo) {
                    for (const p of grupo) { planilhaUsada.add(p); consolidadas.add(p); }
                    const nfs = grupo.map(p => p.nf).filter(Boolean).join(', ');
                    partes.push(`ℹ Fatura consolida ${grupo.length} notas (${nfs}) — soma R$${rowB.valor.toFixed(2)}`);
                } else {
                    valorDiverge = true;
                    partes.push(`⚠ Valor: banco R$${rowB.valor.toFixed(2)} × planilha R$${nota.valor.toFixed(2)}` +
                        (nota.valorItem > 0 && Math.abs(nota.valorItem - nota.valor) > TOL_VAL ? ` (itens R$${nota.valorItem.toFixed(2)})` : ''));
                }
            } else if (vRes.ok && /^parcela \d+x$/.test(vRes.base || '')) {
                // Compra parcelada: informativo, não é divergência.
                partes.push(`ℹ Parcela ${vRes.base.match(/\d+/)[0]}x — banco R$${rowB.valor.toFixed(2)} × total planilha R$${nota.valor.toFixed(2)}`);
            }

            // VALIDA TIPO (banco classificado × TIPO da planilha mapeado)
            if (!tipoBate(rowB.tipo, nota, rowB)) {
                tipoDiverge = true;
                partes.push(`⚠ Tipo: banco ${rowB.tipo || '—'} × planilha ${nota.tipo || '—'}`);
            }

            // Sem alerta de divergência de data: a planilha não tem vencimento para comparar.
            // (O mês de lançamento da nota já é o mês conferido neste match.)
            const dataAlerta = false;

            if (via === 'ocp') partes.push(`Casado via Ordem de Compra (OCP ${rowB.ocp})`);
            else if (via === 'nf-cruzado') partes.push(`Casado por número cruzado (NF↔OCP)`);

            encontradas.push({
                ...nota,
                arquivo:    rowB.arquivo,
                pasta:      rowB.pasta,
                tipo:       rowB.tipo,           // tipo do BANCO (exibição)
                tipoPlanilha: nota.tipo,         // tipo textual da planilha
                valorBanco: rowB.valor,
                vencimentoBanco: rowB.vencimento || '—',
                lancOrig:   nota.lancOrig || '',
                dataAlerta, valorItemAlerta: valorDiverge, tipoDiverge,
                divergencia: partes.length ? partes.join(' · ') : null,
                matchVia:   via,
                status: (valorDiverge || tipoDiverge || dataAlerta) ? 'divergente' : 'ok',
            });
        };

        // ── ACHAR: somente por NF + OCP (os 2 números extraídos), sem repetição ──
        // Para cada nota da planilha, procura no banco um doc cujo NF ou OCP case
        // com o NF ou OCP da nota. A planilha não tem coluna OCP separada — seu campo
        // NF pode conter tanto a NF quanto a OCP; por isso casamos de forma cruzada:
        //   banco.nf == planilha.nf  |  banco.ocp == planilha.nf
        //   banco.nf == planilha.ocp |  banco.ocp == planilha.ocp   (ocp da planilha = nfClean)
        // Cada doc do banco e cada nota da planilha são usados UMA única vez.
        const naoEncontradas = [];
        for (const nota of notasPlanilha) {
            // Nota já absorvida por uma fatura consolidada (match anterior) → não reprocessa.
            if (planilhaUsada.has(nota)) continue;
            const chave = nota.nfClean;
            if (!chave) { naoEncontradas.push({ ...nota, status: 'faltando' }); continue; }

            // candidatos: docs do banco indexados por essa chave em NF ou OCP
            const porNFbanco  = bancoIndiceNF.get(chave) || [];
            const porOCPbanco = banco.indiceOCP.get(chave) || [];

            // Junta candidatos (dedup) e remove os já usados.
            const seen = new Set();
            let candidatos = [];
            for (const rowB of porNFbanco)  { if (!seen.has(rowB) && !usadasBanco.has(rowB)) { seen.add(rowB); candidatos.push({ rowB, via: 'nf' }); } }
            for (const rowB of porOCPbanco) { if (!seen.has(rowB) && !usadasBanco.has(rowB)) { seen.add(rowB); candidatos.push({ rowB, via: rowB.nf === chave ? 'nf' : 'ocp' }); } }

            // Guard universal: NFS-e municipal reseta numeração por emitente, então o
            // mesmo nº (ex.: NF 15) aparece em fornecedores diferentes. Quando há mais
            // de um candidato, mantém só os com entidade compatível para evitar casar
            // ROBSON DOBBINS (R$ 82,50) com JOHN LENON (R$ 1.500). Se nenhum bater por
            // entidade, deixa todos os candidatos passarem e o resultado vira divergente.
            if (candidatos.length > 0 && nota.entidade) {
                const compativeisEntidade = candidatos.filter(c => 
                    !c.rowB.emitente || entidadeMatch(c.rowB.emitente, nota.entidade)
                );

                if (compativeisEntidade.length > 0) {
                    // Achou empresas com nomes compatíveis
                    candidatos = compativeisEntidade;
                } else {
                    // Nomes incompatíveis: Só deixa passar se o valor bater com tolerância
                    candidatos = candidatos.filter(c => valorBate(c.rowB.valor, nota).ok);
                }
            }

            // escolhe o melhor candidato livre, priorizando o que VALIDA valor+tipo
            let melhor = null;
            for (const c of candidatos) {
                const vOk = valorBate(c.rowB.valor, nota).ok;
                const tOk = tipoBate(c.rowB.tipo, nota, c.rowB);
                const score = (vOk ? 2 : 0) + (tOk ? 1 : 0);
                if (!melhor || score > melhor.score) melhor = { rowB: c.rowB, via: c.via, score };
            }

            if (melhor) registrarMatch(nota, melhor.rowB, melhor.via);
            else        naoEncontradas.push({ ...nota, status: 'faltando' });
        }

        // ── 6) Notas do banco que não casaram com nenhuma da planilha ─────────
        // (estão no banco/foram processadas, mas não constam na planilha Delsoft)
        // Fallback global: a nota pode existir na planilha em OUTRO mês — a planilha
        // usa data de emissão, e o PDF é arquivado pela data de recebimento. Por isso
        // checamos a planilha inteira (planilhaPorNF) por NF + valor antes de marcar.
        const faltandoPlanilha = [];
        {
            for (const rowB of banco.linhas) {
                if (usadasBanco.has(rowB)) continue;

                // Cartão de crédito (CC278 etc.) — lançamento contábil, nunca é NF. Ignora.
                if (isCartaoBanco(rowB)) {
                    usadasBanco.add(rowB);
                    continue;
                }

                // Tributos (DAM/GOVERNO/PREFEITURA) não constam como NF na planilha — aba própria.
                if (isTributo(rowB)) {
                    usadasBanco.add(rowB);
                    tributos.push({
                        nf:      rowB.nf,
                        entidade: rowB.emitente,
                        valor:   rowB.valor,
                        arquivo: rowB.arquivo,
                        pasta:   rowB.pasta,
                        tipo:    rowB.tipo,
                        status:  'tributo',
                    });
                    continue;
                }

                // Busca GLOBAL por número (NF ou OCP) na planilha inteira — a nota pode
                // existir em OUTRO mês (planilha usa emissão; PDF arquivado por recebimento).
                // Mantém a regra: achar SÓ por número. Tenta NF, nº do nome (fatura) e OCP.
                const chavesBanco = [...new Set([rowB.nf, rowB.nfAlt, rowB.ocp].filter(Boolean))];
                let naPlanilha = null;
                for (const ch of chavesBanco) {
                    let cands = (planilhaPorNF.get(ch) || []).filter(p => !planilhaUsada.has(p));
                    if (!cands.length) continue;
                    // Mesmo guard universal da seção 5: NFS-e/fatura reusa numeração entre
                    // emitentes (e a IA às vezes extrai o nº errado — ex.: FT11610 lido como
                    // NF 1639). Quando o banco tem emitente, mantém só candidatos com entidade
                    // compatível; se NENHUM bate por entidade, só aceita quem bate por VALOR.
                    // Sem isso, AGRIPONTA (R$4125) casaria com V M CARNEIRO (R$2331) só pela NF.
                    if (rowB.emitente) {
                        const compat = cands.filter(p => !p.entidade || entidadeMatch(rowB.emitente, p.entidade));
                        if (compat.length > 0) cands = compat;
                        else cands = cands.filter(p => valorBate(rowB.valor, p).ok);
                    }
                    if (cands.length) { naPlanilha = cands[0]; break; }
                }
                // Fallback por data+emitente: só quando o doc do banco não tem NF nem OCP.
                // Critério: DT_LANCAMENTO da planilha dentro de ±3 dias da data do arquivo
                // E emitente compatível (quando disponível). Busca apenas no mês.
                // Não usa valor para evitar falsos positivos com números curtos (6, 111...).
                const TOL_DIAS_FALLBACK = 3;
                if (!naPlanilha && !rowB.nf && !rowB.ocp && rowB.dataMs != null) {
                    const candidatos = (porPeriodo.get(`${String(mes).padStart(2,'0')}.${ano}`) || []);
                    for (const p of candidatos) {
                        if (planilhaUsada.has(p)) continue;
                        if (p.lancamentoMs == null) continue;

                        const diff = diffDias(rowB.dataMs, p.lancamentoMs);
                        if (diff == null || diff > TOL_DIAS_FALLBACK) continue;
                        // Requer emitente em AMBOS os lados — sem emitente no banco não há como confirmar
                        if (!rowB.emitente || !p.entidade) continue;
                        if (!entidadeMatch(rowB.emitente, p.entidade)) continue;
                        
                        if (!valorBate(rowB.valor, p).ok) continue;
                        naPlanilha = p;
                        break;
                    }
                }

                if (naPlanilha) {
                    planilhaUsada.add(naPlanilha);
                    usadasBanco.add(rowB);
                    // Opção A — mês pelo vencimento: se o vencimento (extraído pela IA do
                    // documento OU do campo DT_VENCIMENTO da planilha) cai no mês conferido,
                    // lançar a nota nesse mês está correto mesmo com emissão de mês anterior.
                    const vencBancoNoMes     = vencimentoNoMes(rowB, periodo);
                    const vencPlanilhaNoMes  = planilhaVencNoMes(naPlanilha, periodo);
                    const vencNoMes          = vencBancoNoMes || vencPlanilhaNoMes;
                    const emissaoOutroMes = (naPlanilha.periodoEmissao || naPlanilha.periodo) !== periodo;
                    const outroMes = emissaoOutroMes && !vencNoMes;
                    const via = chavesBanco.length === 0 ? 'data' : 'nf-global';
                    const partes = [];

                    // VALIDA VALOR e TIPO (mesma regra das encontradas do mês)
                    const vRes = valorBate(rowB.valor, naPlanilha);
                    let valorDiverge = rowB.valor > 0 && !vRes.ok;
                    // Antes de marcar divergência: a fatura do banco pode CONSOLIDAR várias
                    // notas do mesmo emitente (valor = soma). naPlanilha é só uma delas.
                    if (valorDiverge && rowB.valor > naPlanilha.valor + TOL_VAL) {
                        const grupo = acharConsolidacao(rowB.valor, rowB.emitente || naPlanilha.entidade, naPlanilha);
                        if (grupo) {
                            for (const p of grupo) { planilhaUsada.add(p); consolidadas.add(p); }
                            const nfs = grupo.map(p => p.nf).filter(Boolean).join(', ');
                            partes.push(`ℹ Fatura consolida ${grupo.length} notas (${nfs}) — soma R$${rowB.valor.toFixed(2)}`);
                            valorDiverge = false;
                        }
                    }
                    if (valorDiverge) partes.push(`⚠ Valor: banco R$${rowB.valor.toFixed(2)} × planilha R$${naPlanilha.valor.toFixed(2)}`);
                    else if (vRes.ok && /^parcela \d+x$/.test(vRes.base || '')) partes.push(`ℹ Parcela ${vRes.base.match(/\d+/)[0]}x — banco R$${rowB.valor.toFixed(2)} × total planilha R$${naPlanilha.valor.toFixed(2)}`);
                    const tipoDiverge = !tipoBate(rowB.tipo, naPlanilha, rowB);
                    if (tipoDiverge) partes.push(`⚠ Tipo: banco ${rowB.tipo || '—'} × planilha ${naPlanilha.tipo || '—'}`);
                    const dataAlerta = false; // planilha não tem vencimento p/ alertar divergência de data
                    if (outroMes) partes.push(`Lançada em ${nomeMesPeriodo(periodo)}, emitida em ${naPlanilha.emissao} (${nomeMesPeriodo(naPlanilha.periodoEmissao || naPlanilha.periodo)})`);
                    else if (emissaoOutroMes && vencBancoNoMes) partes.push(`ℹ Vence em ${nomeMesPeriodo(periodo)} — emitida em ${naPlanilha.emissao}, vencimento ${rowB.vencimento}`);
                    else if (emissaoOutroMes && vencPlanilhaNoMes) partes.push(`ℹ Vence em ${nomeMesPeriodo(periodo)} (planilha) — emitida em ${naPlanilha.emissao}`);
                    if (via === 'data') partes.push('Casado por data+emitente (sem nº de NF)');

                    encontradas.push({
                        ...naPlanilha,
                        arquivo:    rowB.arquivo,
                        pasta:      rowB.pasta,
                        tipo:       rowB.tipo,
                        tipoPlanilha: naPlanilha.tipo,
                        valorBanco: rowB.valor,
                        vencimentoBanco: rowB.vencimento || '—',
                        dataAlerta, valorItemAlerta: valorDiverge, tipoDiverge,
                        divergencia: partes.length ? partes.join(' · ') : null,
                        periodoPlanilha: naPlanilha.periodo,
                        matchVia:   via,
                        status: (valorDiverge || tipoDiverge || dataAlerta) ? 'divergente' : (outroMes ? 'data-divergente' : 'ok'),
                    });
                    continue;
                }

                // Consolidação: a fatura do banco não casou por número, mas seu valor
                // pode ser a SOMA de várias notas do mesmo emitente lançadas separadas
                // na planilha (ex.: FT131313 R$308,32 = NF 138719+138720+138750).
                if (rowB.emitente && rowB.valor > 0) {
                    const grupo = acharConsolidacao(rowB.valor, rowB.emitente, null);
                    if (grupo) {
                        usadasBanco.add(rowB);
                        for (const p of grupo) { planilhaUsada.add(p); consolidadas.add(p); }
                        const nfs = grupo.map(p => p.nf).filter(Boolean).join(', ');
                        encontradas.push({
                            ...grupo[0],
                            arquivo:    rowB.arquivo,
                            pasta:      rowB.pasta,
                            tipo:       rowB.tipo,
                            tipoPlanilha: grupo[0].tipo,
                            valor:      rowB.valor,           // total da fatura (= soma)
                            valorBanco: rowB.valor,
                            vencimentoBanco: rowB.vencimento || '—',
                            dataAlerta: false, valorItemAlerta: false, tipoDiverge: false,
                            divergencia: `ℹ Fatura consolida ${grupo.length} notas (${nfs}) — soma R$${rowB.valor.toFixed(2)}`,
                            periodoPlanilha: grupo[0].periodo,
                            matchVia:   'consolidada',
                            status:     'ok',
                        });
                        continue;
                    }
                }

                faltandoPlanilha.push({
                    nf:       rowB.nf,
                    entidade: rowB.emitente,
                    valor:    rowB.valor,
                    arquivo:  rowB.arquivo,
                    pasta:    rowB.pasta,
                    tipo:     rowB.tipo,
                    status:   'faltando-planilha',
                });
            }
        }

        // Notas consumidas por consolidação na seção 6 podem já ter sido empurradas
        // para "faltando no banco" na seção 5 — remove-as agora (a fatura as cobre).
        const chaveNota = n => `${n.periodo}|${n.nf}|${n.entidade}`;
        const consolidadasKeys = new Set([...consolidadas].map(chaveNota));
        const naoEncontradasFinal = naoEncontradas.filter(n => !consolidadasKeys.has(chaveNota(n)));

        const valorParcialCount = encontradas.filter(n => n.status === 'valor-parcial').length;
        const divergentesCount  = encontradas.filter(n => n.status === 'divergente').length;
        console.log(`[comparar-notas] resultado: ${encontradas.length} encontradas (${divergentesCount} divergentes), ${naoEncontradasFinal.length} faltando no banco, ${faltandoPlanilha.length} faltando na planilha, ${tributos.length} tributos`);

        return res.json({
            success: true,
            mes, ano, periodo,
            resumo: {
                totalPlanilha:    notasPlanilha.length,
                encontradas:      encontradas.length,
                naoEncontradas:   naoEncontradasFinal.length,
                divergentes:      encontradas.filter(n => n.status === 'divergente').length,
                dataDivergente:   encontradas.filter(n => n.status === 'data-divergente').length,
                valorParcial:     valorParcialCount,
                faltandoPlanilha: faltandoPlanilha.length,
                tributos:         tributos.length,
                totalBanco:       banco.total,
                outroMesBanco:    encontradas.filter(n => n.periodoPlanilha && n.periodoPlanilha !== periodo).length,
           },
            encontradas,
            naoEncontradas: naoEncontradasFinal,
            faltandoPlanilha,
            tributos,
        });

    } catch (e) {
        console.error('[comparar-notas] erro:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
};
