/**
 * _medir/_fila-ainda-vale.js — a fila de 52 itens encolheu com os consertos?
 *
 * A `fila-conferencia-tipo.xlsx` foi gerada ANTES de:
 *   • o índice de medição ser corrigido (as linhas #pN contaminavam o valor)
 *   • a régua de tipo ser recalibrada ([[rcb-no-nome-e-numero-nao-tipo]])
 *
 * Então os 52 itens podem estar desatualizados: alguns já resolvidos, outros com
 * valor errado na planilha. Refazer a lista antes de o usuário gastar tempo
 * conferindo à mão é mais barato que ele descobrir item por item.
 *
 * ── O que se faz ────────────────────────────────────────────────────────────
 *   1. recomputar os alertas de tipo com o estado ATUAL
 *   2. comparar com o que está no xlsx
 *   3. separar por NATUREZA, para a conferência ir em blocos e não item a item:
 *      já auditado / o papel confirma o banco / sem testemunha
 *   4. ordenar pelo que decide mais rápido
 *
 * SOMENTE LEITURA (não regrava o xlsx aqui).
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
function marcadorDoPapel(ev) {
    const e = norm(ev);
    if (/^IA:/.test(e)) return '';
    return MARCADOR_FORTE[e] || '';
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

    // ── os alertas de HOJE ─────────────────────────────────────────────────
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
            const ev = String(info.evidencia || '').trim();
            alertas.push({
                periodo, arq, planilha: gab, banco: lido, evid: ev,
                papel: marcadorDoPapel(ev), origem: String(info.origem || '').trim(),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                forn: x.lancamento.entidade || '',
                caminho: x.documento.caminho || '',
                nf: String(x.lancamento.nf || ''),
            });
        }
    }

    console.log('═'.repeat(78));
    console.log(`A FILA HOJE: ${alertas.length} alertas`);
    console.log('═'.repeat(78));

    // ── separar por natureza ───────────────────────────────────────────────
    const MACPONTA = a => /MACPONTA/i.test(a.arq) || /MACPONTA/i.test(a.forn);
    const baldes = { jaAuditado: [], papelConfirma: [], guiaJaCorrigido: [], semTestemunha: [] };
    for (const a of alertas) {
        if (MACPONTA(a)) { baldes.jaAuditado.push(a); continue; }
        if (norm(a.evid) === 'GUIA') { baldes.guiaJaCorrigido.push(a); continue; }
        if (a.papel && a.papel === a.banco) { baldes.papelConfirma.push(a); continue; }
        baldes.semTestemunha.push(a);
    }

    const soma = arr => arr.reduce((s, a) => s + a.valor, 0);
    console.log('\n   balde                          itens          valor    o que fazer');
    console.log(`   já auditado (MACPONTA)     ${String(baldes.jaAuditado.length).padStart(6)}  ${brl(soma(baldes.jaAuditado)).padStart(16)}   fechar sem olhar`);
    console.log(`   o papel confirma o banco   ${String(baldes.papelConfirma.length).padStart(6)}  ${brl(soma(baldes.papelConfirma)).padStart(16)}   marcar OK em lote`);
    console.log(`   GUIA (já corrigido)        ${String(baldes.guiaJaCorrigido.length).padStart(6)}  ${brl(soma(baldes.guiaJaCorrigido)).padStart(16)}   some na releitura`);
    console.log(`   SEM testemunha             ${String(baldes.semTestemunha.length).padStart(6)}  ${brl(soma(baldes.semTestemunha)).padStart(16)}   ← conferir de verdade`);

    // ── o balde que importa, por família e por valor ───────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`O QUE REALMENTE PRECISA DE OLHO: ${baldes.semTestemunha.length} itens`);
    console.log('═'.repeat(78));
    const fam = new Map();
    for (const a of baldes.semTestemunha) {
        const k = `${a.planilha}→${a.banco}`;
        if (!fam.has(k)) fam.set(k, []);
        fam.get(k).push(a);
    }
    for (const [k, arr] of [...fam].sort((a, b) => soma(b[1]) - soma(a[1]))) {
        console.log(`\n   ${k}   ${arr.length} itens, ${brl(soma(arr))}`);
        for (const a of arr.sort((x, y) => y.valor - x.valor).slice(0, 5))
            console.log(`      ${a.periodo} ${brl(a.valor).padStart(14)}  ${a.arq.slice(0, 48)}`);
        if (arr.length > 5) console.log(`      … e mais ${arr.length - 5}`);
    }

    // ── comparar com o xlsx ────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('A PLANILHA DA FILA ESTÁ DESATUALIZADA?');
    console.log('═'.repeat(78));
    const xlsxPath = path.join(h.RAIZ, 'fila-conferencia-tipo.xlsx');
    if (fs.existsSync(xlsxPath)) {
        const w = XLSX.readFile(xlsxPath);
        const aba = w.Sheets[w.SheetNames[0]];
        const linhas = XLSX.utils.sheet_to_json(aba, { header: 1, raw: true });
        console.log(`\n   xlsx: ${w.SheetNames.join(', ')}`);
        console.log(`   linhas na aba "Conferir": ${Math.max(0, linhas.length - 1)}`);
        console.log(`   alertas hoje:             ${alertas.length}`);
        console.log(`\n   → ${linhas.length - 1 === alertas.length ? 'mesmo tamanho' : 'MUDOU — vale regerar'}`);
    } else console.log('\n   (xlsx não encontrado)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
