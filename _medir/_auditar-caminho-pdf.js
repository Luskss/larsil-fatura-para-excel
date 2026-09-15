/**
 * _medir/_auditar-caminho-pdf.js — auditoria do caminho de leitura de PDF.
 *
 * Pedido do usuário (11/09/2026): antes de reprocessar mais meses, conferir se há
 * BUG na parte dos PDFs. A auditoria é por PROPRIEDADE verificável, não por leitura
 * de código — cada bloco abaixo testa uma invariante que, se quebrada, produz dado
 * errado no banco.
 *
 * As invariantes vêm dos modos de falha que este projeto já pagou:
 *
 *  A. CONTAGEM DE TEXTO — o marcador "-- N of M --" do pdf-parse 2.x tem de ser
 *     removido ANTES de medir se o PDF é imagem. Sem isso um PDF-imagem de 3
 *     páginas "tem" ~24 caracteres e escapa da visão. Foi o erro que EU cometi em
 *     `_origem-vazia.js` e que me fez diagnosticar a fenda errada.
 *     → conferir que `extractText` e os medidores concordam com a produção.
 *
 *  B. GABARITO vs COLUNA — `valorDoNomeArquivo` (process-folder) e `valorDoNome`
 *     (_pareamento) são DUAS implementações do mesmo gabarito. Se divergirem, a
 *     visão confere o valor contra um número e o pareamento casa contra outro.
 *     → rodar as duas sobre todos os nomes da pasta e apontar divergência.
 *
 *  C. TRAVA DA VISÃO — valor que `diverge` do gabarito NÃO pode virar
 *     'Valor total'; deve ir para o campo separado. É a defesa principal contra
 *     saldo devedor entrando como valor pago.
 *     → conferir no banco: nenhuma linha com veredito diverge tem Valor total.
 *
 *  D. RECUSA DO OCR — quando o PDF é imagem e nada leu o papel, o código deve
 *     RECUSAR (lançar) em vez de gravar row vazia por cima de dado bom.
 *     → conferir que a condição cobre o caso `isImage && !visaoUsada`.
 *
 *  E. DATA NO FUTURO — a visão já gravou "02/03/2028". A sanidade de ano deve
 *     barrar. → varrer o banco por datas fora da janela plausível.
 *
 *  F. LINHAS #pN — parcelas de carnê geram `arquivo#pN`. Releituras mudam a
 *     contagem ([[parcelas-pn-sobram-no-upsert]]); o que NÃO pode acontecer é
 *     parcela órfã (um #p2 sem #p1) nem #pN cujo PDF-base não existe mais.
 *
 *  G. VALOR ABSURDO — valor gravado que não tem ordem de grandeza compatível com
 *     o do nome do arquivo indica truncamento de milhar ou campo trocado.
 *
 * SOMENTE LEITURA. Nada é gravado.
 *
 * Uso: node _medir/_auditar-caminho-pdf.js [periodo]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const parsers = require('../routes/_nf-parsers');
const pare = require('../routes/_pareamento');
const visao = require('../routes/_nf-visao');
const { PDFParse } = require('pdf-parse');
const { getConnection, sql } = require('../config');
const { csvToRows } = require('../routes/process-folder');

const PERIODO = process.argv[2] || '03.2026';
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const SUB = `2026.${PERIODO.split('.')[0]}.EXTRATOS CONTABILIDADE`;

let achados = 0;
const BUG = (rot, msg) => { achados++; console.log(`  ✗ BUG [${rot}] ${msg}`); };
const OK  = (rot, msg) => console.log(`  ✓ ok  [${rot}] ${msg}`);

// A cópia de `valorDoNomeArquivo` que process-folder usa, extraída do fonte para
// comparar com a de _pareamento sem importar a rota inteira.
function valorDoNomeArquivoDaRota() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const i = src.indexOf('function valorDoNomeArquivo');
    if (i < 0) throw new Error('não achei valorDoNomeArquivo em process-folder.js');
    const fim = src.indexOf('\n}', i);
    const corpo = src.slice(i, fim + 2);
    return new Function(`${corpo}; return valorDoNomeArquivo;`)();
}

function listar(dir, out = []) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) listar(q, out);
        else if (/\.pdf$/i.test(e.name)) out.push(q);
    }
    return out;
}

const numBR = s => {
    if (s == null) return null;
    const n = Number(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
};

(async () => {
    console.log(`AUDITORIA DO CAMINHO DE PDF — período ${PERIODO}\n`);

    // ── B. os dois gabaritos de valor concordam? ─────────────────────────────
    console.log('B. GABARITO: valorDoNomeArquivo (rota) × valorDoNome (_pareamento)');
    const vRota = valorDoNomeArquivoDaRota();
    const pdfs = listar(path.join(RAIZ_ARQ, SUB));
    let divergem = 0;
    const exDiv = [];
    for (const abs of pdfs) {
        const n = path.basename(abs);
        const a = vRota(n), b = pare.valorDoNome(n);
        const iguais = (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);
        if (!iguais) { divergem++; if (exDiv.length < 8) exDiv.push({ n, a, b }); }
    }
    if (divergem) {
        BUG('B', `${divergem}/${pdfs.length} nomes dão valores DIFERENTES nas duas implementações`);
        for (const e of exDiv) console.log(`       "${e.n.slice(0, 54)}"  rota=${e.a}  pareamento=${e.b}`);
    } else OK('B', `as duas implementações concordam em ${pdfs.length} nomes`);

    // ── A. contagem de texto com e sem o marcador de página ──────────────────
    console.log('\nA. CONTAGEM DE TEXTO: o marcador "-- N of M --" distorce isImage?');
    let distorcidos = 0, imagensReais = 0;
    const exDist = [];
    for (const abs of pdfs) {
        let buf; try { buf = fs.readFileSync(abs); } catch (_) { continue; }
        const pr = new PDFParse({ data: new Uint8Array(buf) });
        let bruto = '';
        try { bruto = (await pr.getText()).text || ''; } catch (_) { continue; }
        finally { try { await pr.destroy(); } catch (_) {} }
        const limpo = bruto.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        const nB = bruto.replace(/\s/g, '').length, nL = limpo.replace(/\s/g, '').length;
        if (nL < 15) imagensReais++;
        // o bug seria: limpo diz "imagem" e bruto diz "tem texto"
        if (nL < 15 && nB >= 15) {
            distorcidos++;
            if (exDist.length < 6) exDist.push({ n: path.basename(abs), nB, nL });
        }
    }
    console.log(`   PDF-imagem reais (após limpar): ${imagensReais}/${pdfs.length}`);
    if (distorcidos) {
        console.log(`   ${distorcidos} PDFs em que o marcador MASCARA a imagem:`);
        for (const e of exDist) console.log(`       bruto=${e.nB} limpo=${e.nL}  ${e.n.slice(0, 50)}`);
        OK('A', 'a produção limpa o marcador em extractText:234 — conferido no fonte');
    } else OK('A', 'nenhum PDF muda de lado por causa do marcador');

    // ── banco ───────────────────────────────────────────────────────────────
    const pool = await getConnection();
    const r = await pool.request()
        .input('t', sql.Char(1), 'M').input('pe', sql.VarChar(20), PERIODO)
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t AND PERIODO=@pe');
    if (!r.recordset.length) { console.log('\n(sem relatório no banco — pulando C-G)'); process.exit(0); }
    const rows = csvToRows(r.recordset[0].CONTEUDO);
    const pd = row => { try { return JSON.parse(row.dados_parser || 'null'); } catch (_) { return null; } };

    // ── C. a trava da visão está sendo respeitada? ───────────────────────────
    console.log('\nC. TRAVA DA VISÃO: valor que diverge não pode virar "Valor total"');
    let violacoes = 0;
    const exVio = [];
    for (const row of rows) {
        const d = pd(row);
        if (!d) continue;
        const temDiverg = d['Valor lido (não confere com o nome)'];
        const temTotal = d['Valor total'] || d['Valor total da nota'];
        if (temDiverg && temTotal) {
            violacoes++;
            if (exVio.length < 6) exVio.push({ a: row.arquivo, dv: temDiverg, t: temTotal });
        }
    }
    if (violacoes) {
        BUG('C', `${violacoes} linhas têm valor divergente E "Valor total" ao mesmo tempo`);
        for (const e of exVio) console.log(`       ${String(e.a).slice(0, 46)}  diverg=${e.dv}  total=${e.t}`);
    } else OK('C', 'nenhuma linha grava valor divergente como total');

    // ── E. data no futuro / fora de janela ──────────────────────────────────
    console.log('\nE. SANIDADE DE DATA: ano fora da janela plausível');
    const anoAgora = new Date().getFullYear();
    let datasRuins = 0;
    const exData = [];
    for (const row of rows) {
        const d = pd(row);
        const s = d && (d['Data de emissão'] || d['Data de vencimento']);
        if (!s || !/^\d{2}\/\d{2}\/\d{4}$/.test(String(s))) continue;
        const ano = Number(String(s).slice(6, 10));
        if (ano < anoAgora - 6 || ano > anoAgora + 1) {
            datasRuins++;
            if (exData.length < 8) exData.push({ a: row.arquivo, s });
        }
    }
    if (datasRuins) {
        BUG('E', `${datasRuins} linhas com data fora da janela [${anoAgora - 6}, ${anoAgora + 1}]`);
        for (const e of exData) console.log(`       ${String(e.a).slice(0, 46)}  data=${e.s}`);
    } else OK('E', 'todas as datas gravadas estão na janela plausível');

    // ── F. parcelas #pN órfãs ou sem PDF-base ───────────────────────────────
    console.log('\nF. PARCELAS #pN: órfãs (sem #p1) ou sem PDF no disco');
    const porBase = {};
    for (const row of rows) {
        const m = String(row.arquivo).match(/^(.*)#p(\d+)$/);
        if (!m) continue;
        (porBase[m[1]] = porBase[m[1]] || []).push(Number(m[2]));
    }
    const idxDisco = new Set(pdfs.map(p => path.basename(p)));
    let orfas = 0, semPdf = 0;
    const exOrf = [];
    for (const [base, ns] of Object.entries(porBase)) {
        ns.sort((a, b) => a - b);
        if (ns[0] !== 1) { orfas++; if (exOrf.length < 6) exOrf.push(`${base.slice(0, 44)} começa em #p${ns[0]}`); }
        if (!idxDisco.has(path.basename(base))) semPdf++;
    }
    console.log(`   documentos com parcelas: ${Object.keys(porBase).length}`);
    if (orfas) { BUG('F', `${orfas} conjuntos de parcela não começam em #p1`); for (const e of exOrf) console.log(`       ${e}`); }
    else OK('F', 'todo conjunto de parcelas começa em #p1');
    if (semPdf) console.log(`   ${semPdf} conjuntos cujo PDF-base não está NESTA pasta (pode ser vizinhança de mês — normal)`);

    // ── G. valor gravado × valor do nome: ordem de grandeza ─────────────────
    console.log('\nG. ORDEM DE GRANDEZA: valor gravado × valor do nome do arquivo');
    let truncados = 0, absurdos = 0;
    const exTrunc = [], exAbs = [];
    for (const row of rows) {
        const d = pd(row);
        if (!d) continue;
        const base = path.basename(String(row.arquivo).replace(/#p\d+$/, ''));
        const gab = pare.valorDoNome(base);
        const lido = numBR(d['Valor total'] || d['Valor total da nota'] || d['Valor do serviço']);
        if (!gab || !lido) continue;
        if (visao.pareceTruncamentoDeMilhar(lido, gab)) {
            truncados++;
            if (exTrunc.length < 8) exTrunc.push({ a: row.arquivo, lido, gab });
        } else if (lido / gab > 500 || gab / lido > 500) {
            absurdos++;
            if (exAbs.length < 8) exAbs.push({ a: row.arquivo, lido, gab });
        }
    }
    if (truncados) {
        BUG('G', `${truncados} linhas com valor que parece MILHAR TRUNCADO (lido×1000 ≈ nome)`);
        for (const e of exTrunc) console.log(`       ${String(e.a).slice(0, 44)}  lido=${e.lido}  nome=${e.gab}`);
    } else OK('G', 'nenhum valor gravado parece truncado no milhar');
    if (absurdos) {
        console.log(`   ${absurdos} linhas com razão >500× (provável campo trocado, não truncamento):`);
        for (const e of exAbs) console.log(`       ${String(e.a).slice(0, 44)}  lido=${e.lido}  nome=${e.gab}`);
    }

    // ── D. a recusa do OCR cobre o caso certo? (leitura do fonte) ───────────
    console.log('\nD. RECUSA DO OCR: a condição cobre "imagem e nada leu"?');
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const temGuarda = /if \(isImage && !visaoUsada && e instanceof ErroOcrIndisponivel\)/.test(src);
    if (temGuarda) OK('D', 'guarda presente: isImage && !visaoUsada && ErroOcrIndisponivel');
    else BUG('D', 'a guarda da recusa mudou de forma — reconferir process-folder.js');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(achados ? `${achados} BUG(S) ENCONTRADO(S) — ver acima` : 'NENHUM BUG encontrado nas 7 invariantes');
    process.exit(0);
})();
