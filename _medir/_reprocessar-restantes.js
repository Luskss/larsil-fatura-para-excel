/**
 * _medir/_reprocessar-restantes.js — relê de um mês só os PDFs que ainda NÃO têm
 * leitura no banco. Nasceu em 16/09/2026 para terminar 02.2026, cuja rodada do dia
 * anterior morreu no meio por HTTP 429 da API.
 *
 * ── Por que selecionar pelo NOME, e não por `arquivo|pasta` ──────────────────
 * O cache de `processFolderAuto` casa por `arquivo|pasta`, e a grafia de `pasta`
 * depende da RAIZ que se passa a `collectPdfs`, que devolve o caminho relativo a
 * ela:
 *   raiz = ARQUIVO_PATH (o que a produção usa) → "2026.02.EXTRATOS CONTABILIDADE/SANTANDER/2026.02.10"
 *   raiz = a pasta do mês (o que este script usa) → "SANTANDER/2026.02.10"
 * Como aqui varremos a pasta do mês, a chave sai curta e não casaria com o banco —
 * 0 de 757 em 02.2026, contra 642 casando por NOME. Por isso a seleção é por nome
 * (descontando o sufixo de parcela #pN, a mesma normalização do painel).
 *
 * NÃO é um defeito do sistema: o scan de produção passa `ARQUIVO_PATH` e gera a
 * grafia longa, coerente com o banco. Era artefato de medição. A gravação abaixo
 * usa `upsertRelatorio`, que casa pela chave do BANCO, então nada disso afeta o
 * que é gravado.
 *
 * ── A trava do 429 ───────────────────────────────────────────────────────────
 * Foi o 429 que matou a rodada anterior: em `processFolderAuto` a exceção sobe e
 * aborta o laço. Aqui cada documento tem retentativa com recuo exponencial, e o
 * 429 NÃO conta para o disjuntor de falhas — limite de taxa é transitório, não
 * defeito do arquivo. Se nem assim passar, o documento é contado como erro e a
 * rodada segue; o que foi lido é gravado no fim.
 *
 * ── Segurança da gravação ────────────────────────────────────────────────────
 * `upsertRelatorio` faz merge por `arquivo|pasta` e preserva as linhas ausentes
 * do lote, então gravar só estes não apaga os que já estavam bons. Grava M (mensal)
 * e D (diário), diferente de `_reprocessar-arquivos.js`, que só fazia o mensal.
 *
 * Uso:
 *   node _medir/_reprocessar-restantes.js 04.2026              (dry-run: lista e sai)
 *   node _medir/_reprocessar-restantes.js 04.2026 --confirmar   (lê e grava)
 *   ... --limite N         processa só os N primeiros (teste barato antes do lote todo)
 *   ... --incluir-local    inclui também o que já tem row mas nunca passou pela IA
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const args = process.argv.slice(2);
const CONFIRMAR = args.includes('--confirmar');
const iLim = args.indexOf('--limite');
const LIMITE = iLim >= 0 ? parseInt(args[iLim + 1], 10) : Infinity;
const INCLUIR_LOCAL = args.includes('--incluir-local');

// Período como MM.AAAA no argumento. Sem ele o script para: rodar o mês errado
// custa API e grava no relatório errado, então não há default seguro.
const PERIODO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
if (!PERIODO) {
    console.error('informe o período: node _medir/_reprocessar-restantes.js MM.AAAA [--confirmar] [--limite N]');
    process.exit(1);
}
const [MM, AAAA] = PERIODO.split('.');
const SUB = `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`;
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

const base = (n) => String(n || '').replace(/#p\d+$/i, '').trim().toLowerCase();
const soneca = (ms) => new Promise(r => setTimeout(r, ms));

// `--so-simples`: pula o que `pareceMultiBoleto` gateia para a IA de carnê.
//
// POR QUE (medido em 17/09/2026, lote de teste de 15 documentos em 06.2026): os
// documentos simples saíram perfeitos — GUIA ISS, FINANCIAMENTO BRADESCO e dois
// "pgto VA" foram de valor VAZIO para o valor exato do nome. Mas 9 dos 15 eram
// financiamento/consórcio, e cada um virou 11..48 linhas espalhadas por anos.
//
// Pior: o acervo JÁ tinha variantes do mesmo PDF com nomes ligeiramente diferentes
// ("R$ R$ 166.960,86", com e sem data), e o upsert casa por `arquivo|pasta` — então
// cada variante é um documento distinto. O GIRO CAIXA de R$ 166.960,86 tem 5 versões,
// 76 linhas, somando R$ 7,3 milhões. Releitura em lote AMPLIFICA isso.
//
// O ganho medido (+33 em 40, 0 perdas) está nos simples; o dano está nos carnês.
// Ver [[contrato-vira-carne-por-paginas]] e [[pasta-renomeada-duplica-linha]].
const SO_SIMPLES = args.includes('--so-simples');

// `pareceMultiBoleto` é interna de process-folder. Fatiada do FONTE para que o filtro
// use exatamente o critério que a rota usa — uma cópia envelheceria em silêncio.
const pareceMultiBoleto = (() => {
    const { norm } = require('../routes/_nf-parsers');
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const L = src.split(/\r?\n/);
    const ini = L.findIndex(x => x.startsWith('function pareceMultiBoleto'));
    if (ini < 0) throw new Error('não achei pareceMultiBoleto em process-folder.js');
    let fim = -1;
    for (let j = ini + 1; j < L.length; j++) if (L[j] === '}') { fim = j; break; }
    const mod = { exports: {} };
    new Function('module', 'norm', `${L.slice(ini, fim + 1).join('\n')}
module.exports = pareceMultiBoleto;`)(mod, norm);
    // Invariante: um boleto com 2 vencimentos distintos TEM de ser multi; um recibo
    // de uma página, não. Se a fatia pegar a função errada, quebra aqui.
    const fn = mod.exports;
    if (!fn('NOSSO NUMERO 123 VENCIMENTO 10/01/2026 VENCIMENTO 10/02/2026', 1)
        || fn('RECIBO DE PAGAMENTO agua', 1)) {
        throw new Error('pareceMultiBoleto fatiada não se comporta como esperado');
    }
    return fn;
})();

const { PDFParse } = require('pdf-parse');
async function textoDe(pdf) {
    try {
        const parser = new PDFParse({ data: new Uint8Array(await fs.promises.readFile(pdf.path)) });
        try {
            const r = await parser.getText();
            return {
                text: (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' '),
                pages: r.total || (Array.isArray(r.pages) ? r.pages.length : 1),
            };
        } finally { try { await parser.destroy(); } catch (_) {} }
    } catch (_) { return { text: '', pages: 1 }; }
}

// Um 429 pode chegar como status na mensagem ou como código do SDK. Reconhecer por
// texto é frágil, mas é o que a exceção oferece ao atravessar `analyzePdf`.
const eh429 = (e) => {
    const s = `${e && e.status || ''} ${e && e.code || ''} ${e && e.message || ''}`;
    return /\b429\b|rate.?limit|too many requests/i.test(s);
};

// `parcelaVenc` e `vencToDay` são internas de process-folder.js. Extraídas do FONTE
// em vez de copiadas, para que uma mudança lá não passe despercebida aqui.
const { parcelaVenc, vencToDay } = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('function vencToDay');
    const fim = src.indexOf('// Chave do dados_parser onde o número');
    if (ini < 0 || fim < 0) throw new Error('não achei vencToDay/parcelaVenc em process-folder.js');
    const mod = { exports: {} };
    new Function('module', `${src.slice(ini, fim)}\nmodule.exports = { parcelaVenc, vencToDay };`)(mod);
    return mod.exports;
})();

// Data DD.MM.YYYY a partir da subpasta (mesma forma que a rota usa para o diário).
function diaDaPasta(folder) {
    const m = String(folder || '').match(/(?:^|\/)(\d{4})\.(\d{2})\.(\d{2})(?:\/|$)/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

(async () => {
    const dir = path.join(RAIZ_ARQ, SUB);
    const pdfs = await pf.collectPdfs(dir);

    const pool = await getConnection();
    const todos = await pool.request()
        .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    // Índice por nome-base sobre TODOS os meses: uma parcela de carnê pode ter sido
    // arquivada no mês do vencimento, não no do arquivo.
    const porNome = new Map();
    for (const rec of todos.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            const k = base(row.arquivo);
            if (!porNome.has(k)) porNome.set(k, []);
            porNome.get(k).push(row);
        }
    }

    // "Lido" = tem row COM conteúdo. Row gravada vazia conta como não lida.
    const temConteudo = (row) => {
        let dp = {};
        try { dp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
        const ok = (v) => v && String(v).trim() && String(v).trim() !== '—';
        return Object.values(dp).some(ok) || (row.tipo && !/não identificado/i.test(row.tipo));
    };

    // `--incluir-local`: inclui também o que TEM conteúdo mas nunca passou pela IA.
    //
    // A cobertura de IA é muito desigual por mês (medido em 17/09/2026, por documento
    // no disco): 01 e 03.2026 têm 100%, mas 04.2026 tem 385 documentos "só-local" e
    // 06.2026 tem 524. Eles não entram no filtro padrão porque têm row com conteúdo —
    // e é justamente aí que está o ganho.
    //
    // MEDIDO (`_medir/_amostra-ia-vs-local.js`, amostra aleatória de 40 em cada mês):
    //   04.2026 → 33 ganhos, 0 perdas    06.2026 → 33 ganhos, 0 perdas
    // A causa não é "a IA lê melhor": em 38 dos 40 o parser local deixou `Valor total`
    // VAZIO (recibo de concessionária, documento "+ AUT", comprovante — layouts que os
    // parsers não cobrem). A IA preencheu 40 de 40.
    const ehIA = (row) => /\bIA\b/i.test(String(row.origem || ''));

    let alvos = pdfs.filter(p => {
        const rs = porNome.get(base(p.name));
        if (!rs || !rs.length || !rs.some(temConteudo)) return true;   // nunca lido
        if (INCLUIR_LOCAL && !rs.some(ehIA)) return true;              // lido só pelo parser local
        return false;
    });
    const ausentes = alvos.filter(p => {
        const rs = porNome.get(base(p.name));
        return !rs || !rs.length || !rs.some(temConteudo);
    }).length;

    // Filtro dos carnês: lê o texto (barato, sem IA) e descarta o que iria para a IA
    // de boletos. Roda ANTES do limite para que `--limite N` conte N documentos que
    // serão de fato processados.
    let pulados = 0;
    if (SO_SIMPLES) {
        const simples = [];
        for (const p of alvos) {
            const { text, pages } = await textoDe(p);
            // Sem texto o pré-filtro não opina; deixa passar (é PDF-imagem, e o ganho
            // medido está justamente onde o parser local não leu nada).
            if (text && pareceMultiBoleto(text, pages)) { pulados++; continue; }
            simples.push(p);
        }
        alvos = simples;
    }

    if (Number.isFinite(LIMITE)) alvos = alvos.slice(0, LIMITE);

    console.log(`período : ${PERIODO}`);
    console.log(`pasta   : ${dir}`);
    console.log(`no disco: ${pdfs.length} documentos (${pdfs.ignorados} CPV/000 ignorados)`);
    console.log(`já lidos: ${pdfs.length - alvos.length}`);
    console.log(`A RELER : ${alvos.length}${SO_SIMPLES ? `   (${pulados} carnê/multi-boleto PULADOS)` : `   (${ausentes} nunca lidos + ${alvos.length - ausentes} só-local)`}`);
    console.log(`VISAO   : ${String(process.env.VISAO_PDF ?? '1') !== '0' ? 'ativa' : 'DESLIGADA'}`);
    console.log(`OPENAI  : ${process.env.OPENAI_API_KEY ? 'chave presente' : 'AUSENTE'}\n`);

    if (!alvos.length) { console.log('nada a fazer.'); process.exit(0); }

    if (!CONFIRMAR) {
        for (const a of alvos.slice(0, 20)) console.log(`   [${a.folder}] ${a.name.slice(0, 70)}`);
        if (alvos.length > 20) console.log(`   ... e mais ${alvos.length - 20}`);
        console.log('\nDRY-RUN — nada gravado. Acrescente --confirmar para executar.');
        process.exit(0);
    }

    const rowsPorMes = new Map(), rowsPorDia = new Map();

    // Espelha `acumular` da rota: parcela de carnê é arquivada no mês/dia do SEU
    // vencimento, não no do arquivo — senão as 56 parcelas de um consórcio caem
    // todas no mês em que o PDF foi digitalizado. Na rodada de 02.2026 este script
    // forçava tudo no período, e vários carnês de fevereiro têm parcelas que vencem
    // nos meses seguintes.
    const acumular = (pdf, row) => {
        let dia = diaDaPasta(pdf.folder);
        let mes = PERIODO;
        const pv = parcelaVenc(row);
        if (pv) {
            const d = vencToDay(pv);
            if (d) { dia = d; mes = d.slice(3); }
        }
        if (!rowsPorMes.has(mes)) rowsPorMes.set(mes, []);
        rowsPorMes.get(mes).push(row);
        if (dia) {
            if (!rowsPorDia.has(dia)) rowsPorDia.set(dia, []);
            rowsPorDia.get(dia).push(row);
        }
    };

    const t0 = Date.now();
    let ok = 0, erros = 0, tentativas429 = 0;
    const falhas = [];

    for (let i = 0; i < alvos.length; i++) {
        const pdf = alvos[i];
        const etiqueta = `[${String(i + 1).padStart(3)}/${alvos.length}] ${pdf.name.slice(0, 58)}`;

        let feito = false;
        for (let tent = 0; tent < 5 && !feito; tent++) {
            try {
                const rows = await pf.analyzePdf(pdf, { forceAI: true });
                if (rows && rows.length) {
                    for (const r of rows) acumular(pdf, r);
                    ok++;
                    console.log(`${etiqueta}  ✓ ${rows.length} row(s)`);
                } else {
                    console.log(`${etiqueta}  — sem row`);
                }
                feito = true;
            } catch (e) {
                if (eh429(e) && tent < 4) {
                    const espera = Math.min(60000, 5000 * Math.pow(2, tent));
                    tentativas429++;
                    console.warn(`${etiqueta}  429 — aguardando ${espera / 1000}s (tentativa ${tent + 1}/4)`);
                    await soneca(espera);
                    continue;
                }
                erros++;
                falhas.push({ nome: pdf.name, erro: e.message });
                console.error(`${etiqueta}  ✗ ${e.message.slice(0, 110)}`);
                feito = true;
            }
        }
        // Respiro entre documentos: foi o volume em rajada que derrubou a rodada
        // anterior no 429.
        await soneca(400);
    }

    const total = Array.from(rowsPorMes.values()).reduce((s, r) => s + r.length, 0);
    console.log(`\n── GRAVANDO ${total} row(s) ─────────────────────────────────`);
    for (const [mes, rows] of rowsPorMes) {
        await pf.upsertRelatorio(pool, 'M', mes, rows);
        console.log(`   M ${mes}: ${rows.length} row(s)`);
    }
    for (const [dia, rows] of rowsPorDia) {
        await pf.upsertRelatorio(pool, 'D', dia, rows);
    }
    console.log(`   D: ${rowsPorDia.size} dia(s)`);

    const min = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`\n── RESULTADO (${min} min) ──────────────────────────────────`);
    console.log(`   lidos com sucesso : ${ok}`);
    console.log(`   erros             : ${erros}`);
    console.log(`   esperas por 429   : ${tentativas429}`);
    if (falhas.length) {
        console.log(`\n   falhas:`);
        for (const f of falhas.slice(0, 20)) console.log(`     ${f.nome.slice(0, 60)} → ${f.erro.slice(0, 80)}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
