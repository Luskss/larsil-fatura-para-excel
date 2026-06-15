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
const { getAlertasFalsos } = require('./_alertas-falsos-db');
const { getVinculos }      = require('./_vinculos-db');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

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
// Memoizado: é função pura chamada milhares de vezes (entidadeMatch nas seções 5/6 e
// na recuperação) sobre um conjunto pequeno de entidades repetidas — o cache evita
// reprocessar as regex toda vez. Sem o cache, era o principal custo por request.
const _nucleoCache = new Map();
function nucleoEntidade(s) {
    const key = String(s || '');
    const hit = _nucleoCache.get(key);
    if (hit !== undefined) return hit;
    const out = norm(key)
        .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}\b/g, ' ') // CNPJ
        .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, ' ')             // CPF
        .replace(/\b(S\/?A|S\.?A\.?|LTDA|ME|EPP|EIRELI|CIA|COMPANHIA|REDES?|DISTRIBUIDORA|COMERCIO|COM|IND(USTRIA)?|SERVICOS?|S\.A|EI)\b/g, ' ')
        .replace(/[.,\/\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    _nucleoCache.set(key, out);
    return out;
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

// CNPJ (14 dígitos) de uma string, com ou sem formatação. '' se não achar.
// Aceita "41.534.692/0001-35", "08420245000180", "...S.A 41.534.692/0001-35".
function extrairCnpj(s) {
    const str = String(s || '');
    const m = str.match(/\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/);
    if (m) {
        const d = m[0].replace(/\D/g, '');
        if (d.length === 14) return d;
    }
    const m2 = str.match(/(?<!\d)\d{14}(?!\d)/);
    return m2 ? m2[0] : '';
}

// Empresa auditada (a PAGADORA). A IA às vezes lê o CNPJ e/ou o nome dela como
// "emitente" do documento (típico em recibos de pagamento), contaminando o match.
// Raiz do CNPJ (8 primeiros dígitos) cobre todas as filiais. (Cliente-específico.)
const PAGADOR_CNPJ_ROOT = '08420245';
function cnpjEhPagador(cnpj) { return !!cnpj && cnpj.slice(0, 8) === PAGADOR_CNPJ_ROOT; }
function nomeEhPagador(nome) { return /\bLARSIL\b/.test(norm(nome)); }

// Compara entidades usando CNPJ como evidência SÓ POSITIVA: CNPJs iguais = mesma
// empresa (sinal forte, casa mesmo com nomes escritos diferente). CNPJs diferentes
// NÃO rejeitam — cai no nome fuzzy (o CNPJ do banco é ruidoso: filiais, OCR, e a IA
// às vezes troca pelo CNPJ do pagador). Assim o CNPJ só ADICIONA matches, nunca remove.
function entidadeBate(emitB, cnpjB, entP, cnpjP) {
    if (cnpjB && cnpjP && cnpjB === cnpjP) return true;
    return entidadeMatch(emitB, entP);
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
        // Parcelas DESIGUAIS: o boleto é UMA parcela e as parcelas não são idênticas
        // (ex.: NF 4.000,00 em 3x = 1.333,60 + 1.333,20 + 1.333,20). A soma exata acima
        // falha (1.333,60×3 = 4.000,80 ≠ 4.000), mas a RAZÃO total/parcela fica coladíssima
        // a um inteiro (4000/1333,60 = 2,9994 ≈ 3). Tolerância apertada (0,01) p/ NÃO
        // mascarar erro de valor real — só confirma quando bate quase exato um nº de parcelas.
        if (nota.valor > valorBanco * 1.5) {
            const ratio = nota.valor / valorBanco;
            const n = Math.round(ratio);
            if (n >= 2 && n <= MAX_PARCELAS && Math.abs(ratio - n) <= 0.01)
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
    // Fatura em lote: um boleto/duplicata que paga em lote NFS-e/NF-e anexas. A
    // planilha lança como FATURA, mas o PDF é classificado como NFS/NF pelo conteúdo.
    // Não é divergência. (Antes restringíamos a docs "FT..." pelo NOME do arquivo, mas
    // por decisão do usuário o nome do arquivo não é usado para determinar tipo.)
    if (tp === 'FATURA' && (tb === 'NF' || tb === 'NFS')) return true;
    return false;
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

// Categorias de TIPO da planilha que são lançamentos contábeis/financeiros — NÃO
// documentos fiscais — e portanto NUNCA têm PDF correspondente no banco. Como o cartão
// de crédito, são ignoradas para não poluírem "faltando no banco":
//   • PREVISAO / FINANC GIRO / ADIANTAMENTO → movimentos financeiros, sem documento
//   • DUPLICATA → a NF é um código de período (ex.: "2026.05LA"), não um nº fiscal
//   • IMPOSTO → retenção atrelada a outra NF, com sufixo (ex.: "190PC", "190RE", "1713IE");
//     os tributos com PDF próprio (DARF/GPS) já são tratados pela aba Tributos no lado do banco.
// (DESPESAS BANCARIAS fica de fora — mantida na conferência por opção do usuário.)
const TIPOS_NAO_FISCAIS = new Set(['PREVISAO', 'FINANC GIRO', 'ADIANTAMENTO', 'DUPLICATA', 'IMPOSTO']);
function isCategoriaIgnoravel(tipoPlanilha) {
    return TIPOS_NAO_FISCAIS.has(norm(tipoPlanilha));
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

        // Categorias não-fiscais (PREVISAO, FINANC GIRO, ADIANTAMENTO, DUPLICATA, IMPOSTO):
        // entradas contábeis sem documento fiscal no banco — ignoradas pelo mesmo motivo.
        if (isCategoriaIgnoravel(row[idxTipo])) continue;

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
            cnpj: extrairCnpj(row[idxEntidade]),           // CNPJ embutido na ENTIDADE (match exato)
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
            const idxC = cols.indexOf('cnpj');
            for (let i = 1; i < lines.length; i++) {
                const rowB = parseCsvLine(lines[i], idxA, idxP, idxT, idxD, idxC);
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

// Valor codificado no NOME do arquivo (padrão "NNN.DOC- 18.767,74 - ..." ou "DOC- 4885,69").
// É o valor que o arquivista conferiu ao arquivar → âncora confiável quando o parser erra.
function extrairValorDoArquivo(arquivo) {
    const m = arquivoBase(arquivo).match(/DOC[-\s]*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i);
    if (m) {
        const num = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
        if (!isNaN(num) && num > 0) return normVal(num);
    }
    return 0;
}

function extrairValorDeParsed(parser, arquivo) {
    if (parser) {
        const rawVal = parser['Valor total'] || parser['Total da NF-e'] || parser['Valor'] || '';
        if (rawVal) {
            const num = parseFloat(String(rawVal).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
            if (!isNaN(num) && num > 0) return normVal(num);
        }
    }
    return extrairValorDoArquivo(arquivo);
}

// ── Parse CSV do banco uma vez por linha ─────────────────────────────────────
function parseCsvLine(line, idxArquivo, idxPasta, idxTipo, idxDadosParser, idxCnpj) {
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

    // CNPJ do emitente: preferir o do parser, senão a coluna 'cnpj' do relatório.
    let cnpj = parser ? extrairCnpj(parser['CNPJ emitente'] || parser['CNPJ Emitente'] || '') : '';
    if (!cnpj && idxCnpj >= 0) cnpj = extrairCnpj(fields[idxCnpj] || '');
    let emitente = norm(extrairEmitenteDeParsed(parser, arquivo));

    // Lever 3: a IA frequentemente lê a PAGADORA (LARSIL) no lugar do fornecedor.
    // Zera SÓ a parte contaminada: se o NOME é a pagadora, descarta o nome; se o CNPJ
    // é o da pagadora, descarta só o CNPJ (o nome costuma ser o fornecedor REAL —
    // ex.: emitente "BIOS NETWORKS" com CNPJ da LARSIL → mantém "BIOS NETWORKS").
    if (nomeEhPagador(emitente)) emitente = '';
    if (cnpjEhPagador(cnpj))     cnpj = '';

    return {
        arquivo,
        pasta:       fields[idxPasta] ?? '',
        tipo:        fields[idxTipo]  ?? '',
        nf,
        nfAlt,
        ocp:         extrairOCPDeParsed(parser, arquivo),
        emitente,
        cnpj,
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

        // DAMs e guias de tributo (DARF/FGTS/DCTFWeb/PIS/COFINS/IRPJ/CSLL/ISS/IPVA...) nunca
        // constam na planilha como NF — têm aba própria. Identificados por:
        //   • tipo IMPOSTO classificado pelo banco (sinal mais forte e abrangente);
        //   • NF no range 9039xx/9049xx (nº de RCB de guia do governo);
        //   • emitente/nome do arquivo contendo GOVERNO/PREFEITURA.
        // Sem o tipo IMPOSTO, ~70 guias vazavam para "Faltando na planilha" porque a IA
        // extrai um nº de controle (ex.: "2026051111463728") e não o RCB 9039xx, e o
        // emitente não vem como "GOVERNO".
        function isTributo(rowB) {
            if (norm(rowB.tipo) === 'IMPOSTO') return true;
            if (/^9039\d{2}$|^9049\d{2}$/.test(rowB.nf)) return true;
            const e = (rowB.emitente || '').toUpperCase();
            const arq = String(rowB.arquivo || '').toUpperCase();
            return e.includes('GOVERNO') || e.includes('PREFEITURA') || /\bGOVERNO\b/.test(arq);
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
                    partes.push(`⚠ Valor: Pasta R$${rowB.valor.toFixed(2)} × Planilha R$${nota.valor.toFixed(2)}` +
                        (nota.valorItem > 0 && Math.abs(nota.valorItem - nota.valor) > TOL_VAL ? ` (itens R$${nota.valorItem.toFixed(2)})` : ''));
                }
            } else if (vRes.ok && /^parcela \d+x$/.test(vRes.base || '')) {
                // Compra parcelada: informativo, não é divergência.
                partes.push(`ℹ Parcela ${vRes.base.match(/\d+/)[0]}x — Pasta R$${rowB.valor.toFixed(2)} × total Planilha R$${nota.valor.toFixed(2)}`);
            }

            // VALIDA TIPO (banco classificado × TIPO da planilha mapeado)
            if (!tipoBate(rowB.tipo, nota, rowB)) {
                tipoDiverge = true;
                partes.push(`⚠ Tipo: Pasta ${rowB.tipo || '—'} × Planilha ${nota.tipo || '—'}`);
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
                    (c.rowB.emitente || c.rowB.cnpj)
                        ? entidadeBate(c.rowB.emitente, c.rowB.cnpj, nota.entidade, nota.cnpj)
                        // SEM emitente/CNPJ extraído: aceita por número, MAS se o doc tem valor e ele
                        // NÃO bate, rejeita — evita um comprovante avulso (ex.: pgto EVA CARD,
                        // sem emitente e sem NF própria) sequestrar uma NF homônima por colisão
                        // de número. Sem valor (0), não dá p/ refutar → mantém o comportamento antigo.
                        : (!(c.rowB.valor > 0) || valorBate(c.rowB.valor, nota).ok)
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
                    if (rowB.emitente || rowB.cnpj) {
                        const compat = cands.filter(p => !p.entidade || entidadeBate(rowB.emitente, rowB.cnpj, p.entidade, p.cnpj));
                        if (compat.length > 0) cands = compat;
                        else cands = cands.filter(p => valorBate(rowB.valor, p).ok);
                    } else if (rowB.valor > 0) {
                        // Sem emitente no banco: só casa por número se o VALOR também confirmar,
                        // p/ não deixar um comprovante avulso (sem emitente) sequestrar uma NF
                        // homônima. Sem valor (0), mantém o comportamento antigo (não há como refutar).
                        cands = cands.filter(p => valorBate(rowB.valor, p).ok);
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
                        // Requer identidade em AMBOS os lados — sem emitente/CNPJ no banco não há como confirmar
                        if ((!rowB.emitente && !rowB.cnpj) || !p.entidade) continue;
                        if (!entidadeBate(rowB.emitente, rowB.cnpj, p.entidade, p.cnpj)) continue;

                        if (!valorBate(rowB.valor, p).ok) continue;
                        naPlanilha = p;
                        break;
                    }
                }

                // Recuperação por VALOR + EMITENTE (conservadora): o match por número falhou,
                // mas o doc pode estar na planilha sob OUTRO número — a IA extraiu o nº errado,
                // a planilha usou outro nº de fatura, ou é uma conta recorrente lançada em outro
                // mês (ex.: MEV NF 7190 no banco = NF 7261 na planilha; BIOS/ENERGISA/VIVO).
                // Casa SÓ com valor + emitente compatível e marca como match fraco p/ conferir o
                // número. Prioriza o mês conferido; depois varre a planilha inteira pelo valor.
                let viaRecuperacao = false;
                if (!naPlanilha && (rowB.emitente || rowB.cnpj) && rowB.valor > 0) {
                    // Valor EXATO (cabeçalho/soma itens/item individual) — SEM a lógica de
                    // "parcela ÷ N", que aqui geraria falso positivo (ex.: R$100 = 20x de
                    // R$2.000 casaria MEGA REDES com MEGA GUINDASTES). Conservador: só recupera
                    // quando o valor bate de verdade, não como fração.
                    const valorExato = p =>
                        (p.valor > 0 && Math.abs(rowB.valor - p.valor) <= TOL_VAL) ||
                        (p.valorItem > 0 && Math.abs(rowB.valor - p.valorItem) <= TOL_VAL) ||
                        (p.itens || []).some(v => Math.abs(rowB.valor - v) <= TOL_VAL);
                    const casaVE = p => !planilhaUsada.has(p) && p.entidade &&
                        entidadeBate(rowB.emitente, rowB.cnpj, p.entidade, p.cnpj) && valorExato(p);
                    naPlanilha = (porPeriodo.get(periodo) || []).find(casaVE)
                              || (planilhaPorVal.get(Math.round(rowB.valor * 100)) || []).find(casaVE)
                              || null;
                    if (naPlanilha) viaRecuperacao = true;
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
                    const via = viaRecuperacao ? 'valor-emitente' : (chavesBanco.length === 0 ? 'data' : 'nf-global');
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
                    else if (via === 'valor-emitente') partes.push(`ℹ Casado por valor+emitente — conferir número (banco ${rowB.nf || '—'} × planilha ${naPlanilha.nf || '—'})`);

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

        // ── 7) Anota alertas falsos registrados no banco ─────────────────────
        const chaveAlerta = n => `${n.nf||''}|${n.arquivo||''}|${n.entidade||''}`;
        try {
            const afMapa = await getAlertasFalsos(pool, periodo);
            if (afMapa.size > 0) {
                const anotar = arr => arr.forEach(n => {
                    const af = afMapa.get(chaveAlerta(n));
                    if (af) {
                        n.alertaFalso      = true;
                        n.alertaFalsoMotivo = af.motivo;
                        n.alertaFalsoObs    = af.obs;
                        n.alertaFalsoPor    = af.criadoPor;
                    }
                });
                anotar(encontradas);
                anotar(naoEncontradasFinal);
                anotar(faltandoPlanilha);
            }
        } catch (e) {
            console.warn('[comparar-notas] alertas-falsos indisponível:', e.message);
        }

        // ── 8) Anota vínculos manuais em naoEncontradas ──────────────────────
        const chaveVinculo = n => `${n.nf||''}|${n.entidade||''}|${n.periodo||''}`;
        try {
            const vMapa = await getVinculos(pool, periodo);
            if (vMapa.size > 0) {
                naoEncontradasFinal.forEach(n => {
                    const v = vMapa.get(chaveVinculo(n));
                    if (v) {
                        n.vinculo      = true;
                        n.vinculoEntrada = v.entrada;
                        n.vinculoObs     = v.obs;
                        n.vinculoPor     = v.criadoPor;
                    }
                });
            }
        } catch (e) {
            console.warn('[comparar-notas] vinculos-notas indisponível:', e.message);
        }

        const valorParcialCount = encontradas.filter(n => n.status === 'valor-parcial').length;
        const divergentesCount  = encontradas.filter(n => n.status === 'divergente' && !n.alertaFalso).length;
        console.log(`[comparar-notas] resultado: ${encontradas.length} encontradas (${divergentesCount} divergentes), ${naoEncontradasFinal.length} faltando na Pasta, ${faltandoPlanilha.length} faltando na Planilha, ${tributos.length} tributos`);

        return res.json({
            success: true,
            mes, ano, periodo,
            resumo: {
                totalPlanilha:    notasPlanilha.length,
                encontradas:      encontradas.length,
                naoEncontradas:   naoEncontradasFinal.length,
                divergentes:      encontradas.filter(n => n.status === 'divergente' && !n.alertaFalso).length,
                dataDivergente:   encontradas.filter(n => n.status === 'data-divergente' && !n.alertaFalso).length,
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
