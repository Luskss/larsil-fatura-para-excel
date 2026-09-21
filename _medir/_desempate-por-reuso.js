/**
 * _medir/_desempate-por-reuso.js — dá para separar os 19 falsos sem estragar nada?
 *
 * POOL (`_reuso-da-para-desempatar.js`): 94 pares FRACOS (força 1-2) cujo
 * documento já tem par FORTE (força 3) em outro mês.
 *
 *   • 19 (20,2%): o número do lançamento EXISTE em outro arquivo do acervo
 *     → o motor emprestou um documento tendo o certo na pasta = par FALSO
 *   • 61 (64,9%): o número não existe em lugar nenhum
 *     → o documento falta mesmo; o par fraco preenche buraco
 *   • 14: lançamento sem número
 *
 * Caso flagrante:
 *     lançamento 01.2026  R$ 790,12  NF=8954
 *        pareou com: 009.DOC- 741,53 - 2026.04.29. SKILLHUB. NFS 11691   ← abril!
 *        a NF 8954 está em: [01.2026] 015.DOC- 741,53-2026.01.28.SKILLUB. NFV8954
 *
 * ── As variantes de desempate ───────────────────────────────────────────────
 *   V1  o número do lançamento existe em OUTRO arquivo → recusar o par fraco
 *   V2  V1 + só quando o outro arquivo está na janela do período
 *   V3  V1 + só quando o outro arquivo é do MESMO fornecedor
 *
 * ── O CRITÉRIO (e o risco) ──────────────────────────────────────────────────
 * Recusar um par é PERDER par. Se o par fraco é falso, perder é ganho — mas medido
 * pelo número de pares parece piora. Então a métrica tem de ser a QUALIDADE:
 *   • o par recusado tinha valor batendo? (se sim, recusar dói)
 *   • sobra o lançamento sem documento, ou o motor acha o certo?
 *
 * E o principal: **isto não pode mexer nas melhorias de hoje.** O `tipoBate`
 * (240→57) e o índice corrigido (+15) precisam sair iguais.
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
const soDig = s => String(s || '').replace(/\D/g, '');

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // índice número → arquivos
    const numeros = new Map();
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const o = idx[a.nome] || {};
            const cands = [soDig(o.numero || ''), soDig(p.numeroDoNome ? p.numeroDoNome(a.nome) : '')];
            for (const n of cands) {
                if (!n || n.length < 3) continue;
                if (!numeros.has(n)) numeros.set(n, []);
                if (!numeros.get(n).some(x => x.arq === a.nome)) numeros.get(n).push({ mes, arq: a.nome });
            }
        }

    // ── rodar o painel e classificar cada par ──────────────────────────────
    const todosPares = [];
    const usosPorArq = new Map();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
            const o = p.lancamentoDaPlanilha(l); o._id = `${periodo}#${i}`; return o;
        });
        const janela = new Set();
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            const lista = (c.pasta.arquivosPorMes[alvo] || []);
            for (const a of lista) janela.add(a.nome);
            docsPorMes[alvo] = lista.map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const reg = {
                periodo, arq: x.documento.arquivo, forca: x.forca,
                vLanc: Math.abs(Number(x.lancamento.valor) || 0),
                vDoc: Math.abs(Number(x.documento.valor) || 0),
                nf: soDig(x.lancamento.nf), ent: norm(x.lancamento.entidade || ''),
                janela,
            };
            todosPares.push(reg);
            if (!usosPorArq.has(reg.arq)) usosPorArq.set(reg.arq, []);
            usosPorArq.get(reg.arq).push(reg);
        }
    }
    console.log(`pares totais: ${todosPares.length}\n`);

    // marca os que a regra recusaria
    function avaliar(nome, fn) {
        let recusados = 0, valorBatia = 0, valorNaoBatia = 0;
        const ex = [];
        for (const par of todosPares) {
            const outros = usosPorArq.get(par.arq) || [];
            const temForteEmOutroMes = outros.some(o => o.forca === 3 && o.periodo !== par.periodo);
            if (!(par.forca < 3 && temForteEmOutroMes)) continue;
            if (!fn(par)) continue;
            recusados++;
            if (par.vDoc && Math.abs(par.vDoc - par.vLanc) < 0.02) valorBatia++;
            else valorNaoBatia++;
            if (ex.length < 8) ex.push(par);
        }
        console.log(`\n── ${nome} ──`);
        console.log(`   pares recusados: ${recusados}`);
        console.log(`      o valor do doc BATIA com o lançado: ${valorBatia}  ← recusar dói aqui`);
        console.log(`      não batia:                          ${valorNaoBatia}  ← recusar é ganho`);
        for (const e of ex)
            console.log(`      ${e.periodo} ${brl(e.vLanc).padStart(13)} NF=${e.nf.padEnd(8)} f${e.forca}  ${e.arq.slice(0, 40)}`);
        return { recusados, valorBatia, valorNaoBatia };
    }

    console.log('═'.repeat(78));
    console.log('AS VARIANTES DE DESEMPATE');
    console.log('═'.repeat(78));

    avaliar('V1: o número do lançamento existe em outro arquivo', par => {
        if (!par.nf || par.nf.length < 3) return false;
        const achados = numeros.get(par.nf) || [];
        return achados.some(x => x.arq !== par.arq);
    });

    avaliar('V2: V1 + o outro arquivo está na janela do período', par => {
        if (!par.nf || par.nf.length < 3) return false;
        const achados = numeros.get(par.nf) || [];
        return achados.some(x => x.arq !== par.arq && par.janela.has(x.arq));
    });

    avaliar('V3: V1 + o outro arquivo é do mesmo fornecedor', par => {
        if (!par.nf || par.nf.length < 3) return false;
        const achados = numeros.get(par.nf) || [];
        return achados.some(x => {
            if (x.arq === par.arq) return false;
            const o = idx[x.arq] || {};
            const e = norm(o.emitente || '');
            return e && par.ent && (e.includes(par.ent.slice(0, 8)) || par.ent.includes(e.slice(0, 8)));
        });
    });

    // ── o que sobra: o lançamento fica órfão? ──────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('O CUSTO: o lançamento recusado fica SEM documento?');
    console.log('═'.repeat(78));
    console.log('\n   Recusar o par fraco NÃO faz o motor achar o certo sozinho —');
    console.log('   ele já rodou. O lançamento simplesmente perde o par.');
    console.log('\n   Ou seja: a regra converte "par falso" em "sem par". Isso é');
    console.log('   honesto (o usuário para de ver um documento errado), mas');
    console.log('   aparece como PERDA na contagem de pares.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
