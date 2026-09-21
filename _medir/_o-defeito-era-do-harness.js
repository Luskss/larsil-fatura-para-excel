/**
 * _medir/_o-defeito-era-do-harness.js — os "58 valores errados" são do MEU índice
 *
 * ACHADO FINAL (21/09/2026). O caminho até aqui:
 *
 *   1. "58 pares com valor errado, 18 são LOCALIZA"        → parecia defeito do produto
 *   2. "a trava bol<base barra a linha digitável"          → causa plausível, implementei
 *   3. "11 curados, 0 quebrados" conferido com a produção  → parecia aprovado
 *   4. o teste do carnê revelou que as 11 eram linhas #pN
 *   5. e agora: as linhas de DOCUMENTO já estão CERTAS no banco
 *
 * Olhando as linhas reais do LOCALIZA FAT 26267:
 *
 *     ...pdf#p2   origem="conteúdo (fraco)"   Valor total = 5368,68    ← errada
 *     ...pdf      origem="IA"                 Valor total = 91288,49   ← CERTA
 *
 * O produto já resolve: o caminho da IA gravou o valor certo, com
 * `Origem do valor pago: "boleto"` — a trava nem chegou a barrar nada.
 *
 * ── O defeito está em `_medir/ocr.js` ───────────────────────────────────────
 * Linha 95:  `const arq = arquivoBase(campos[iArq])`  → remove o `#pN`
 * Linha 112: `if (valor != null && at.valor == null)` → fica com o PRIMEIRO
 *
 * As linhas `#pN` aparecem ANTES no CSV, então o valor da PARCELA sobrescreve o do
 * documento. Todo par medido com esse índice recebeu o valor da parcela.
 *
 * É o mesmo erro de [[cache-do-harness-falseia-medicao]] e de
 * [[o-script-de-efeito-mentia]]: a ferramenta mente e a conclusão do dia vira
 * artefato. E é a terceira vez nesta sessão que `#pN` me engana
 * ([[parcelas-pn-sobram-no-upsert]]).
 *
 * ── O que este script prova ─────────────────────────────────────────────────
 * Refaz o índice PREFERINDO a linha sem sufixo e remede os 58.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const ehParcela = s => /#p\d+$/i.test(String(s || ''));
const semPN = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const { paraNumero, paraData, soDigitos } = require('./ocr');
function primeiro(obj, chaves) {
    for (const k of chaves) { const v = obj[k]; if (v != null && String(v).trim() !== '') return v; }
    return null;
}

(async () => {
    const { getConnection } = require('../config');
    const pool = await getConnection();
    const rs = await pool.request().input('tipo', 'M')
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = @tipo');
    const sep = (l) => {
        const o = []; let a = '', q = false;
        for (let i = 0; i < l.length; i++) {
            const ch = l[i];
            if (q) { if (ch === '"') { if (l[i + 1] === '"') { a += '"'; i++; } else q = false; } else a += ch; }
            else if (ch === '"') q = true;
            else if (ch === ';') { o.push(a); a = ''; }
            else a += ch;
        }
        o.push(a); return o;
    };

    // ── índice CORRIGIDO: a linha SEM sufixo tem precedência ───────────────
    const bruto = [];
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iArq = cols.indexOf('arquivo'), iParser = cols.indexOf('dados_parser'), iCnpj = cols.indexOf('cnpj');
        if (iArq < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const campos = sep(ls[i]);
            const arqExato = String(campos[iArq] || '').trim();
            if (!arqExato) continue;
            let d = {};
            const b = iParser >= 0 ? (campos[iParser] || '').trim() : '';
            if (b.startsWith('{')) { try { d = JSON.parse(b); } catch (e) {} }
            bruto.push({ arqExato, d, cnpjC: iCnpj >= 0 ? (campos[iCnpj] || '').trim() : '' });
        }
    }
    // ORDENA: linha de documento primeiro, parcela depois
    bruto.sort((a, b) => (ehParcela(a.arqExato) ? 1 : 0) - (ehParcela(b.arqExato) ? 1 : 0));

    const idxBom = {};
    for (const { arqExato, d, cnpjC } of bruto) {
        const arq = semPN(arqExato);
        const numero = primeiro(d, ['Nº da NF-e', 'Nº da NF-e (chave)', 'Número do documento', 'Numero da NF']);
        const emitente = primeiro(d, ['Emitente', 'Razão social', 'Nome do emitente']);
        const valor = primeiro(d, ['Valor total da nota', 'Valor total', 'Valor do boleto']);
        const cnpjP = primeiro(d, ['CNPJ emitente', 'CNPJ / CPF', 'CNPJ']);
        const dtEmi = primeiro(d, ['Data de emissão', 'Data emissao']);
        const at = idxBom[arq] || (idxBom[arq] = {});
        if (numero && !at.numero) at.numero = soDigitos(numero);
        if (emitente && !at.emitente) at.emitente = String(emitente);
        if (valor != null && at.valor == null) { const v = paraNumero(valor); if (v) at.valor = v; }
        const cn = soDigitos(cnpjP || cnpjC);
        if (cn.length >= 11 && !at.cnpj) at.cnpj = cn;
        if (dtEmi && at.dtEmissao == null) { const t = paraData(dtEmi); if (t) at.dtEmissao = t; }
    }

    const idxRuim = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'ocr.json'), 'utf8'));

    // ── quantos arquivos o índice ruim descreve errado? ────────────────────
    console.log('═'.repeat(74));
    console.log('O ÍNDICE DE MEDIÇÃO ESTAVA PEGANDO A LINHA DA PARCELA');
    console.log('═'.repeat(74));
    let divergem = 0;
    const ex = [];
    for (const [arq, bom] of Object.entries(idxBom)) {
        const ruim = idxRuim[arq];
        if (!ruim || bom.valor == null || ruim.valor == null) continue;
        if (Math.abs(bom.valor - ruim.valor) < 0.02) continue;
        divergem++;
        if (ex.length < 12) ex.push({ arq, bom: bom.valor, ruim: ruim.valor });
    }
    console.log(`\n   arquivos cujo VALOR muda ao preferir a linha do documento: ${divergem}`);
    for (const e of ex)
        console.log(`      índice antigo=${brl(e.ruim).padStart(14)}  correto=${brl(e.bom).padStart(14)}  ${e.arq.slice(0, 40)}`);

    // ── remedir os 58 com o índice bom ─────────────────────────────────────
    console.log(`\n${'═'.repeat(74)}`);
    console.log('OS "58 VALORES ERRADOS", REMEDIDOS');
    console.log('═'.repeat(74));
    const c = h.carregar();
    const vn = p.valorDoNome;
    let comIdxRuim = 0, comIdxBom = 0;
    const sobram = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        for (const usarBom of [false, true]) {
            const idx = usarBom ? idxBom : idxRuim;
            const docsPorMes = {};
            for (const off of [0, ...p.VIZINHANCA]) {
                const alvo = p.deslocarPeriodo(periodo, off);
                docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                    p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
            }
            const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
            for (const x of [...r.pares, ...r.paresVizinhos]) {
                const vL = Math.abs(Number(x.lancamento.valor) || 0);
                const vD = Math.abs(Number(x.documento.valor) || 0);
                const vNome = Math.abs(Number(vn(x.documento.arquivo)) || 0);
                if (!vL || !vD || !vNome) continue;
                if (Math.abs(vNome - vL) > 0.02) continue;
                if (Math.abs(vD - vL) < 0.02) continue;
                if (usarBom) { comIdxBom++; if (sobram.length < 12) sobram.push({ arq: x.documento.arquivo, vL, vD }); }
                else comIdxRuim++;
            }
        }
    }
    console.log(`\n   com o índice ANTIGO (pega a parcela): ${comIdxRuim}`);
    console.log(`   com o índice CORRIGIDO:               ${comIdxBom}`);
    console.log(`\n   → ${comIdxRuim - comIdxBom} dos "defeitos" eram do meu harness.`);
    if (sobram.length) {
        console.log('\n   os que SOBRAM (defeito de verdade):');
        for (const s of sobram.sort((a, b) => b.vL - a.vL))
            console.log(`      lanç=${brl(s.vL).padStart(14)}  lido=${brl(s.vD).padStart(14)}  ${s.arq.slice(0, 40)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
