/**
 * _medir/_gemeos-o-motor-ja-acerta.js — o motor já escolhe o gêmeo certo?
 *
 * ACHADO (`_gemeos-quantos-sao.js`): 175 grupos de documentos com mesmo
 * fornecedor+número E mesmo valor. Mas eles NÃO são o que eu supus.
 *
 * O exemplo desfaz o engano:
 *
 *     ADS DISTRIBUIDORA | NF 266 — SEIS arquivos de R$ 1.150,21
 *       [01.2026] 024.DOC- 1150,21 - 2026.01.05. …
 *       [02.2026] 009.DOC- 1150,21 - 2026.02.04. …
 *       … um por mês, até 06.2026
 *
 * Não são duplicatas nem "competidores": é a MESMA nota parcelada, com um arquivo
 * por parcela paga, arquivado no mês do pagamento. Cada arquivo corresponde a um
 * LANÇAMENTO diferente. Não há ambiguidade real — há um 1↔1 por mês.
 *
 * E os sinais que distinguem confirmam: data no NOME (86,9%) e pasta/mês (80,6%)
 * separam quase todos. Vencimento só 23,4%, nosso número 0%.
 *
 * ── A pergunta que decide se há algo a fazer ────────────────────────────────
 * O motor JÁ usa data e pasta ([[a-data-vem-da-pasta]], [[veto-de-janela-so-no-mes]]).
 * Então talvez ele já acerte. [[dimensionar-o-pool-antes-de-medir]]:
 *
 *   ganho possível = casos em que erra − 0
 *
 *   1. desses 175 grupos, quantos documentos são pareados?
 *   2. o documento pareado é o do MÊS do lançamento? (o teste de acerto)
 *   3. em quantos o motor escolhe um documento de OUTRO mês tendo o do mês certo
 *      disponível? ← esse é o pool de ganho
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

// mês embutido no NOME do arquivo ("… - 2026.03.27. …")
function mesDoNome(arq) {
    const m = String(arq).match(/(20\d{2})[.\-](\d{1,2})[.\-]\d{1,2}/);
    if (!m) return '';
    return `${String(m[2]).padStart(2, '0')}.${m[1]}`;
}

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // ── montar os grupos de gêmeos ─────────────────────────────────────────
    // ATENÇÃO: `numero`/`emitente` podem não sobreviver a `enriquecerComOcr` com
    // esse nome. O índice é a fonte direta — usá-lo como fallback, senão o script
    // devolve 0 grupos e parece que o problema não existe.
    const docs = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]);
            const o = idx[a.nome] || {};
            docs.push({ mes, arq: a.nome,
                        numero: String(d.numero || o.numero || ''),
                        ent: norm(d.emitente || o.emitente || ''),
                        valor: Math.abs(Number(d.valor || o.valor) || 0) });
        }
    if (!docs.some(d => d.numero && d.ent))
        throw new Error('nenhum documento com numero+emitente — a leitura do índice falhou');
    const porChave = new Map();
    for (const d of docs) {
        if (!d.numero || !d.ent) continue;
        const k = `${d.ent}|${d.numero}`;
        if (!porChave.has(k)) porChave.set(k, []);
        porChave.get(k).push(d);
    }
    const gemeos = new Map();
    for (const [k, g] of porChave) {
        if (g.length < 2) continue;
        const vs = [...new Set(g.map(x => x.valor).filter(Boolean).map(v => v.toFixed(2)))];
        if (vs.length !== 1) continue;
        gemeos.set(k, g);
    }
    const arquivoEhGemeo = new Map();     // arquivo → chave do grupo
    for (const [k, g] of gemeos) for (const d of g) arquivoEhGemeo.set(d.arq, k);
    console.log(`grupos de gêmeos (mesmo valor): ${gemeos.size}`);
    console.log(`documentos envolvidos: ${arquivoEhGemeo.size}\n`);

    // ── rodar o painel e ver quais gêmeos foram pareados ───────────────────
    const usos = new Map();               // chave do grupo → [{periodo, arq, forca, vLanc}]
    let paresTotais = 0;
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            paresTotais++;
            const k = arquivoEhGemeo.get(x.documento.arquivo);
            if (!k) continue;
            if (!usos.has(k)) usos.set(k, []);
            usos.get(k).push({ periodo, arq: x.documento.arquivo, forca: x.forca,
                               vLanc: Math.abs(Number(x.lancamento.valor) || 0) });
        }
    }

    console.log('═'.repeat(78));
    console.log('(1) OS GÊMEOS SÃO PAREADOS?');
    console.log('═'.repeat(78));
    console.log(`\n   pares totais no painel: ${paresTotais}`);
    console.log(`   grupos de gêmeos com ao menos 1 par: ${usos.size}  ${pct(usos.size, gemeos.size)}`);
    let totalParesGemeos = 0;
    for (const [, v] of usos) totalParesGemeos += v.length;
    console.log(`   pares envolvendo gêmeos: ${totalParesGemeos}`);

    // ── (2) o documento escolhido é o do MÊS do lançamento? ────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O DOCUMENTO ESCOLHIDO É O DO MÊS DO LANÇAMENTO?');
    console.log('═'.repeat(78));
    let certo = 0, errado = 0, semMesNoNome = 0;
    const errados = [];
    for (const [k, lista] of usos) {
        for (const u of lista) {
            const mn = mesDoNome(u.arq);
            if (!mn) { semMesNoNome++; continue; }
            // o período do painel é o mês do LANÇAMENTO
            if (mn === u.periodo) certo++;
            else {
                // havia um gêmeo do mês certo disponível?
                const g = gemeos.get(k) || [];
                const doMesCerto = g.find(d => mesDoNome(d.arq) === u.periodo);
                errado++;
                if (errados.length < 14)
                    errados.push({ k, u, mn, tinhaMelhor: !!doMesCerto,
                                   melhor: doMesCerto ? doMesCerto.arq : null });
            }
        }
    }
    console.log(`\n   escolheu o documento do MÊS do lançamento: ${certo}  ${pct(certo, certo + errado)}`);
    console.log(`   escolheu outro mês:                        ${errado}  ${pct(errado, certo + errado)}`);
    console.log(`   sem data no nome:                          ${semMesNoNome}`);

    // ── (3) o POOL DE GANHO: erra tendo o certo disponível ─────────────────
    const comMelhor = errados.filter(e => e.tinhaMelhor);
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(3) POOL DE GANHO: erra TENDO o documento do mês certo');
    console.log('═'.repeat(78));
    console.log(`\n   dos ${errado} que escolheram outro mês:`);
    console.log(`      tinham o documento do mês certo disponível: ${comMelhor.length}  ← pool`);
    console.log(`      não tinham (o gêmeo do mês não existe):     ${errados.length - comMelhor.length}`);
    console.log('\n   (amostra dos ${errados.length} primeiros)');
    for (const e of errados.slice(0, 10)) {
        console.log(`\n   lançamento ${e.u.periodo}  ${brl(e.u.vLanc)}  força ${e.u.forca}`);
        console.log(`      escolheu:  [${e.mn}] ${e.u.arq.slice(0, 54)}`);
        if (e.melhor) console.log(`      havia:     [${e.u.periodo}] ${e.melhor.slice(0, 54)}  ⚠`);
        else console.log(`      (não havia gêmeo de ${e.u.periodo})`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
