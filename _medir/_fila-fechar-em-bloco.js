/**
 * _medir/_fila-fechar-em-bloco.js — quantos dos 45 dão para fechar sem abrir o PDF?
 *
 * ESTADO (`_fila-ainda-vale.js`): a fila tem 57 alertas, dos quais 45 "sem
 * testemunha do papel". Conferir 45 PDFs à mão é caro. Mas as famílias sugerem
 * que boa parte já tem veredito de sessões anteriores:
 *
 *   NF→CTE (5) + NFS→CTE (1): EXPRESSO PRINCESA, PRINCESA DOS CAMPOS, GOMES E
 *     SAVACINSKI — transportadoras. Já ABSOLVIDO em [[nf-para-cte-nao-e-defeito]]:
 *     o papel é CT-e e a planilha lança frete como nota.
 *
 *   NF→FATURA (12) + NFS→FATURA (6): a REGRA DE PACOTE
 *     ([[regra-de-pacote-inverte-nf-em-fatura]]). Onde o nome tem "+BOL" o
 *     `tipoBate` já absolve; os que sobram são os SEM marcador de acessório.
 *
 * ── O que este script faz ───────────────────────────────────────────────────
 * Aplica os vereditos já medidos e separa:
 *   • FECHA EM BLOCO — família com veredito anterior + o item se encaixa
 *   • ABRIR O PDF    — sem veredito aplicável
 *
 * O objetivo é entregar ao usuário a menor lista possível de PDFs para abrir.
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

const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|\bRODONAVES\b|PRINCESA DOS CAMPOS|\bACITEL\b|\bCADORE\b|SAVACINSK|\bJB PRESTACAO\b|\bGOMES E\b/;
const ACESSORIO = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
// serviço recorrente cobrado por fatura mensal (concessionária/telecom/rastreio)
const FATURA_RECORRENTE = /TRACKPLUS|RIO DOCE NET|MEGA REDES|\bBIOS ?NET\b|ALLREDE|\bCEMIG\b|EQUATORIAL|SANESUL|ELEKTRO|EMBASA|\bVIVO\b|\bCLARO\b|\bOI\b|\bTIM\b|FIG TELECOM/;

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

    const alertas = [];
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
            alertas.push({ periodo, arq, planilha: gab, banco: lido,
                           evid: String(info.evidencia || '').trim(),
                           papel: marcador(info.evidencia),
                           valor: Math.abs(Number(x.lancamento.valor) || 0),
                           forn: String(x.lancamento.entidade || ''),
                           caminho: x.documento.caminho || '',
                           nf: String(x.lancamento.nf || '') });
        }
    }

    // ── aplicar os vereditos conhecidos ────────────────────────────────────
    const fechado = [], abrir = [];
    for (const a of alertas) {
        const ctx = norm(a.arq + ' ' + a.forn + ' ' + a.evid);
        let motivo = null;

        if (/MACPONTA/i.test(ctx)) motivo = 'MACPONTA — adiantamento já auditado';
        else if (a.papel && a.papel === a.banco) motivo = `o papel diz "${a.evid}" — o banco leu certo`;
        else if (norm(a.evid) === 'GUIA') motivo = 'GUIA — já corrigido no código, some na releitura';
        else if (a.banco === 'CTE' && TRANSPORTADOR.test(ctx))
            motivo = 'transportadora — o papel é CT-e e a planilha lança frete como nota';
        else if (a.banco === 'FATURA' && FATURA_RECORRENTE.test(ctx))
            motivo = 'serviço recorrente cobrado por fatura mensal';
        else if (a.banco === 'FATURA' && ACESSORIO.test(norm(a.arq)))
            motivo = 'pacote nota+boleto — a IA elegeu o boleto';

        if (motivo) fechado.push({ ...a, motivo });
        else abrir.push(a);
    }

    const soma = arr => arr.reduce((s, a) => s + a.valor, 0);
    console.log('═'.repeat(78));
    console.log('A FILA, DEPOIS DE APLICAR OS VEREDITOS JÁ MEDIDOS');
    console.log('═'.repeat(78));
    console.log(`\n   alertas no painel:        ${alertas.length}   ${brl(soma(alertas))}`);
    console.log(`   FECHA em bloco:           ${fechado.length}   ${brl(soma(fechado))}`);
    console.log(`   ABRIR o PDF:              ${abrir.length}   ${brl(soma(abrir))}  ← a fila real`);

    console.log('\n── por que cada um fecha ───────────────────────────────────');
    const porMotivo = new Map();
    for (const f of fechado) {
        if (!porMotivo.has(f.motivo)) porMotivo.set(f.motivo, []);
        porMotivo.get(f.motivo).push(f);
    }
    for (const [m, arr] of [...porMotivo].sort((a, b) => b[1].length - a[1].length))
        console.log(`   ${String(arr.length).padStart(3)}  ${brl(soma(arr)).padStart(16)}   ${m}`);

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`OS ${abrir.length} QUE PRECISAM DE OLHO HUMANO`);
    console.log('═'.repeat(78));
    for (const a of abrir.sort((x, y) => y.valor - x.valor)) {
        console.log(`\n   ${a.periodo}  ${brl(a.valor).padStart(14)}   planilha=${a.planilha} × banco=${a.banco}`);
        console.log(`      ${a.arq.slice(0, 64)}`);
        console.log(`      fornecedor: ${a.forn.slice(0, 40)}   NF=${a.nf}`);
        console.log(`      evidência: "${a.evid.slice(0, 44)}"`);
        if (a.caminho) console.log(`      pasta: ${a.caminho.slice(0, 60)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
