/**
 * _medir/_o-numero-curto-colide.js — os "documentos certos ociosos" são colisão
 *
 * SUSPEITA (21/09/2026): `_os-18-sao-falsos-mesmo.js` diz que em 14 casos "o motor
 * tinha o documento certo e não usou". Mas os valores denunciam:
 *
 *     lançamento 06.2026  R$ 120,00  NF=276
 *        "o doc da NF 276": ADS DISTRIBUIDORA, R$ 1.366,37   ← 11× o valor
 *
 *     lançamento 06.2026  R$ 125,00  NF=266709
 *        "o doc da NF 266709": bios net, R$ 1.125,00
 *
 * Um documento de R$ 1.366 não é o "certo" para um lançamento de R$ 120. O que
 * aconteceu: meu índice `numeros` casa por número PURO, sem exigir fornecedor nem
 * ordem de grandeza. NF curta (`276`, `104`, `533`) colide com qualquer coisa.
 *
 * É [[regua-frouxa-inventa-confirmacao]] outra vez, e [[piso-digitos-numero-curto]]
 * já tinha registrado que número curto é traiçoeiro neste acervo.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Refazer os 18 exigindo que o documento "certo" seja PLAUSÍVEL:
 *   • mesmo fornecedor (ou nome parecido)
 *   • valor na mesma ordem de grandeza do lançamento
 *
 * Se sobrar quase nada, o pool é ruído e não há conserto a fazer — a resposta à
 * pergunta do usuário passa a ser "o motor já distingue o que dá para distinguir".
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
    const infoArq = new Map();
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            const o = idx[a.nome] || {};
            const d = p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), o);
            infoArq.set(a.nome, { mes, ent: norm(d.emitente || o.emitente || ''),
                                   valor: Math.abs(Number(d.valor || o.valor) || 0) });
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
    console.log(`OS ${alvos.length} "DOCUMENTOS CERTOS": são plausíveis?`);
    console.log('═'.repeat(78));

    const entParecida = (a, b) => {
        if (!a || !b) return false;
        const x = a.slice(0, 8), y = b.slice(0, 8);
        return a.includes(y) || b.includes(x);
    };

    let plausivel = 0, entDiferente = 0, valorAbsurdo = 0;
    const bons = [];
    for (const { par, achados } of alvos) {
        let achouBom = null;
        let motivo = '';
        for (const x of achados) {
            const i = infoArq.get(x.arq) || {};
            const mesmaEnt = entParecida(par.ent, i.ent);
            const razao = i.valor && par.vLanc ? Math.max(i.valor, par.vLanc) / Math.min(i.valor, par.vLanc) : 99;
            const mesmaOrdem = razao <= 1.5;
            if (mesmaEnt && mesmaOrdem) { achouBom = { x, i }; break; }
            if (!mesmaEnt) motivo = 'fornecedor diferente';
            else if (!mesmaOrdem) motivo = `valor ${razao.toFixed(1)}× diferente`;
        }
        if (achouBom) { plausivel++; bons.push({ par, ...achouBom }); }
        else if (motivo === 'fornecedor diferente') entDiferente++;
        else valorAbsurdo++;
    }

    console.log(`\n   o "documento certo" é PLAUSÍVEL (mesmo fornecedor + mesma ordem de valor): ${plausivel}`);
    console.log(`   fornecedor diferente (colisão de número):                                  ${entDiferente}`);
    console.log(`   valor em outra ordem de grandeza:                                          ${valorAbsurdo}`);

    if (bons.length) {
        console.log('\n── os plausíveis ───────────────────────────────────────────');
        for (const b of bons) {
            console.log(`\n   ${b.par.periodo}  ${brl(b.par.vLanc)}  NF=${b.par.nf}  força ${b.par.forca}`);
            console.log(`      pareou com:  ${b.par.arq.slice(0, 56)}`);
            console.log(`      deveria ser: [${b.x.mes}] ${b.x.arq.slice(0, 50)}`);
            console.log(`                   ${b.i.ent.slice(0, 26)}  ${brl(b.i.valor)}`);
            console.log(`      esse doc já tem par? ${usosPorArq.has(b.x.arq) ? 'SIM' : 'NÃO — ocioso'}`);
        }
    }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(78));
    console.log(`\n   Dos ${alvos.length} casos, só ${plausivel} têm um documento alternativo que`);
    console.log('   realmente faz sentido. Os demais são colisão de número curto');
    console.log('   ([[piso-digitos-numero-curto]]): "NF 276" casa com qualquer coisa.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
