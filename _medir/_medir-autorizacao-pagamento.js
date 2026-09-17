/**
 * _medir/_medir-autorizacao-pagamento.js — quantos documentos são "Autorização de
 * Pagamento" (layout Rautpag-015), e quantos deles ficam SEM valor?
 *
 * Nasceu em 17/09/2026: ao desligar a âncora no caminho local, um documento perdeu o
 * valor inteiro (ARI SELESTRINO, R$ 600,00 → vazio). A âncora não estava acertando
 * por mérito — era a ÚNICA fonte, porque nenhum parser cobre esse layout
 * (`grep -rn Rautpag routes/` não devolve nada).
 *
 * O layout é padronizado (relatório do ERP) e tem o valor numa posição fixa:
 *
 *   Empresa Tipo Fornecedor Nº Doc. Parcela Prog Emissão Vencimento Valor
 *   3   5   112837 901443   1/1   1 01/01/2026 15/01/2026   600,00
 *
 * O último número da linha de dados é o valor. Este script NÃO implementa isso — ele
 * mede o tamanho do problema antes, para decidir se vale um parser.
 *
 * Uso: node _medir/_medir-autorizacao-pagamento.js --todos [--csv saida.csv]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const { PDFParse } = require('pdf-parse');
const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const { paraNumero } = require('../routes/_valor-do-pagamento');

const valorDoNomeArquivo = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const L = src.split(/\r?\n/);
    const i = L.findIndex(x => x.startsWith('function valorDoNomeArquivo'));
    let f = -1;
    for (let j = i + 1; j < L.length; j++) if (L[j] === '}') { f = j; break; }
    const mod = { exports: {} };
    new Function('module', `${L.slice(i, f + 1).join('\n')}\nmodule.exports = valorDoNomeArquivo;`)(mod);
    return mod.exports;
})();
if (valorDoNomeArquivo('019.DOC- 600,00 - x.pdf') !== 600) throw new Error('régua quebrada');

const args = process.argv.slice(2);
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;
const ALVO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
const periodos = args.includes('--todos')
    ? ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026'] : [ALVO].filter(Boolean);
if (!periodos.length) { console.error('informe MM.AAAA ou --todos'); process.exit(1); }

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// A linha de dados do Rautpag: termina em valor monetário, precedida de datas.
const RE_LINHA_DADOS = /^[\d\s\t]+\d{2}\/\d{2}\/\d{4}[\s\t]+\d{2}\/\d{2}\/\d{4}[\s\t]+((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})\s*$/m;

(async () => {
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const noBanco = new Map();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo || /#p\d+$/i.test(row.arquivo)) continue;
            let pd = {};
            try { pd = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
            noBanco.set(row.arquivo.toLowerCase(), pd);
        }
    }

    let total = 0, rautpag = 0, semValorNoBanco = 0, achaPelaLinha = 0, bateComNome = 0;
    const linhas = [['periodo','arquivo','valor_nome','valor_banco','valor_pela_linha'].join(';')];
    const exemplos = [];

    for (const p of periodos) {
        const [MM, AAAA] = p.split('.');
        let pdfs = [];
        try { pdfs = await pf.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`)); }
        catch (_) { console.log(`${p}: pasta inacessível`); continue; }

        for (const pdf of pdfs) {
            total++;
            let text = '';
            try {
                const parser = new PDFParse({ data: new Uint8Array(await fs.promises.readFile(pdf.path)) });
                try {
                    const r = await parser.getText();
                    text = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
                } finally { try { await parser.destroy(); } catch (_) {} }
            } catch (_) { continue; }
            if (!/Rautpag-015|AUTORIZA[ÇC][ÃA]O\s+DE\s+PAGAMENTO/i.test(text)) continue;
            rautpag++;

            const pd = noBanco.get(pdf.name.toLowerCase()) || {};
            const vBanco = paraNumero(pd['Valor total']);
            const vNome = valorDoNomeArquivo(pdf.name);
            if (vBanco == null) semValorNoBanco++;

            const m = text.match(RE_LINHA_DADOS);
            const vLinha = m ? paraNumero(m[1]) : null;
            if (vLinha != null) {
                achaPelaLinha++;
                if (vNome != null && Math.abs(vLinha - vNome) <= 0.02) bateComNome++;
            }

            if (CSV) linhas.push([p, `"${pdf.name}"`,
                vNome == null ? '' : String(vNome).replace('.', ','),
                vBanco == null ? '' : String(vBanco).replace('.', ','),
                vLinha == null ? '' : String(vLinha).replace('.', ',')].join(';'));
            if (exemplos.length < 10) exemplos.push({ p, n: pdf.name, vNome, vBanco, vLinha });
        }
    }

    console.log(`══ AUTORIZAÇÃO DE PAGAMENTO (Rautpag-015) ═══════════════`);
    console.log(`   documentos varridos      : ${total}`);
    console.log(`   com o layout             : ${rautpag}`);
    console.log(`   sem valor no banco       : ${semValorNoBanco}`);
    console.log(`\n   ── a linha de dados resolve? ──`);
    console.log(`   valor achado pela linha  : ${achaPelaLinha} / ${rautpag}`);
    console.log(`   bate com o nome          : ${bateComNome} / ${achaPelaLinha}`);
    if (achaPelaLinha) console.log(`   precisão                 : ${(100 * bateComNome / achaPelaLinha).toFixed(1)}%`);

    console.log(`\n   exemplos:`);
    for (const e of exemplos) {
        console.log(`      ${e.p}  nome=${e.vNome == null ? '—' : BRL(e.vNome)}  banco=${e.vBanco == null ? 'VAZIO' : BRL(e.vBanco)}  linha=${e.vLinha == null ? '—' : BRL(e.vLinha)}`);
        console.log(`         ${e.n.slice(0, 66)}`);
    }
    if (CSV) {
        fs.writeFileSync(path.join(RAIZ, CSV), linhas.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
