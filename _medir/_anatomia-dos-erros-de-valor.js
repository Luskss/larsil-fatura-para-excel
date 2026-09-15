/**
 * _medir/_anatomia-dos-erros-de-valor.js — que TIPO de erro são os 5.318?
 *
 * Pergunta do usuário (11/09/2026): como acertar mais valores?
 *
 * Não dá para responder sem saber que erro é. Um remendo de prompt contra a classe
 * errada é exatamente o que [[remendo-de-prompt-quebra-o-que-funciona]] documenta
 * como reprovado — duas tentativas no mesmo dia, e juntas piores que separadas.
 *
 * Classifica cada valor errado pela RELAÇÃO aritmética com o gabarito do nome, que é
 * o que distingue as causas:
 *
 *   multiplo-inteiro  lido = N × gabarito   → leu o total, o nome traz a parcela
 *   submultiplo       gabarito = N × lido   → leu UMA parcela, o nome traz o total
 *   soma-de-itens     lido ≈ soma dos itens ≠ total
 *   digito-a-mais     lido = gabarito × 10^k → separador decimal
 *   transposto        mesmos dígitos, ordem trocada
 *   vizinho           diferença < 5% → centavos, desconto, juros
 *   outro             sem relação aritmética
 *
 * Cada classe pede conserto DIFERENTE, e algumas nem são erro da IA (a nota tem
 * mesmo outro valor; quem erra é usar o total onde se paga a parcela).
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';
const ROT_VALOR = ['Valor total da nota', 'Valor total', 'Valor do serviço',
                   'Valor principal', 'Valor da prestação', 'Valor líquido'];
const primeiro = (pd, ks) => { for (const k of ks) if (pd && !VAZIO(pd[k])) return pd[k]; return null; };

function classificar(lido, gab, pd) {
    const r = lido / gab;
    // múltiplo inteiro (jValor já marca 2..60 como 'parcela'; aqui pega o resto)
    const n = Math.round(r);
    if (n >= 2 && Math.abs(r - n) < 0.02) return 'multiplo-inteiro';
    const inv = gab / lido, ni = Math.round(inv);
    if (ni >= 2 && Math.abs(inv - ni) < 0.02) return 'submultiplo';
    // potência de 10 → vírgula/ponto
    for (const k of [10, 100, 1000, 0.1, 0.01, 0.001])
        if (Math.abs(r - k) < 0.02 * k) return 'digito-a-mais';
    // soma dos itens
    const itens = (pd && pd['Itens']) || [];
    if (itens.length) {
        const soma = itens.reduce((s, it) => s + (j.num(it['Valor total']) || 0), 0);
        if (soma > 0 && Math.abs(lido - soma) <= Math.max(0.05, soma * 0.01)) return 'soma-de-itens';
    }
    // mesmos dígitos em outra ordem
    const dig = x => String(Math.round(x * 100)).split('').sort().join('');
    if (dig(lido) === dig(gab)) return 'transposto';
    if (Math.abs(lido - gab) / gab < 0.05) return 'vizinho';
    return 'outro';
}

(async () => {
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');

    const classes = new Map();
    const porTipoDoc = new Map();
    const exemplos = new Map();
    const vistos = new Set();
    let totalErro = 0, totalJulgado = 0, totalOk = 0;

    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            const chave = `${reg.TIPO}|${reg.PERIODO}|${arq}`;
            if (vistos.has(chave)) continue;
            vistos.add(chave);
            const base = path.basename(arq.replace(/#p\d+$/, ''));
            const g = j.gabaritos(base);
            if (g.valor == null) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            const v = j.num(primeiro(pd, ROT_VALOR));
            if (v == null) continue;
            totalJulgado++;
            const cls = j.jValor(v, g.valor);
            if (cls === 'ok') { totalOk++; continue; }
            if (cls !== 'erro' && cls !== 'parcela') continue;
            totalErro++;

            const k = cls === 'parcela' ? 'multiplo-inteiro' : classificar(v, g.valor, pd);
            classes.set(k, (classes.get(k) || 0) + 1);
            const t = String(x.tipo || '?');
            if (!porTipoDoc.has(k)) porTipoDoc.set(k, new Map());
            porTipoDoc.get(k).set(t, (porTipoDoc.get(k).get(t) || 0) + 1);
            if (!exemplos.has(k)) exemplos.set(k, []);
            if (exemplos.get(k).length < 6)
                exemplos.get(k).push({ base, lido: v, gab: g.valor, tipo: t, origem: x.origem });
        }

    console.log(`linhas com valor lido e gabarito: ${totalJulgado}`);
    console.log(`   ok: ${totalOk} (${(100 * totalOk / totalJulgado).toFixed(0)}%)`);
    console.log(`   fora do alvo: ${totalErro}\n`);

    console.log('ANATOMIA DOS ERROS');
    console.log('   classe              casos     %   tipos de documento mais comuns');
    for (const [k, n] of [...classes].sort((a, b) => b[1] - a[1])) {
        const tipos = [...porTipoDoc.get(k)].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([t, c]) => `${t}:${c}`).join('  ');
        console.log('   ' + k.padEnd(18) + String(n).padStart(6) +
            (100 * n / totalErro).toFixed(0).padStart(5) + '%   ' + tipos);
    }

    console.log('\nEXEMPLOS');
    for (const [k, ex] of exemplos) {
        console.log(`\n   ── ${k} ──`);
        for (const e of ex)
            console.log(`      leu=${String(e.lido).padStart(12)}  nome=${String(e.gab).padStart(12)}` +
                `  ${String(e.tipo).padEnd(8)} ${String(e.origem).padEnd(9)} ${e.base.slice(0, 34)}`);
    }
    process.exit(0);
})();
