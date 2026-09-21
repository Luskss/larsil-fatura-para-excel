/**
 * _medir/_reuso-da-para-desempatar.js — o par fraco do documento reusado é falso?
 *
 * ACHADO (`_documento-servindo-dois-lancamentos.js`): 114 documentos aparecem em
 * pares de MESES DIFERENTES (0 dentro do mesmo mês). O padrão é constante:
 *
 *     006.DOC- 125,00-2026.01.08.VINICIUS . RC 901745+AUT.pdf
 *        01.2026  R$ 125,00  força 3  NF=901745   ← o número BATE com o nome
 *        02.2026  R$ 125,00  força 1  NF=902671   ← NF completamente outra
 *
 * O par de força 3 casou por número+entidade+data. O de força 1 casou só por
 * valor — é o mesmo documento sendo reaproveitado num mês onde o documento certo
 * (RC 902671) não foi encontrado.
 *
 * ── A hipótese ──────────────────────────────────────────────────────────────
 * Quando um documento já tem par de força 3 em outro mês, o par de força 1 dele é
 * provavelmente FALSO — o lançamento está sem documento e o motor emprestou um
 * parecido. Isso é [[media-agregada-esconde-par-falso]]: par a mais que não é ganho.
 *
 * ── Mas o painel é POR MÊS ──────────────────────────────────────────────────
 * Cada mês é uma consulta independente, e o usuário vê um mês por vez. "Este
 * documento já foi usado em janeiro" é informação que a consulta de fevereiro NÃO
 * tem hoje. Propor uma trava global mudaria a natureza do painel — e
 * [[cortar-escopo-do-painel-reprovado]] mostra que mexer no escopo costuma custar.
 *
 * Então a pergunta aqui NÃO é "como consertar", e sim: **qual o tamanho e a
 * qualidade desse pool?** ([[dimensionar-o-pool-antes-de-medir]])
 *
 *   1. quantos pares fracos coexistem com um par forte do MESMO documento?
 *   2. o número da NF do par fraco existe em ALGUM documento do acervo?
 *      → se existe, o documento certo está lá e o motor não o achou (problema de
 *        busca, não de empréstimo)
 *      → se não existe, o documento realmente falta
 *   3. quanto valor está nesses pares fracos?
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

    // ── todos os números conhecidos do acervo (nome + índice) ──────────────
    const numerosDoAcervo = new Map();    // número → [arquivos]
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const o = idx[a.nome] || {};
            const doIdx = soDig(o.numero || '');
            const doNome = p.numeroDoNome ? soDig(p.numeroDoNome(a.nome) || '') : '';
            for (const n of [doIdx, doNome]) {
                if (!n || n.length < 3) continue;
                if (!numerosDoAcervo.has(n)) numerosDoAcervo.set(n, []);
                numerosDoAcervo.get(n).push({ mes, arq: a.nome });
            }
        }
    console.log(`números distintos no acervo: ${numerosDoAcervo.size}\n`);

    const usos = new Map();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map((l, i) => {
            const o = p.lancamentoDaPlanilha(l); o._id = `${periodo}#${i}`; return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const arq = x.documento.arquivo;
            if (!usos.has(arq)) usos.set(arq, []);
            usos.get(arq).push({ periodo, vLanc: Math.abs(Number(x.lancamento.valor) || 0),
                                  forca: x.forca, nf: soDig(x.lancamento.nf),
                                  ent: norm(x.lancamento.entidade || '') });
        }
    }

    const repetidos = [...usos].filter(([, u]) => u.length > 1);

    // ── (1) o padrão forte+fraco ───────────────────────────────────────────
    console.log('═'.repeat(78));
    console.log('(1) O PADRÃO: par forte + par fraco do mesmo documento');
    console.log('═'.repeat(78));
    let comForteEFraco = 0, todosFortes = 0, todosFracos = 0;
    const alvos = [];
    for (const [arq, u] of repetidos) {
        const forte = u.filter(x => x.forca === 3);
        const fraco = u.filter(x => x.forca < 3);
        if (forte.length && fraco.length) {
            comForteEFraco++;
            for (const f of fraco) alvos.push({ arq, fraco: f, forte: forte[0] });
        }
        else if (!fraco.length) todosFortes++;
        else todosFracos++;
    }
    console.log(`\n   documentos com par FORTE e par FRACO: ${comForteEFraco}  ${pct(comForteEFraco, repetidos.length)}`);
    console.log(`   só pares fortes:                      ${todosFortes}`);
    console.log(`   só pares fracos:                      ${todosFracos}`);
    console.log(`\n   pares FRACOS candidatos a falso: ${alvos.length}`);
    const valorAlvo = alvos.reduce((s, a) => s + a.fraco.vLanc, 0);
    console.log(`   valor envolvido: ${brl(valorAlvo)}`);

    // ── (2) o documento certo existe no acervo? ────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O DOCUMENTO CERTO DO PAR FRACO EXISTE NO ACERVO?');
    console.log('═'.repeat(78));
    let existe = 0, naoExiste = 0, semNf = 0;
    const exExiste = [];
    for (const a of alvos) {
        const nf = a.fraco.nf;
        if (!nf || nf.length < 3) { semNf++; continue; }
        const achados = numerosDoAcervo.get(nf) || [];
        if (achados.length) { existe++; if (exExiste.length < 10) exExiste.push({ a, achados }); }
        else naoExiste++;
    }
    console.log(`\n   o número do lançamento fraco EXISTE em algum arquivo: ${existe}  ${pct(existe, alvos.length)}`);
    console.log(`   não existe no acervo:                                 ${naoExiste}  ${pct(naoExiste, alvos.length)}`);
    console.log(`   lançamento sem número:                                ${semNf}`);
    console.log('\n   → onde EXISTE, o motor emprestou um documento tendo o certo na pasta:');
    console.log('     é falha de BUSCA, e o par fraco é falso.');
    console.log('   → onde NÃO existe, o documento falta de verdade e o par fraco');
    console.log('     é o motor preenchendo um buraco.');

    for (const { a, achados } of exExiste) {
        console.log(`\n   lançamento ${a.fraco.periodo}  ${brl(a.fraco.vLanc)}  NF=${a.fraco.nf}  força ${a.fraco.forca}`);
        console.log(`      pareou com:  ${a.arq.slice(0, 56)}`);
        console.log(`      (esse doc já tem par forte em ${a.forte.periodo}, NF=${a.forte.nf})`);
        console.log(`      mas a NF ${a.fraco.nf} está em:`);
        for (const x of achados.slice(0, 3)) console.log(`          [${x.mes}] ${x.arq.slice(0, 52)}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
