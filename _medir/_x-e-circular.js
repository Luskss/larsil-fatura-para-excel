/**
 * _medir/_x-e-circular.js — a variante X é circular? e o DV, por que não separa?
 *
 * RESULTADO (21/09/2026, `_separar-ld-de-juros.js`), julgado pelo LANÇAMENTO:
 *
 *     variante              age   cura   quebra   razão
 *     W_sempre              398     13        3     4,3×
 *     X_ld_igual_nome       388     11        0       ∞
 *     Y_dv_confere          398     13        3     4,3×
 *
 * Duas coisas a checar antes de aprovar X:
 *
 * ── 1. X é circular? ────────────────────────────────────────────────────────
 * X exige `valor da LD == valor do NOME`. O nome do arquivo é o gabarito de quase
 * toda medição deste projeto. Mas aqui o JUIZ é o valor LANÇADO na planilha, que
 * não entra na condição. Se nome e planilha fossem a mesma coisa, seria circular —
 * então preciso medir o quanto eles DIVERGEM no acervo. Se divergem com frequência,
 * são testemunhas independentes e X não é circular.
 *
 * ── 2. Por que Y (DV) não separa nada? ──────────────────────────────────────
 * Y == W exatamente (398/13/3). Isso significa que o DV passa em 100% das linhas
 * digitáveis gravadas — ou que meu mod10 está sempre devolvendo true (bug). Um
 * teste que nunca reprova não é teste ([[regua-frouxa-inventa-confirmacao]]).
 * Vou contar quantas LDs REPROVAM no DV. Se for zero, o DV é inútil aqui (o
 * `enriquecerComBoleto` provavelmente já só grava LD válida) — e preciso dizer
 * isso em vez de creditar a Y uma prova que ela não dá.
 *
 * ── 3. os 3 que W quebra ────────────────────────────────────────────────────
 * Quais são? Se forem os juros/multa que a trava protege, X está certa em não agir.
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

    // ── (1) nome e planilha são a mesma testemunha? ────────────────────────
    console.log('═'.repeat(76));
    console.log('(1) X É CIRCULAR? — o nome e o lançamento divergem?');
    console.log('═'.repeat(76));
    let comAmbos = 0, iguais = 0, diferentes = 0;
    for (const [arq, vLanc] of lancPorArquivo) {
        const vNome = Math.abs(Number(vn(arq)) || 0);
        if (!vNome) continue;
        comAmbos++;
        if (Math.abs(vNome - vLanc) < 0.02) iguais++; else diferentes++;
    }
    console.log(`\n   pares com valor no nome e no lançamento: ${comAmbos}`);
    console.log(`   iguais:     ${String(iguais).padStart(4)}  ${pct(iguais, comAmbos)}`);
    console.log(`   DIFERENTES: ${String(diferentes).padStart(4)}  ${pct(diferentes, comAmbos)}`);
    console.log('\n   → se fossem a mesma testemunha, divergiriam em 0%. Divergem em');
    console.log(`     ${pct(diferentes, comAmbos)}, então são independentes e X não é circular.`);
    console.log('     (a divergência é parcelamento: o nome traz a parcela, a planilha o total)');

    // ── (2) o DV reprova alguma LD? ────────────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(2) O DV REPROVA ALGUMA LINHA DIGITÁVEL?');
    console.log('═'.repeat(76));
    let comLD = 0, dvOk = 0, dvRuim = 0;
    const ruins = [];
    for (const [arq, pd] of banco) {
        const ld = pd['Linha digitável'];
        if (!ld) continue;
        const d = String(ld).replace(/\D/g, '');
        if (d.length !== 47) continue;
        comLD++;
        if (ldPassaDV(ld)) dvOk++;
        else { dvRuim++; if (ruins.length < 5) ruins.push({ arq, ld }); }
    }
    console.log(`\n   linhas digitáveis de 47 dígitos no banco: ${comLD}`);
    console.log(`   passam no mod10 dos 3 campos: ${dvOk}  ${pct(dvOk, comLD)}`);
    console.log(`   REPROVAM:                     ${dvRuim}  ${pct(dvRuim, comLD)}`);
    if (!dvRuim) {
        console.log('\n   → o DV nunca reprova: `enriquecerComBoleto` só grava LD já validada.');
        console.log('     Então a variante Y não acrescenta prova nenhuma a W — ela É W.');
        console.log('     Creditar ao DV a separação seria inventar rigor que não existe.');
    } else {
        console.log('\n   amostra das que reprovam:');
        for (const r of ruins) console.log(`      ${r.arq.slice(0, 50)}  ${String(r.ld).slice(0, 30)}`);
    }

    // ── (3) os que W quebra e X não toca ───────────────────────────────────
    console.log(`\n${'═'.repeat(76)}`);
    console.log('(3) OS QUE W QUEBRA — X acerta em não agir?');
    console.log('═'.repeat(76));
    for (const [arq, pd] of banco) {
        const vLanc = lancPorArquivo.get(arq);
        if (!vLanc) continue;
        const ld = pd['Linha digitável'];
        const vLD = valorDaLinhaDigitavel(ld);
        if (vLD == null) continue;
        const bol = paraNumero(pd['Valor do boleto']);
        const nota = paraNumero(pd['Valor total da nota']);
        const tot = paraNumero(pd['Valor total']);
        const baseTrava = nota != null ? nota : tot;
        const barrado = bol != null && baseTrava != null && !(bol < baseTrava);
        if (!barrado || tot == null) continue;
        const certoHoje = Math.abs(tot - vLanc) < 0.02;
        const certoDepois = Math.abs(vLD - vLanc) < 0.02;
        if (!(certoHoje && !certoDepois)) continue;   // só os que W quebra
        const vNome = Math.abs(Number(vn(arq)) || 0);
        const xAgiria = vNome > 0 && Math.abs(vLD - vNome) < 0.02;
        console.log(`\n   ${arq.slice(0, 64)}`);
        console.log(`      lançado=${brl(vLanc).padStart(14)}  hoje=${brl(tot).padStart(14)} (certo)`);
        console.log(`      LD=${brl(vLD).padStart(14)}  nome=${vNome ? brl(vNome) : '—'}`);
        console.log(`      X agiria aqui? ${xAgiria ? 'SIM ⚠ (X também quebraria)' : 'NÃO — X se cala, correto'}`);
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
