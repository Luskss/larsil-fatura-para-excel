/**
 * _medir/_57-quem-erra-mesmo.js — separar DEFEITO de RÉGUA nos 57 alertas
 *
 * `_os-57-que-sobram.js` imprimiu 12 casos sob o rótulo "ERRO REAL do
 * classificador". O rótulo está ERRADO em parte: ele usou só nome×planilha e
 * ignorou a EVIDÊNCIA — que é o que o papel efetivamente diz.
 *
 * Dois já têm veredito anterior:
 *   • `NF→CTE` com evidência DACTE/MDF-E → ABSOLVIDO em [[nf-para-cte-nao-e-defeito]]
 *   • `FATURA→IMPOSTO` com evidência GUIA → já CONSERTADO no código
 *     ([[guia-solto-classificava-imposto]]), só falta reler o PDF
 *
 * ── A hierarquia de testemunhas ─────────────────────────────────────────────
 *   EVIDÊNCIA (marcador achado NO PAPEL) > nome do arquivo > planilha
 * A evidência é a única que vem do documento. Quando ela é um marcador FORTE
 * (DACTE, MDF-E, NFS-E, DANFE, RECIBO), o banco leu o papel — e é a planilha ou o
 * nome que generaliza.
 *
 * Quando a evidência é "IA: <nome do emitente>", ela NÃO é marcador: é só o
 * emitente que a IA devolveu. Aí não há testemunha do papel, e o caso fica em
 * aberto — é o balde que merece inspeção.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}

// marcador FORTE: veio do papel e nomeia o documento
const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
function marcadorDoPapel(ev) {
    const e = norm(ev);
    if (/^IA:/.test(e)) return '';              // é emitente, não marcador
    for (const [k, v] of Object.entries(MARCADOR_FORTE)) if (e === k) return v;
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
            const ev = String(info.evidencia || '').trim();
            alertas.push({
                periodo, arq, planilha: gab, banco: lido, evid: ev,
                papel: marcadorDoPapel(ev),
                origem: String(info.origem || '').trim(),
                valor: Math.abs(Number(x.lancamento.valor) || 0)
            });
        }
    }

    console.log('═'.repeat(74));
    console.log(`OS ${alertas.length} ALERTAS — DEFEITO ou RÉGUA?`);
    console.log('═'.repeat(74));

    const baldes = {
        papelConfirma:   [],  // marcador forte = tipo do banco → planilha/nome generalizou
        papelContradiz:  [],  // marcador forte ≠ tipo do banco → DEFEITO de verdade
        guiaJaConsertado:[],  // evidência GUIA: o código já corrige, falta reler
        semTestemunha:   []   // evidência = "IA: emitente" → nada do papel
    };
    for (const a of alertas) {
        if (a.evid.toUpperCase() === 'GUIA') { baldes.guiaJaConsertado.push(a); continue; }
        if (!a.papel) { baldes.semTestemunha.push(a); continue; }
        if (a.papel === a.banco) baldes.papelConfirma.push(a);
        else baldes.papelContradiz.push(a);
    }

    const mostrar = (titulo, arr, nota) => {
        const v = arr.reduce((s, a) => s + a.valor, 0);
        console.log(`\n── ${titulo} — ${arr.length} casos, ${brl(v)} ──`);
        if (nota) console.log(`   ${nota}`);
        for (const a of arr.sort((x, y) => y.valor - x.valor).slice(0, 8)) {
            console.log(`   ${brl(a.valor).padStart(16)}  ${a.planilha}→${a.banco}  ev="${a.evid.slice(0, 22)}"`);
            console.log(`      ${a.arq.slice(0, 64)}`);
        }
        if (arr.length > 8) console.log(`   … e mais ${arr.length - 8}`);
    };

    mostrar('O PAPEL CONFIRMA O BANCO (régua errou, não é defeito)',
        baldes.papelConfirma, 'marcador impresso no documento = tipo que o banco gravou');
    mostrar('O PAPEL CONTRADIZ O BANCO (DEFEITO real)',
        baldes.papelContradiz, 'o marcador do papel diz outra coisa que não o tipo gravado');
    mostrar('GUIA — já consertado no código, falta reler o PDF',
        baldes.guiaJaConsertado, '[[guia-solto-classificava-imposto]]');
    mostrar('SEM TESTEMUNHA DO PAPEL (evidência = emitente da IA)',
        baldes.semTestemunha, 'não dá para julgar sem abrir o PDF');

    console.log(`\n${'═'.repeat(74)}`);
    console.log('RESUMO');
    console.log('═'.repeat(74));
    for (const [k, arr] of Object.entries(baldes))
        console.log(`   ${k.padEnd(20)} ${String(arr.length).padStart(3)}   ${brl(arr.reduce((s, a) => s + a.valor, 0)).padStart(18)}`);

    // dentro do balde sem testemunha, quais famílias?
    console.log('\n   sem testemunha, por família:');
    const f2 = new Map();
    for (const a of baldes.semTestemunha) {
        const k = `${a.planilha}→${a.banco}`;
        f2.set(k, (f2.get(k) || 0) + 1);
    }
    for (const [k, n] of [...f2].sort((a, b) => b[1] - a[1]))
        console.log(`      ${k.padEnd(18)} ${String(n).padStart(3)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
