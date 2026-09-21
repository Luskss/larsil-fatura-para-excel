/**
 * _medir/_os-18-sao-falsos-mesmo.js — o par fraco é falso ou é o 1↔N?
 *
 * DADO QUE MUDA A LEITURA (`_desempate-por-reuso.js`): dos 18 pares que V1
 * recusaria, **em 18 o valor do documento BATE com o lançado**. Nenhum onde não
 * bate.
 *
 * Se fossem empréstimos aleatórios, o valor não bateria sempre. Bater em 18/18 diz
 * que o documento TEM o valor daquele lançamento — o que é a assinatura da
 * MENSALIDADE: o mesmo serviço, mesmo preço, todo mês.
 *
 * Então há duas leituras possíveis para o caso SKILLHUB:
 *
 *   (a) par FALSO — o lançamento 01.2026 NF 8954 deveria casar com o arquivo de
 *       janeiro (NFV8954), e casou com o de abril (NFS 11691) por valor
 *   (b) par LEGÍTIMO por valor — não há nada errado em exibir um documento do
 *       mesmo fornecedor e mesmo valor quando o casamento por número falhou
 *
 * A diferença prática: em (a) o motor TINHA o documento certo e escolheu errado —
 * isso é defeito. Em (b) ele fez o melhor possível.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Para cada um dos 18: o documento "certo" (que tem o número do lançamento) foi
 * pareado com ALGUM lançamento? Com qual?
 *
 *   • se o certo está OCIOSO → o motor errou: tinha o par ideal e não usou
 *   • se o certo já foi usado por OUTRO lançamento → não há o que fazer, os dois
 *     lançamentos disputam o mesmo documento e um vai sobrar
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

    const numeros = new Map();
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const o = idx[a.nome] || {};
            for (const n of [soDig(o.numero || ''), soDig(p.numeroDoNome ? p.numeroDoNome(a.nome) : '')]) {
                if (!n || n.length < 3) continue;
                if (!numeros.has(n)) numeros.set(n, []);
                if (!numeros.get(n).some(x => x.arq === a.nome)) numeros.get(n).push({ mes, arq: a.nome });
            }
        }

    const todosPares = [];
    const usosPorArq = new Map();
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
            const reg = { periodo, arq: x.documento.arquivo, forca: x.forca,
                          vLanc: Math.abs(Number(x.lancamento.valor) || 0),
                          nf: soDig(x.lancamento.nf), ent: norm(x.lancamento.entidade || '') };
            todosPares.push(reg);
            if (!usosPorArq.has(reg.arq)) usosPorArq.set(reg.arq, []);
            usosPorArq.get(reg.arq).push(reg);
        }
    }

    // os 18 de V1
    const alvos = [];
    for (const par of todosPares) {
        const outros = usosPorArq.get(par.arq) || [];
        if (!(par.forca < 3 && outros.some(o => o.forca === 3 && o.periodo !== par.periodo))) continue;
        if (!par.nf || par.nf.length < 3) continue;
        const achados = (numeros.get(par.nf) || []).filter(x => x.arq !== par.arq);
        if (!achados.length) continue;
        alvos.push({ par, achados });
    }

    console.log('═'.repeat(78));
    console.log(`OS ${alvos.length} CASOS: o documento "certo" está ocioso?`);
    console.log('═'.repeat(78));

    let ocioso = 0, jaUsado = 0;
    for (const { par, achados } of alvos) {
        const usados = achados.filter(x => usosPorArq.has(x.arq));
        const livres = achados.filter(x => !usosPorArq.has(x.arq));
        const estado = livres.length ? 'OCIOSO' : 'já usado';
        if (livres.length) ocioso++; else jaUsado++;
        console.log(`\n   ${par.periodo}  ${brl(par.vLanc)}  NF=${par.nf}  força ${par.forca}   [${estado}]`);
        console.log(`      pareou com: ${par.arq.slice(0, 58)}`);
        for (const x of achados.slice(0, 2)) {
            const u = usosPorArq.get(x.arq);
            console.log(`      o doc da NF ${par.nf}: [${x.mes}] ${x.arq.slice(0, 46)}`);
            if (u) for (const y of u) console.log(`          já pareado em ${y.periodo} com ${brl(y.vLanc)} (força ${y.forca})`);
            else console.log('          NÃO foi pareado com nada  ← o motor tinha e não usou');
        }
    }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(78));
    console.log(`\n   o documento certo estava OCIOSO:   ${ocioso}  ← o motor errou de verdade`);
    console.log(`   o documento certo já tinha par:    ${jaUsado}  ← disputa, não erro`);
    console.log('\n   Só o primeiro grupo é pool de conserto. E mesmo nele, recusar o');
    console.log('   par fraco NÃO faz o motor pegar o certo — ele já rodou. O ganho');
    console.log('   real exigiria mexer no PAREAMENTO, não só recusar.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
