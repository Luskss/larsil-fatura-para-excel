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
const { classify, mk, norm, extrairCnpj, extrairEmitente, CTE_STRONG_RE, TRANSPORT_HINT_RE } = require('./_nf-parsers');
const { extrairBoletosAI } = require('./_boletos-ai');
const { extrairNotaAI, TIPOS_VALIDOS } = require('./_nf-ai-full');

const OCR_URL = 'http://127.0.0.1:5001/ocr';

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

// ── Coleta de PDFs ────────────────────────────────────────────────────────────
async function collectPdfs(dirPath, rootPath = dirPath, files = []) {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
                // pasta = caminho relativo da subpasta (sem o nome do arquivo), com "/"
                const rel = path.relative(rootPath, dirPath).split(path.sep).join('/');
                files.push({ path: fullPath, name: entry.name, folder: rel });
            } else if (entry.isDirectory()) {
                await collectPdfs(fullPath, rootPath, files);
            }
        }
    } catch (e) {
        console.error(`[process-folder] erro ao ler pasta ${dirPath}:`, e.message);
    }
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
function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
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
async function ocrViaBackend(buffer) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'application/pdf' }), 'upload.pdf');
    const res = await fetch(OCR_URL, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error || `OCR server ${res.status}`);
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
async function analyzeViaAI(pdf, text, pages, ocrUsed, isImage) {
    let r;
    try {
        r = await extrairNotaAI({ text, filename: pdf.name, pages });
    } catch (e) {
        console.warn(`[process-folder] IA full erro em ${pdf.name}: ${e.message}`);
        return null;
    }
    if (r.error) console.warn(`[process-folder] IA full em ${pdf.name}: ${r.error}`);
    // Sem nada aproveitável → deixa o parser local tentar.
    if (!r.tipo && !r.emitente && !r.numero && r.parcelas.length === 0) return null;

    const tipo = TIPOS_VALIDOS.includes(r.tipo) ? r.tipo : 'Não identificado';
    const numKey = chaveNumeroPorTipo(tipo);

    const pdComum = {};
    if (r.numero)      pdComum[numKey] = r.numero;
    if (r.ordemCompra) pdComum['Ordem de Compra'] = r.ordemCompra;
    if (r.emitente)    pdComum['Emitente'] = r.emitente;
    if (r.cnpj)        pdComum['CNPJ emitente'] = r.cnpj;
    if (r.dataEmissao) pdComum['Data de emissão'] = r.dataEmissao;

    const baseRow = {
        arquivo:      pdf.name,
        pasta:        pdf.folder || '',
        paginas:      String(pages),
        conteudo:     isImage ? `Imagem${ocrUsed ? ' (OCR)' : ''}` : 'Texto',
        tipo,
        evidencia:    r.emitente ? `IA: ${r.emitente}` : 'IA',
        origem:       'IA',
        ocr_usado:    String(ocrUsed),
        dados_parser: '',
        cnpj:         r.cnpj || '',
    };

    // Carnê confirmado pela IA (Nosso Número distintos) → uma row por parcela.
    if (r.parcelas.length > 1) {
        console.log(`[process-folder] IA: carnê em ${pdf.name} — ${r.parcelas.length} parcelas`);
        return r.parcelas.map((b, i) => {
            const pd = {
                ...pdComum,
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
    const vencUnico = r.dataVencimento || (r.parcelas.length === 1 ? r.parcelas[0].vencimento : '');
    if (vencUnico) pd['Data de vencimento'] = vencUnico;
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
        if (isImage) {
            try {
                const ocrText = await ocrViaBackend(buffer);
                if (ocrText) { text = ocrText; ocrUsed = true; }
            } catch (e) {
                console.warn(`[process-folder] OCR (IA) falhou em ${pdf.name}: ${e.message}`);
            }
        }
        const rowsIA = await analyzeViaAI(pdf, text, pages, ocrUsed, isImage);
        if (rowsIA) return rowsIA;
        console.warn(`[process-folder] IA sem resultado em ${pdf.name} — usando parser local`);
    }

    let ocrUsed = false;
    let c = classify(text, pdf.name);

    if ((isImage || c.tipo === 'Não identificado') && !ocrUsed) {
        try {
            const ocrText = await ocrViaBackend(buffer);
            const c2 = classify(ocrText, pdf.name);
            if (c2.tipo !== 'Não identificado') { text = ocrText; ocrUsed = true; c = c2; }
            else if (isImage) { text = ocrText || text; ocrUsed = true; }
        } catch (e) {
            console.warn(`[process-folder] OCR falhou em ${pdf.name}: ${e.message}`);
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

    let parserData = c.parser ? c.parser(text) : null;
    let cnpjRaw = parserData ? (parserData['CNPJ emitente'] || parserData['CNPJ / CPF'] || '') : '';
    if (!cnpjRaw || cnpjRaw === '—') cnpjRaw = extrairCnpj(text);

    const emitenteNome = extrairEmitente(pdf.name);
    if (emitenteNome) {
        parserData = parserData || {};
        parserData['Emitente'] = emitenteNome;
    }

    const baseRow = {
        arquivo:      pdf.name,
        pasta:        pdf.folder || '',
        paginas:      String(pages),
        conteudo:     isImage ? `Imagem${ocrUsed ? ' (OCR)' : ''}` : 'Texto',
        tipo:         c.tipo,
        evidencia:    c.evidencia,
        origem:       c.origem,
        ocr_usado:    String(ocrUsed),
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
        for (const row of novasRows) {
            const chave = `${row.arquivo}|${row.pasta}`;
            const isParcela = /#p\d+$/i.test(row.arquivo);
            const base = row.arquivo.replace(/#p\d+$/i, '');
            if (isParcela) {
                // Ao gravar parcelas, remove o entry de boleto único (evita duplicata)
                map.delete(`${base}|${row.pasta}`);
            } else {
                // Ao gravar boleto único, remove parcelas antigas do mesmo arquivo
                const keysToDelete = [...map.keys()].filter(k => k.startsWith(`${row.arquivo}#p`) && k.endsWith(`|${row.pasta}`));
                for (const k of keysToDelete) map.delete(k);
            }
            map.set(chave, row);
        }
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
    const forceAI = !!opts.forceAI;
    try {
        await fs.access(folderPath);

        const pdfs = await collectPdfs(folderPath);
        console.log(`[process-folder] coletado ${pdfs.length} PDF(s) de ${folderPath}`);

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
        for (const pdf of pdfs) {
            const d = filenameToDay(pdf.name) || folderToDay(pdf.folder);
            if (d) { pdf.day = d; }
            else   { semData.push(pdf); }
        }

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
        const precisaIA = (chave) => forceAI && !ehIA(chave);

        // "Pendentes" = não estão no M do mês (precisam entrar no relatório), OU — no modo
        // forceAI — já estão mas ainda não passaram pela IA. Destes, alguns serão
        // reaproveitados do cache global; só os de fato inéditos passam pelo analyzePdf.
        const pendentes = pdfs.filter(p => {
            const chave = `${p.name}|${p.folder}`;
            return !cacheMensal.has(chave) || precisaIA(chave);
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
            return !cacheGlobal.has(chave) || precisaIA(chave);
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
            if (precisaIA(chave)) continue;
            const cached = cacheGlobal.get(chave);
            if (cached) acumular(pdf, cached);
        }

        // 2) Relê do disco apenas os inéditos (extração + OCR) — passo caro, com progresso
        let stopped = false;
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
            } catch (e) {
                errors++;
                console.error(`[process-folder] erro ao processar ${pdf.name}: ${e.message}`);
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
};
