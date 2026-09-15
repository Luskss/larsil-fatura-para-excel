/**
 * _medir/_transcricao-ganho-justo.js — o ganho da transcrição, medido onde ela conta.
 *
 * ── Por que esta terceira versão ─────────────────────────────────────────────
 * `_transcricao-ganho-pares.js` deu transcrição 2% × texto nativo 47% — e isso NÃO
 * media a transcrição. `_onde-esta-o-transcrito.js` mostrou a razão: dos 66 documentos
 * transcritos, **52 são filtrados de propósito** pelo comparador (financiamento,
 * consórcio, crédito/giro, TED — `categoriaNaoFiscal` os classifica como não-fiscais
 * e eles não entram na conferência por decisão de projeto, ver
 * [[entidades-sem-nota-fornecedor]]). Só 14 chegam ao pareamento. Uma taxa calculada
 * sobre 66 mede o filtro, não a leitura.
 *
 * Isso também explica o resultado de `_vale-reler-ocr.js`: os 4 casos em que a
 * transcrição "perdeu" pegando o total da operação em vez da parcela são justamente
 * documentos de financiamento — que o comparador nem usa.
 *
 * ── O que se mede aqui ───────────────────────────────────────────────────────
 * Restringe as DUAS pontas ao universo do pareamento (o que `contarNaPasta` devolve)
 * e compara preenchimento, acerto e par por classe de leitura. É a comparação em que
 * as classes disputam a mesma coisa.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const j = require('./_julgar-campos');
const { indexar } = require('./ocr');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';
const ROT = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

function classe(c) {
    c = String(c || '');
    if (/transcri/i.test(c)) return 'transcrição';
    if (/\(OCR\)/i.test(c))  return 'OCR';
    if (/^Imagem\s*$/i.test(c)) return 'imagem NÃO LIDA';
    return 'texto nativo';
}

(async () => {
    const { pasta, planilha } = h.carregar();

    const pool = await getConnection();
    const rr = await pool.request().input('t', sql.Char(1), 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');
    const info = new Map();   // nome -> { classe, pd }
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const nome = path.basename(String(x.arquivo).replace(/#p\d+$/, ''));
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            if (!info.has(nome)) info.set(nome, { classe: classe(x.conteudo), pd });
        }

    // O UNIVERSO DO PAREAMENTO: só o que `contarNaPasta` devolve.
    const noPareamento = new Set();
    for (const per of Object.keys(pasta.arquivosPorMes))
        for (const a of pasta.arquivosPorMes[per]) noPareamento.add(a.nome);

    console.error('[justo] reindexando o banco...');
    const ocr = await indexar();

    const pareados = new Set();
    for (const PERIODO of h.PERIODOS) {
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(PERIODO, off);
            docsPorMes[alvo] = (pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), ocr[a.nome]));
        }
        const lancs = ((planilha[PERIODO] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const res = p.conferirPeriodo(lancs, docsPorMes, PERIODO);
        for (const x of [...res.pares, ...res.paresVizinhos]) {
            const n = path.basename(String(x.documento?.arquivo || x.documento?.nome || '').replace(/#p\d+$/, ''));
            if (n) pareados.add(n);
        }
    }

    // ── Quadro 1: quanto de cada classe o comparador sequer considera ────────
    const univ = {};
    for (const [nome, d] of info) {
        const u = univ[d.classe] || (univ[d.classe] = { total: 0, dentro: 0 });
        u.total++;
        if (noPareamento.has(nome)) u.dentro++;
    }
    const ORDEM = ['transcrição', 'OCR', 'imagem NÃO LIDA', 'texto nativo'];
    console.log('1) QUANTO DE CADA CLASSE ENTRA NA CONFERÊNCIA');
    console.log('   (o resto é financiamento/consórcio/crédito — filtrado de propósito)');
    console.log('   classe             total  entra  fica de fora');
    for (const k of ORDEM) {
        const u = univ[k]; if (!u) continue;
        console.log('   ' + k.padEnd(18) + String(u.total).padStart(5) + String(u.dentro).padStart(7) +
            String(u.total - u.dentro).padStart(9) +
            `  (${(100 * (u.total - u.dentro) / u.total).toFixed(0)}%)`);
    }

    // ── Quadro 2: SÓ os que entram — preenchimento, acerto e par ─────────────
    console.log('\n2) SÓ OS QUE ENTRAM NA CONFERÊNCIA');
    console.log('   classe             docs  campos/4   valor ok   valor ERRO   pareados');
    for (const k of ORDEM) {
        const nomes = [...info].filter(([n, d]) => d.classe === k && noPareamento.has(n));
        if (!nomes.length) continue;
        let soma = 0, vok = 0, verr = 0, vgab = 0, par = 0;
        for (const [n, d] of nomes) {
            const lido = {
                valor: j.num(primeiro(d.pd, ROT.valor)),
                numero: primeiro(d.pd, ROT.numero),
                data: primeiro(d.pd, ROT.data),
                emitente: primeiro(d.pd, ROT.emitente),
            };
            for (const c of j.CAMPOS) if (!VAZIO(lido[c])) soma++;
            const g = j.gabaritos(n);
            if (g.valor != null) {
                vgab++;
                const v = j.jValor(lido.valor, g.valor);
                if (v === 'ok') vok++; else if (v === 'erro') verr++;
            }
            if (pareados.has(n)) par++;
        }
        console.log('   ' + k.padEnd(18) + String(nomes.length).padStart(5) +
            (soma / nomes.length).toFixed(2).padStart(10) +
            `${String(vok).padStart(8)}/${vgab}` + String(verr).padStart(11) +
            String(par).padStart(11) + ` (${(100 * par / nomes.length).toFixed(0)}%)`);
    }
    process.exit(0);
})();
