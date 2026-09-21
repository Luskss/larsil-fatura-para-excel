/**
 * _medir/_fila-11-anatomia.js — os 11 finais, com tudo que ajuda a decidir
 *
 * A fila caiu de 52 → 32 → 11 depois de desligar a força 1
 * ([[forca-1-desligada-implementado.md]]): 21 dos 32 eram alertas em pares FALSOS
 * — não eram divergência de tipo, era documento errado.
 *
 * Os 11 que sobram têm o fornecedor BATENDO (INGA↔INGA, FARO↔FARO,
 * CENTRALMAQ↔CENTRALMAQ), então são divergências de tipo de verdade.
 *
 * Antes de entregar, duas checagens que podem fechar mais alguns:
 *
 *   1. RODONAVES é TRANSPORTADORA — cai na regra já absolvida
 *      ([[nf-para-cte-nao-e-defeito]])? O banco leu FATURA, não CTE, então a
 *      regra atual não o pegou. Ver o que o papel diz.
 *
 *   2. Vários têm VALOR DO NOME ≠ valor lançado (INGA 1333,60 × 4.000,00;
 *      FARO 200,00 × 3.649,00; SAVANA 208,95 × 835,78). Isso é parcelamento
 *      ([[total-da-nota-nao-e-valor-lancado]]) — o documento é de UMA parcela e o
 *      lançamento é o total. Vale sinalizar na planilha para quem confere não
 *      estranhar.
 *
 *   3. o nome do arquivo tem marcador de tipo? é a terceira testemunha.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|\bRODONAVES\b|PRINCESA DOS CAMPOS|\bACITEL\b|\bCADORE\b|SAVACINSK|\bJB PRESTACAO\b/;
const ACESSORIO = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const FATURA_RECORRENTE = /TRACKPLUS|RIO DOCE NET|MEGA REDES|\bBIOS ?NET\b|ALLREDE|\bCEMIG\b|EQUATORIAL|SANESUL|ELEKTRO|EMBASA|\bVIVO\b|\bCLARO\b|\bTIM\b|FIG TELECOM|ECONET/;

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
const marcador = ev => { const e = norm(ev); return /^IA:/.test(e) ? '' : (MARCADOR_FORTE[e] || ''); };
// tipo declarado no NOME do arquivo — testemunha que não classifica
function tipoDoNome(nome) {
    const t = norm(nome);
    if (/\bNFS-?E?\b/.test(t)) return 'NFS';
    if (/\bCT-?E\b|\bDACTE\b/.test(t)) return 'CTE';
    if (/\bRECIBO\b/.test(t)) return 'RECIBO';
    if (/\b(RCB|RC|REC)\s*\.?\s*\d{3,}/.test(t)) return '';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t)) return 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t)) return 'FATURA';
    return '';
}
function carregarTipoBate() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const tipoBate = carregarTipoBate();
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const vn = p.valorDoNome;

    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE'), iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]); const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    const itens = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[base(x.documento.arquivo)] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab) continue;
            const arq = x.documento.arquivo;
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;
            const ev = String(info.evidencia || '').trim();
            const ctx = norm(arq + ' ' + (x.lancamento.entidade || '') + ' ' + ev);
            // filtros de bloco já aplicados em _fila-fechar-em-bloco
            if (/MACPONTA/i.test(ctx)) continue;
            if (marcador(ev) && marcador(ev) === lido) continue;
            if (norm(ev) === 'GUIA') continue;
            if (lido === 'CTE' && TRANSPORTADOR.test(ctx)) continue;
            if (lido === 'FATURA' && FATURA_RECORRENTE.test(ctx)) continue;
            if (lido === 'FATURA' && ACESSORIO.test(norm(arq))) continue;
            itens.push({
                periodo, arq, planilha: gab, banco: lido, evid: ev,
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                valorNome: Math.abs(Number(vn(arq)) || 0),
                forn: String(x.lancamento.entidade || ''),
                nf: String(x.lancamento.nf || ''),
                caminho: x.documento.caminho || '',
                forca: x.forca,
                nomeDiz: tipoDoNome(arq),
                transportadora: TRANSPORTADOR.test(ctx),
            });
        }
    }

    console.log('═'.repeat(78));
    console.log(`OS ${itens.length} ITENS DA FILA — anatomia`);
    console.log('═'.repeat(78));

    // (1) transportadora escondida
    const transp = itens.filter(x => x.transportadora);
    console.log(`\n── (1) é transportadora mas o banco NÃO leu CTE: ${transp.length}`);
    for (const x of transp)
        console.log(`      ${x.periodo} ${brl(x.valor).padStart(12)}  banco=${x.banco}  ${x.arq.slice(0, 44)}`);

    // (2) valor do nome × lançado
    console.log('\n── (2) o valor do NOME bate com o lançado? ────────────────');
    let bate = 0, parcela = 0, outro = 0;
    for (const x of itens) {
        if (!x.valorNome) { outro++; continue; }
        if (Math.abs(x.valorNome - x.valor) < 0.02) { bate++; continue; }
        const r = x.valor / x.valorNome;
        const n = Math.round(r);
        if (n >= 2 && n <= 24 && Math.abs(r - n) / n < 0.02) parcela++;
        else outro++;
    }
    console.log(`      bate exato:              ${bate}`);
    console.log(`      lançado = N × o do nome: ${parcela}  ← parcelamento, normal`);
    console.log(`      outra relação:           ${outro}`);

    // (3) a terceira testemunha
    console.log('\n── (3) o NOME do arquivo declara tipo? ────────────────────');
    let confirmaBanco = 0, confirmaPlanilha = 0, mudo = 0;
    for (const x of itens) {
        if (!x.nomeDiz) { mudo++; continue; }
        if (x.nomeDiz === x.banco) confirmaBanco++;
        else if (x.nomeDiz === x.planilha) confirmaPlanilha++;
    }
    console.log(`      nome concorda com o BANCO:    ${confirmaBanco}`);
    console.log(`      nome concorda com a PLANILHA: ${confirmaPlanilha}  ← o banco provavelmente errou`);
    console.log(`      nome mudo:                    ${mudo}`);

    // (4) a lista, pronta para conferência
    console.log(`\n${'═'.repeat(78)}`);
    console.log('A LISTA');
    console.log('═'.repeat(78));
    for (const x of itens.sort((a, b) => b.valor - a.valor)) {
        console.log(`\n   ${x.periodo}  ${brl(x.valor)}   ${x.planilha} × ${x.banco}   força ${x.forca}`);
        console.log(`      ${x.arq.slice(0, 66)}`);
        console.log(`      fornecedor: ${x.forn.slice(0, 44)}  NF=${x.nf}`);
        console.log(`      nome diz: ${x.nomeDiz || '—'}   valor no nome: ${x.valorNome ? brl(x.valorNome) : '—'}`);
        console.log(`      evidência: "${x.evid.slice(0, 46)}"`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
