/**
 * _medir/_separar-ld-de-juros.js — dá para soltar a trava só onde a LD prova?
 *
 * ESTADO (21/09/2026, [[localiza-valor-do-item-nao-do-total]]): a causa dos valores
 * errados está isolada. `_valor-do-pagamento.js:194` só deixa o boleto vencer quando
 * é MENOR que a base; em 19 dos 58 casos o valor da LINHA DIGITÁVEL bate exatamente
 * com o lançamento e a trava o barra por ser maior.
 *
 * Mas soltar a trava para todo boleto-com-LD REPROVA: 12 curados × 7 quebrados
 * (1,7×). Este projeto já reprovou variantes bem melhores que isso.
 *
 * ── Por que 7 quebram ───────────────────────────────────────────────────────
 * A trava existe porque boleto MAIOR costuma ser multa/juros — o comentário cita o
 * SENATRAN 78,09 → 130,16, e esse caso aparece LITERALMENTE na minha lista de
 * "curados" (LOCALIZA FAT 419258: 410,01 lançado, 130,16 gravado). Ou seja: o mesmo
 * número é evidência dos dois lados dependendo de qual testemunha se olha.
 *
 * ── A hipótese a testar ─────────────────────────────────────────────────────
 * A LINHA DIGITÁVEL não é uma leitura: os 10 dígitos do campo 4 SÃO o valor, com DV.
 * Se o valor da LD == valor no NOME do arquivo, temos DUAS provas independentes
 * (aritmética do código de barras + o que o arquivista digitou).
 *
 * Variantes:
 *   W  soltar a trava sempre que houver LD válida            (o que já reprovou)
 *   X  soltar só quando LD == valor do NOME (dupla prova)
 *   Y  soltar só quando a LD passa no DV (mod 10/11 dos campos)
 *   Z  X e Y juntas
 *
 * Nota: X usa o nome do arquivo, que é o GABARITO das minhas medições. Medir X
 * contra o próprio gabarito seria circular ([[gabarito-frouxo-inventa-erro]]).
 * Então X é julgado por OUTRA testemunha: o valor LANÇADO na planilha, que não
 * participa da regra.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');
const { paraNumero } = require('../routes/_valor-do-pagamento');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function valorDaLinhaDigitavel(ld) {
    const d = String(ld || '').replace(/\D/g, '');
    if (d.length !== 47) return null;
    const v = Number(d.slice(37, 47)) / 100;
    return v > 0 ? v : null;
}
// DV dos 3 primeiros campos da linha digitável (mod 10) — prova que os dígitos não
// foram corrompidos na leitura. O campo 4 (valor) é protegido pelo DV geral do
// código de barras, posição 5 do campo 1..4 concatenado; aqui uso o mod 10 dos
// campos 1-3, que é o que se pode conferir sem remontar o código de barras.
function mod10ok(campo) {
    const d = campo.replace(/\D/g, '');
    if (d.length < 2) return false;
    const corpo = d.slice(0, -1), dv = Number(d.slice(-1));
    let soma = 0, peso = 2;
    for (let i = corpo.length - 1; i >= 0; i--) {
        let x = Number(corpo[i]) * peso;
        if (x > 9) x -= 9;
        soma += x; peso = peso === 2 ? 1 : 2;
    }
    return ((10 - (soma % 10)) % 10) === dv;
}
function ldPassaDV(ld) {
    const d = String(ld || '').replace(/\D/g, '');
    if (d.length !== 47) return false;
    return mod10ok(d.slice(0, 10)) && mod10ok(d.slice(10, 21)) && mod10ok(d.slice(21, 32));
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const vn = p.valorDoNome;

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
    const banco = new Map();
    for (const row of rs.recordset) {
        const csv = row.CONTEUDO;
        if (!csv) continue;
        const ls = csv.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
        if (ls.length < 2) continue;
        const cols = ls[0].replace(/^﻿/, '').split(';');
        const iA = cols.indexOf('arquivo'), iD = cols.indexOf('dados_parser');
        if (iA < 0 || iD < 0) continue;
        for (let i = 1; i < ls.length; i++) {
            const f = sep(ls[i]);
            const arq = base(String(f[iA] || '').trim());
            if (!arq || banco.has(arq)) continue;
            const bruto = (f[iD] || '').trim();
            if (!bruto.startsWith('{')) continue;
            try { banco.set(arq, JSON.parse(bruto)); } catch (e) {}
        }
    }

    // ── julgar pelo LANÇAMENTO (testemunha que não entra em nenhuma variante) ──
    const lancPorArquivo = new Map();
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => p.lancamentoDaPlanilha(l));
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const v = Math.abs(Number(x.lancamento.valor) || 0);
            if (v) lancPorArquivo.set(base(x.documento.arquivo), v);
        }
    }
    console.log(`documentos com lançamento pareado (a testemunha): ${lancPorArquivo.size}\n`);

    const VARIANTES = {
        W_sempre:        (vLD, ld, vNome) => vLD != null,
        X_ld_igual_nome: (vLD, ld, vNome) => vLD != null && vNome > 0 && Math.abs(vLD - vNome) < 0.02,
        Y_dv_confere:    (vLD, ld, vNome) => vLD != null && ldPassaDV(ld),
        Z_ambas:         (vLD, ld, vNome) => vLD != null && ldPassaDV(ld) && vNome > 0 && Math.abs(vLD - vNome) < 0.02,
    };

    const res = {};
    for (const k of Object.keys(VARIANTES)) res[k] = { age: 0, cura: 0, quebra: 0, indif: 0 };

    for (const [arq, pd] of banco) {
        const vLanc = lancPorArquivo.get(arq);
        if (!vLanc) continue;                        // sem testemunha, não julga
        const ld = pd['Linha digitável'];
        const vLD = valorDaLinhaDigitavel(ld);
        const bol = paraNumero(pd['Valor do boleto']);
        const nota = paraNumero(pd['Valor total da nota']);
        const tot = paraNumero(pd['Valor total']);
        const baseTrava = nota != null ? nota : tot;
        const barrado = bol != null && baseTrava != null && !(bol < baseTrava);
        if (!barrado || tot == null) continue;       // a mudança só age aqui
        const vNome = Math.abs(Number(vn(arq)) || 0);

        const certoHoje = Math.abs(tot - vLanc) < 0.02;
        for (const [k, fn] of Object.entries(VARIANTES)) {
            if (!fn(vLD, ld, vNome)) continue;       // variante não age neste doc
            res[k].age++;
            const certoDepois = Math.abs(vLD - vLanc) < 0.02;
            if (!certoHoje && certoDepois) res[k].cura++;
            else if (certoHoje && !certoDepois) res[k].quebra++;
            else res[k].indif++;
        }
    }

    console.log('═'.repeat(76));
    console.log('JULGADO PELO VALOR LANÇADO NA PLANILHA (não pelo nome)');
    console.log('═'.repeat(76));
    console.log('\nvariante              age   cura   quebra   indif   razão');
    for (const [k, v] of Object.entries(res)) {
        const razao = v.quebra ? (v.cura / v.quebra).toFixed(1) + '×' : (v.cura ? '∞' : '—');
        console.log(`  ${k.padEnd(20)} ${String(v.age).padStart(4)}  ${String(v.cura).padStart(5)}   ${String(v.quebra).padStart(6)}  ${String(v.indif).padStart(6)}   ${razao.padStart(6)}`);
    }

    console.log('\nLEITURA: a variante boa cura muito quebrando pouco. Abaixo de ~10×');
    console.log('este projeto já reprovou consertos melhores que este.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
