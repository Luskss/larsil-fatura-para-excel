/**
 * _medir/_medir-sinal4.js — o "sinal 4" de `pareceMultiBoleto` (≥2 páginas) carrega
 * sozinho quantos carnês legítimos?
 *
 * Contexto: `004.DOC-430000,00-PIX ENVIADO Macponta.pdf` é um CONTRATO de leasing de
 * 16 páginas que virou 45 parcelas, porque o sinal 4 basta para mandar o documento à
 * IA de carnê, e num contrato a IA CONFIRMA — as parcelas estão escritas no papel
 * ("48 parcelas iguais e consecutivas de R$ 6.798,65").
 *
 * A hipótese a medir: exigir um segundo sinal junto com "≥2 páginas" mata o falso
 * positivo sem perder carnê real.
 *
 * ── O que se mede, e por que não é a taxa de acerto da IA ────────────────────
 * Este script NÃO chama a IA (custaria caro e o pré-filtro é anterior a ela). Mede o
 * PRÉ-FILTRO contra o VEREDITO JÁ GRAVADO no banco: um documento cujo `arquivo`
 * aparece como "nome.pdf#pN" é um carnê que a IA confirmou. Então:
 *
 *   - perda   = documento com #pN no banco que a variante DEIXARIA de mandar à IA
 *   - ganho   = documento SEM #pN que a variante deixaria de mandar (chamada poupada)
 *
 * A perda é o número que decide: um carnê real que não chega à IA vira 1 linha só, e
 * as parcelas somem do relatório. Ganho é economia; perda é dado errado.
 *
 * ── Por que fatiar o fonte em vez de copiar a função ────────────────────────
 * Mesma razão de `_reprocessar-restantes.js`: copiar a regex faria a medição descrever
 * uma versão que não é a que roda. `pareceMultiBoleto` usa `norm` de _nf-parsers.
 *
 * Uso:
 *   node _medir/_medir-sinal4.js 04.2026            um mês
 *   node _medir/_medir-sinal4.js --todos            os 6 períodos
 *   ... --csv saida.csv                             detalha cada divergência
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
const { norm } = require('../routes/_nf-parsers');

// `pareceMultiBoleto` é interna. Extraída do FONTE para medir o que roda de verdade.
const pareceMultiBoleto = (() => {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const ini = src.indexOf('function pareceMultiBoleto');
    const fim = src.indexOf('// "DD/MM/AAAA" →');
    if (ini < 0 || fim < 0) throw new Error('não achei pareceMultiBoleto em process-folder.js');
    const mod = { exports: {} };
    new Function('module', 'norm', `${src.slice(ini, fim)}\nmodule.exports = pareceMultiBoleto;`)(mod, norm);
    return mod.exports;
})();

// Os sinais, separados — o original devolve boolean e não diz QUAL disparou.
function sinais(text, pages) {
    const t = norm(text);
    const ehBoleto = /NOSSO N[UÚ]MERO|FICHA DE COMPENSA|\bCEDENTE\b|BENEFICI[AÁ]RIO|LINHA DIGIT[AÁ]VEL|\bPAGADOR\b|\bSACADO\b/.test(t);
    if (!ehBoleto) return { ehBoleto: false, s1: false, s2: false, s3: false, s4: false };
    const linhas = new Set((t.match(/\d{5}[.\s]\d{5}\s+\d{5}[.\s]\d{6}\s+\d{5}[.\s]\d{6}\s+\d\s+\d{14}/g) || []));
    const nossos = new Set((t.match(/NOSSO N[UÚ]MERO\D{0,8}([\d./-]{6,})/g) || []));
    const vencs  = new Set((t.match(/VENCIMENTO\D{0,8}(\d{2}[/.]\d{2}[/.]\d{2,4})/g) || []));
    const np = parseInt(pages, 10);
    return {
        ehBoleto: true,
        s1: linhas.size >= 2,
        s2: nossos.size >= 2,
        s3: vencs.size >= 2,
        s4: Number.isFinite(np) && np >= 2,
    };
}

const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;
const PERIODOS = TODOS
    ? ['01.2026', '02.2026', '03.2026', '04.2026', '05.2026', '06.2026']
    : [args.find(a => /^\d{2}\.\d{4}$/.test(a))].filter(Boolean);

if (!PERIODOS.length) {
    console.error('informe MM.AAAA ou --todos');
    process.exit(1);
}

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const baseNome = (n) => String(n || '').replace(/#p\d+$/i, '').trim().toLowerCase();

(async () => {
    // ── quem o BANCO diz que é carnê (a IA confirmou: gravou #pN) ────────────
    const pool = await getConnection();
    const rs = await pool.request()
        .query("SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const parcelasPorNome = new Map();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            if (!/#p\d+$/i.test(row.arquivo)) continue;
            const k = baseNome(row.arquivo);
            parcelasPorNome.set(k, (parcelasPorNome.get(k) || 0) + 1);
        }
    }
    console.log(`banco: ${parcelasPorNome.size} documento(s) com parcelas (#pN)\n`);

    const linhasCsv = [['periodo', 'arquivo', 'paginas', 'parcelas_no_banco',
                        'atual', 'variante', 'sinais', 'efeito'].join(';')];
    let tot = { docs: 0, atualSim: 0, varSim: 0, perdas: 0, ganhos: 0, semTexto: 0 };

    for (const PERIODO of PERIODOS) {
        const [MM, AAAA] = PERIODO.split('.');
        const dir = path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`);
        let pdfs = [];
        try { pdfs = await pf.collectPdfs(dir); }
        catch (e) { console.log(`${PERIODO}: pasta inacessível (${e.message})`); continue; }

        let atualSim = 0, varSim = 0, perdas = 0, ganhos = 0, semTexto = 0;
        const exemplosPerda = [], exemplosGanho = [];

        for (const pdf of pdfs) {
            let text = '', pages = 1;
            try {
                // `collectPdfs` já devolve `path` absoluto — remontá-lo a partir de
                // `folder`+`name` erra o caminho e devolveria 0 documentos em silêncio.
                const buf = await fs.promises.readFile(pdf.path);
                const parser = new PDFParse({ data: new Uint8Array(buf) });
                try {
                    const r = await parser.getText();
                    text = (r.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
                    pages = r.total || (Array.isArray(r.pages) ? r.pages.length : 1);
                } finally { try { await parser.destroy(); } catch (_) {} }
            } catch (e) { semTexto++; continue; }

            // PDF-imagem: sem OCR aqui o texto é vazio e o pré-filtro não opina.
            // Contá-lo como "não é carnê" inventaria um ganho que não existe.
            if (text.replace(/\s/g, '').length < 15) { semTexto++; continue; }

            const s = sinais(text, pages);
            const atual = pareceMultiBoleto(text, pages);
            // VARIANTE: sinal 4 precisa de companhia (s1, s2 ou s3).
            const variante = s.ehBoleto && (s.s1 || s.s2 || s.s3);

            const nParc = parcelasPorNome.get(baseNome(pdf.name)) || 0;
            const ehCarneReal = nParc > 1;

            tot.docs++;
            if (atual) { atualSim++; tot.atualSim++; }
            if (variante) { varSim++; tot.varSim++; }

            let efeito = '';
            if (atual && !variante) {
                if (ehCarneReal) { perdas++; tot.perdas++; efeito = 'PERDA'; exemplosPerda.push({ pdf, pages, nParc, s }); }
                else { ganhos++; tot.ganhos++; efeito = 'ganho'; exemplosGanho.push({ pdf, pages, s }); }
            }
            if (CSV && efeito) {
                const marca = ['s1','s2','s3','s4'].filter(k => s[k]).join('+') || '-';
                linhasCsv.push([PERIODO, `"${pdf.name}"`, pages, nParc, atual ? 'sim' : 'nao',
                                variante ? 'sim' : 'nao', marca, efeito].join(';'));
            }
        }

        console.log(`── ${PERIODO} ─────────────────────────────────`);
        console.log(`   documentos com texto : ${pdfs.length - semTexto} (${semTexto} imagem/erro)`);
        console.log(`   atual  manda à IA    : ${atualSim}`);
        console.log(`   variante manda à IA  : ${varSim}`);
        console.log(`   PERDAS (carnê real)  : ${perdas}`);
        console.log(`   ganhos (chamadas -)  : ${ganhos}`);
        for (const e of exemplosPerda.slice(0, 5)) {
            console.log(`      PERDA: ${e.pdf.name.slice(0, 60)} (${e.pages}p, ${e.nParc} parcelas)`);
        }
        for (const e of exemplosGanho.slice(0, 3)) {
            console.log(`      ganho: ${e.pdf.name.slice(0, 60)} (${e.pages}p)`);
        }
        console.log('');
    }

    console.log(`══ TOTAL ════════════════════════════════════`);
    console.log(`   documentos avaliados : ${tot.docs}`);
    console.log(`   atual  → IA          : ${tot.atualSim}`);
    console.log(`   variante → IA        : ${tot.varSim}`);
    console.log(`   PERDAS               : ${tot.perdas}   ← carnê real que deixaria de ser detectado`);
    console.log(`   ganhos               : ${tot.ganhos}   ← chamadas de IA poupadas`);

    if (CSV) {
        fs.writeFileSync(path.join(RAIZ, CSV), linhasCsv.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV} (${linhasCsv.length - 1} divergências)`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
