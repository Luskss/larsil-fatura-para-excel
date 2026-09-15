/**
 * _medir/_data-como-sinal.js — a DATA DE EMISSÃO confirma par, ou só veta?
 *
 * PERGUNTA (15/09/2026): o motor usa três sinais (valor, número, entidade) e a data
 * só como VETO — `dentroDaJanela` barra o par por valor quando a distância passa de
 * 15 dias. Ela nunca CONFIRMA nada: um par com valor + entidade + emissão idêntica
 * tem a mesma força (2) de um par com valor + entidade e datas distantes.
 *
 * Os dois lados têm o campo: a planilha traz DT_EMISSAO, e o extrator lê a data de
 * emissão da nota (`camposOcr.dtEmissao`). Mas `enriquecerComOcr` só usa `dtEmissao`
 * como RESERVA de `d.data` quando o nome/pasta não trouxe nada — e `d.data` é data de
 * ARQUIVAMENTO, que é outra coisa (§15/§16).
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Sobre os pares que o motor JÁ faz, quantos têm emissão coincidente dos dois lados?
 * Se a coincidência for alta nos pares certos e baixa nos duvidosos, a data serve
 * como 4º sinal — para FORTALECER par fraco, não para criar par novo.
 *
 *   A. cobertura   — em quantos pares as duas emissões existem?
 *   B. concordância — quando existem, batem?
 *   C. discriminação — a taxa de batida difere entre par forte (força 3) e fraco
 *                      (força 1)? Se não diferir, a data não distingue nada e não
 *                      serve como sinal.
 *
 * ── Por que NÃO propor casar por data ───────────────────────────────────────
 * Data igual com fornecedor diferente é coincidência banal (dezenas de notas por dia).
 * A data só vale JUNTO, como confirmação — do mesmo modo que o CNPJ foi reprovado
 * como veto mas o emitente vale somando tokens.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const DIA_MS = 86400000;
const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';

(async () => {
    const c = h.carregar();
    console.error('[data-sinal] reindexando...');
    const idx = await indexar();
    const rota = h.internasDaRota();

    // índice cru do OCR: precisamos da dtEmissao DO DOCUMENTO, que enriquecerComOcr
    // descarta quando o nome já trouxe data.
    const emissaoDoDoc = new Map();
    for (const [nome, o] of Object.entries(idx))
        if (o && o.dtEmissao != null) emissaoDoDoc.set(nome, o.dtEmissao);

    const bucket = { 3: { n: 0, ambas: 0, bate: 0 }, 2: { n: 0, ambas: 0, bate: 0 }, 1: { n: 0, ambas: 0, bate: 0 } };
    const porVia = new Map();
    let totalPares = 0;

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(p.lancamentoDaPlanilha);
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            totalPares++;
            const f = x.forca || 1;
            const b = bucket[f] || (bucket[f] = { n: 0, ambas: 0, bate: 0 });
            b.n++;
            const eL = x.lancamento.dtEmissao;
            const eD = emissaoDoDoc.get(x.documento.arquivo);
            if (eL == null || eD == null) continue;
            b.ambas++;
            const dist = Math.abs(eL - eD) / DIA_MS;
            const ok = dist < 1;
            if (ok) b.bate++;
            const via = x.via;
            if (!porVia.has(via)) porVia.set(via, { ambas: 0, bate: 0 });
            const v = porVia.get(via);
            v.ambas++; if (ok) v.bate++;
        }
    }

    console.log('═'.repeat(70));
    console.log('A DATA DE EMISSÃO CONFIRMA O PAR?');
    console.log('═'.repeat(70));
    console.log(`pares analisados: ${totalPares}\n`);
    console.log('força   pares   com as DUAS emissões   emissão BATE');
    for (const f of [3, 2, 1]) {
        const b = bucket[f];
        if (!b || !b.n) continue;
        console.log(`  ${f}    ${String(b.n).padStart(5)}   ${String(b.ambas).padStart(8)} ${pct(b.ambas, b.n).padStart(8)}` +
            `   ${String(b.bate).padStart(6)} ${pct(b.bate, b.ambas).padStart(8)}`);
    }

    console.log('\npor via de casamento:');
    for (const [via, v] of [...porVia].sort((a, b) => b[1].ambas - a[1].ambas))
        console.log(`   ${via.padEnd(26)} ${String(v.ambas).padStart(5)} com data   ${pct(v.bate, v.ambas).padStart(7)} batem`);

    console.log('\n' + '─'.repeat(70));
    console.log('LEITURA: se a taxa de batida for parecida entre força 3 e força 1, a');
    console.log('data NÃO discrimina par bom de par duvidoso — e não serve como sinal.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
