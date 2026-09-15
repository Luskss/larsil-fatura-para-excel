/**
 * _medir/_por-que-deslocado.js — os 160 documentos "+1 mês" estão fora do lugar,
 * ou o lugar deles é esse mesmo?
 *
 * `onde-esta-o-pdf.js` chamou de DESLOCADO todo par casado em pasta vizinha,
 * usando o mês do LANÇAMENTO como "onde deveria estar". Mas o primeiro exemplo já
 * levanta a dúvida: "011.DOC- 354,90-2026.03.31.CIT..." está na pasta 2026.04.01
 * — data do documento 31/03, arquivado em 01/04. Um dia de diferença, não um mês.
 *
 * Se a data NO NOME do documento cai no mês do lançamento, o papel está no lugar
 * certo pela lógica de arquivamento (arquiva-se quando chega) e chamar de
 * "deslocado" é ruído. O que sobra — data do nome em mês realmente diferente — é
 * a lista curta que vale conferir.
 *
 * Uso: node _medir/_por-que-deslocado.js [MM.AAAA]
 */
'use strict';
const h = require('./harness');
const ocr = require('./ocr');
const P = require('../routes/_pareamento');

const periodoArg = process.argv[2] || '03.2026';
const pastaDoPeriodo = p => { const [m, a] = String(p).split('.'); return `${a}.${m}`; };
const mesDoPeriodo = p => { const [m, a] = String(p).split('.'); return `${a}.${m}`; };

// "AAAA.MM" da data embutida no NOME do arquivo, se houver
function mesNoNome(nome) {
    const n = String(nome || '');
    let m = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (m) return `${m[1]}.${m[2]}`;
    m = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

// "AAAA.MM" da subpasta (…/2026.04.01/…)
function mesNaPasta(rel) {
    const s = String(rel || '').replace(/\\/g, '/');
    let m = s.match(/(?:^|\/)(20\d{2})\.(\d{2})\.(\d{2})(?:\/|$)/);
    if (m) return `${m[1]}.${m[2]}`;
    m = s.match(/(?:^|\/)(\d{2})\.(\d{2})\.(20\d{2})(?:\/|$)/);
    if (m) return `${m[3]}.${m[2]}`;
    return null;
}

(async () => {
    const c = h.carregar();
    const idx = await ocr.indexar();
    const itens = (c.planilha[periodoArg] || {}).itens || [];
    const lancamentos = itens.map(P.lancamentoDaPlanilha).filter(Boolean);

    const documentosPorMes = {};
    for (const [mes, arquivos] of Object.entries(c.pasta.arquivosPorMes || {})) {
        documentosPorMes[mes] = arquivos.map(a => {
            const doc = P.documentoDoArquivo(a.nome, a.rel);
            const o = idx ? idx[a.nome] : null;
            return o ? P.enriquecerComOcr(doc, o) : doc;
        });
    }

    const r = P.conferirPeriodo(lancamentos, documentosPorMes, periodoArg);
    const mesLanc = mesDoPeriodo(periodoArg);

    let dataDoNomeBate = 0, dataDoNomeDifere = 0, semDataNoNome = 0;
    const realmenteFora = [];
    const ruido = [];

    for (const par of r.paresVizinhos) {
        const nome = par.documento.arquivo;
        const mn = mesNoNome(nome);
        if (!mn) { semDataNoNome++; continue; }
        if (mn === mesLanc) {
            dataDoNomeBate++;
            if (ruido.length < 5) ruido.push({ nome, pasta: mesNaPasta(par.documento.caminho), mn });
        } else {
            dataDoNomeDifere++;
            if (realmenteFora.length < 12)
                realmenteFora.push({ nome, pasta: mesNaPasta(par.documento.caminho), mn, off: par.deslocamento });
        }
    }

    const tot = r.paresVizinhos.length;
    const pct = n => (tot ? `${(100 * n / tot).toFixed(1)}%` : '—');

    console.log(`período ${periodoArg} — ${tot} pares casados em pasta vizinha\n`);
    console.log('a DATA NO NOME do documento, comparada ao mês do lançamento:');
    console.log(`  cai no mês do lançamento   ${String(dataDoNomeBate).padStart(4)}  ${pct(dataDoNomeBate)}   ← papel do mês certo, só arquivado na pasta seguinte`);
    console.log(`  cai em OUTRO mês           ${String(dataDoNomeDifere).padStart(4)}  ${pct(dataDoNomeDifere)}   ← candidato real a fora do lugar`);
    console.log(`  sem data no nome           ${String(semDataNoNome).padStart(4)}  ${pct(semDataNoNome)}`);

    if (ruido.length) {
        console.log('\n── exemplos do 1º grupo (documento do mês certo, pasta seguinte) ──');
        for (const e of ruido)
            console.log(`  data no nome ${e.mn}  ·  pasta ${e.pasta}  ·  ${e.nome.slice(0, 62)}`);
    }
    if (realmenteFora.length) {
        console.log('\n── 2º grupo: data do nome em mês diferente do lançamento ──');
        for (const e of realmenteFora)
            console.log(`  nome ${e.mn}  ·  pasta ${e.pasta}  ·  ${String(e.off).padStart(2)}  ${e.nome.slice(0, 56)}`);
    }
})();
