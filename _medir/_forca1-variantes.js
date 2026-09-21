/**
 * _medir/_forca1-variantes.js — o que fazer com a força 1
 *
 * CONFIRMADO (`_forca1-quem-e-mesmo-falso.js`): dos 147 pares de força 1, **133
 * têm fornecedor incompatível** e o CNPJ não salva nenhum — 81 têm CNPJ
 * DISCORDANDO, 52 não têm CNPJ dos dois lados, **0 batem**. Inspecionei a lista
 * inteira: não há um só caso de nome fantasia. São pares por valor redondo
 * (R$ 70, R$ 75, R$ 100) entre empresas sem relação.
 *
 *     AUTO POSTO CAROLINE  ↔  ADRIANO CIRILO
 *     DETRAN PR            ↔  SENATRAN
 *     JOEL SPELINO         ↔  BIOS NET
 *
 * (O TELEFONICA↔VIVO que me preocupava é força 2, fora deste escopo.)
 *
 * ── As variantes ────────────────────────────────────────────────────────────
 *   A  hoje                    — força 1 forma par sem restrição
 *   B  exigir nome compatível  — só forma se o fornecedor aparecer no documento
 *   C  exigir nome OU CNPJ     — B, mas o CNPJ igual também libera
 *   D  desligar a força 1      — não formar par só por valor
 *
 * ── O que medir ─────────────────────────────────────────────────────────────
 * Não basta contar pares perdidos: perder par FALSO é ganho. A métrica é:
 *   • pares de força 1 que SOBREVIVEM e são compatíveis  → o que se preserva
 *   • pares falsos eliminados                            → o ganho
 *   • pares COMPATÍVEIS eliminados                       → o custo
 *   • as forças 2 e 3 mudam? (não deveriam — a regra só toca a 1)
 *
 * SOMENTE LEITURA — nenhuma alteração em routes/.
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

const RUIDO = /^(DOC|PDF|BOL|AUT|PV|RCB|RC|NF|NFS|NFE|FAT|FT|COMP|EXTRATO|PAGTO|PGTO|E|DE|DA|DO|DOS|DAS|LTDA|ME|EPP|SA|S|A)$/;
function tokensNome(arq) {
    return norm(arq).replace(/\.PDF$/i, '')
        .replace(/\d{1,4}\.DOC-?/i, ' ')
        .replace(/20\d{2}[.\-]\d{1,2}[.\-]\d{1,2}/g, ' ')
        .replace(/[\d.,\/+#-]+/g, ' ')
        .split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
}
function nomeBate(entLanc, arq, emitenteDoc) {
    const e = norm(entLanc);
    if (!e) return true;
    const toks = tokensNome(arq);
    const alvo = e.split(/\s+/).filter(t => t.length >= 4 && !RUIDO.test(t));
    if (!toks.length || !alvo.length) return true;
    for (const a of alvo) for (const t of toks) {
        if (a === t) return true;
        if (a.length >= 5 && t.length >= 5 && (a.startsWith(t.slice(0, 5)) || t.startsWith(a.slice(0, 5)))) return true;
    }
    const em = norm(emitenteDoc || '');
    if (em) for (const a of alvo) if (em.includes(a) || a.includes(em.slice(0, 6))) return true;
    return false;
}
const cnpjDaEntidade = s => {
    const m = String(s).match(/\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/);
    if (m) return soDig(m[0]);
    const d = soDig(s);
    return d.length === 14 ? d : '';
};

(async () => {
    const c = h.carregar();
    const idx = await indexar();

    // coletar TODOS os pares uma vez, com os sinais necessários
    const pares = [];
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
            const o = idx[String(x.documento.arquivo).replace(/#p\d+$/i, '')] || {};
            pares.push({
                periodo, arq: x.documento.arquivo, forca: x.forca,
                ent: String(x.lancamento.entidade || ''),
                emit: String(o.emitente || ''),
                cnpjLanc: cnpjDaEntidade(x.lancamento.entidade),
                cnpjDoc: soDig(o.cnpj || ''),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
            });
        }
    }

    const compat = x => nomeBate(x.ent, x.arq, x.emit);
    const cnpjOk = x => x.cnpjLanc && x.cnpjDoc && x.cnpjLanc.length >= 14 && x.cnpjLanc === x.cnpjDoc;

    const VARIANTES = {
        A_hoje:            () => true,
        B_exige_nome:      x => x.forca > 1 || compat(x),
        C_nome_ou_cnpj:    x => x.forca > 1 || compat(x) || cnpjOk(x),
        D_desliga_forca1:  x => x.forca > 1,
    };

    console.log('═'.repeat(78));
    console.log('O QUE FAZER COM A FORÇA 1');
    console.log('═'.repeat(78));
    console.log(`\n   pares hoje: ${pares.length}`);
    const f1 = pares.filter(x => x.forca === 1);
    const f1Compat = f1.filter(compat);
    console.log(`   força 1: ${f1.length}   compatíveis: ${f1Compat.length}   incompatíveis: ${f1.length - f1Compat.length}`);

    console.log('\nvariante              pares   força1   falsos mortos   compatíveis perdidos');
    const res = {};
    for (const [k, fn] of Object.entries(VARIANTES)) {
        const sobrevivem = pares.filter(fn);
        const s1 = sobrevivem.filter(x => x.forca === 1);
        const falsosMortos = f1.filter(x => !compat(x) && !fn(x)).length;
        const compatPerdidos = f1.filter(x => compat(x) && !fn(x)).length;
        res[k] = { total: sobrevivem.length, f1: s1.length, falsosMortos, compatPerdidos };
        console.log(`  ${k.padEnd(20)} ${String(sobrevivem.length).padStart(5)}   ${String(s1.length).padStart(6)}   ${String(falsosMortos).padStart(13)}   ${String(compatPerdidos).padStart(20)}`);
    }

    // ── as forças 2 e 3 ficam intactas? ────────────────────────────────────
    console.log('\n── as outras forças mudam? (não deveriam) ──────────────────');
    for (const [k, fn] of Object.entries(VARIANTES)) {
        const s = pares.filter(fn);
        const f3 = s.filter(x => x.forca === 3).length, f2 = s.filter(x => x.forca === 2).length;
        console.log(`  ${k.padEnd(20)} força3 ${f3}   força2 ${f2}`);
    }

    // ── os 14 compatíveis que B preserva ───────────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`OS ${f1Compat.length} PARES DE FORÇA 1 QUE B PRESERVA`);
    console.log('═'.repeat(78));
    for (const x of f1Compat.sort((a, b) => b.valor - a.valor)) {
        console.log(`\n   ${x.periodo}  ${brl(x.valor)}`);
        console.log(`      lanç: ${x.ent.slice(0, 44)}`);
        console.log(`      doc:  ${x.arq.slice(0, 56)}`);
    }

    console.log(`\n${'═'.repeat(78)}`);
    console.log('VALOR EM JOGO');
    console.log('═'.repeat(78));
    const vFalso = f1.filter(x => !compat(x)).reduce((s, x) => s + x.valor, 0);
    const vBom = f1Compat.reduce((s, x) => s + x.valor, 0);
    console.log(`\n   força 1 incompatível (ruído): ${brl(vFalso)}`);
    console.log(`   força 1 compatível (preservar): ${brl(vBom)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
