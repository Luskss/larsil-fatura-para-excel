/**
 * _medir/_caca-carnes-falsos.js — procura o padrão de [[carne-dentro-do-comprovante]]:
 * um documento cujo NOME anuncia um valor grande, mas que foi gravado como muitas
 * parcelas pequenas — porque a IA achou um carnê ANEXADO e dividiu o documento
 * errado.
 *
 * O caso que originou: `004.DOC-430000,00-PIX ENVIADO Macponta.pdf` virou 45 parcelas
 * de R$ 6.798,65 do DAYCOVAL, espalhadas até 12.2029, sob o nome da MACPONTA.
 *
 * ── Por que não basta "valor do nome ≠ valor gravado" ────────────────────────
 * Em carnê LEGÍTIMO (consórcio, financiamento) o nome traz a PARCELA, não o total —
 * então a divergência é esperada e não é defeito ([[total-da-nota-nao-e-valor-lancado]]).
 * O que distingue o caso ruim é a soma: num carnê legítimo a parcela do nome é UMA
 * das parcelas gravadas; no caso ruim o valor do nome é muito maior que a soma de
 * TODAS elas, ou não corresponde a nenhuma.
 *
 * Sinais reportados por documento (nenhum é conclusivo sozinho):
 *   nome≫soma   — valor do nome muito maior que a soma das parcelas
 *   órfão       — o valor do nome não bate com nenhuma parcela nem com a soma
 *   entidade≠   — `Emitente` (que vem do nome) diverge da `Razão social (nota)`
 *   espalhado   — parcelas em muitos períodos distintos
 *
 * Uso: node _medir/_caca-carnes-falsos.js [--min 3] [--n 25] [--csv saida.csv]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}
const { getConnection } = require('../config');
const pf = require('../routes/process-folder');
const par = require('../routes/_pareamento');

const args = process.argv.slice(2);
const iMin = args.indexOf('--min');
const MIN_PARC = iMin >= 0 ? parseInt(args[iMin + 1], 10) : 3;
const iN = args.indexOf('--n');
const N = iN >= 0 ? parseInt(args[iN + 1], 10) : 25;
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;

const BRL = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
const numero = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
};
const CH_VALOR = ['Valor total', 'Valor total da nota', 'Valor do boleto', 'Valor do serviço', 'Valor'];

(async () => {
    const pool = await getConnection();
    const rs = await pool.request().input('t', 'M')
        .query('SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@t');

    // Agrupa por PDF base (tirando o #pN), juntando as parcelas espalhadas por período.
    const porPdf = new Map();
    for (const rec of rs.recordset) {
        for (const row of pf.csvToRows(rec.CONTEUDO)) {
            if (!row.arquivo) continue;
            const b = row.arquivo.replace(/#p\d+$/i, '');
            if (!porPdf.has(b)) porPdf.set(b, { base: b, pasta: row.pasta, parcelas: [], periodos: new Set() });
            const g = porPdf.get(b);
            if (/#p\d+$/i.test(row.arquivo)) {
                let dp = {};
                try { dp = JSON.parse(row.dados_parser || '{}') || {}; } catch (_) {}
                let v = null;
                for (const k of CH_VALOR) { v = numero(dp[k]); if (v != null) break; }
                g.parcelas.push({ v, dp });
                g.periodos.add(rec.PERIODO);
            }
        }
    }

    const suspeitos = [];
    for (const g of porPdf.values()) {
        if (g.parcelas.length < MIN_PARC) continue;
        // `documentoDoArquivo` devolve o valor do NOME em `.valor` — não em
        // `.valorDoNome`, que é como `enriquecerComOcr` chama o campo depois. Ler a
        // chave errada fazia `vNome` ser sempre undefined e a varredura devolvia 0
        // suspeitos, inclusive o caso conhecido ([[chave-do-parser-e-em-portugues]]).
        const doc = par.documentoDoArquivo(g.base, g.pasta || '');
        const vNome = doc && (doc.valor != null ? doc.valor : doc.valorDoNome);
        if (vNome == null) continue;

        const vals = g.parcelas.map(p => p.v).filter(v => v != null);
        if (!vals.length) continue;
        const soma = vals.reduce((s, v) => s + v, 0);
        const cent = (x) => Math.round(x * 100);
        const bateAlguma = vals.some(v => cent(v) === cent(vNome));
        const bateSoma = Math.abs(soma - vNome) / Math.max(vNome, 1) < 0.02;
        if (bateAlguma || bateSoma) continue;   // carnê legítimo

        const razoes = new Set(g.parcelas.map(p => norm(p.dp['Razão social (nota)'] || '')).filter(Boolean));
        const emits = new Set(g.parcelas.map(p => norm(p.dp['Emitente'] || '')).filter(Boolean));

        // ── AVISO: esta comparação NÃO é confiável, e é assim de propósito ──────
        // Duas tentativas falharam aqui (16/09/2026):
        //   1. prefixo de 8 caracteres — o emitente vem do NOME do arquivo e traz
        //      valor/documento colados ("R11552897737CREDESP...", "THRFT678AUT"), então
        //      o prefixo quase nunca coincide mesmo com a entidade sendo a MESMA;
        //   2. radical por palavra — inútil, porque `norm()` já REMOVEU os espaços:
        //      "MS LOCACOES DE MAQUINAS" vira uma palavra só e /[A-Z]{3,}/ não separa.
        // O que falta é comparar o RADICAL DA RAZÃO SOCIAL (primeira palavra antes de
        // "LTDA/SA/ME") contra o emitente, a partir do texto COM espaços — e isso não
        // foi medido. Ver [[inspecao-anima-medicao-decide]].
        //
        // Por isso o sinal aqui é deliberadamente CRU: "o emitente contém o começo da
        // razão social?". Ele produz falso positivo em massa (MS LOCACOES, THR e os
        // financiamentos aparecem como divergentes sem ser). Serve para ORDENAR a
        // lista para inspeção humana, nunca para decidir reprocessamento.
        const VAZIO = /^(NAOINFORMADO|NAOIDENTIFICADO|SEMEMITENTE|)$/;
        let entidadeDiverge = false;
        for (const r of razoes) {
            if (VAZIO.test(r)) continue;
            for (const e of emits) {
                if (VAZIO.test(e)) continue;
                // prefixos progressivos: se os 4..12 primeiros caracteres da razão
                // social aparecem no emitente (ou vice-versa), trata como mesma.
                let casa = false;
                for (let k = 12; k >= 4 && !casa; k--) {
                    if (r.length >= k && e.includes(r.slice(0, k))) casa = true;
                    if (e.length >= k && r.includes(e.slice(0, k))) casa = true;
                }
                if (!casa) entidadeDiverge = true;
            }
        }

        suspeitos.push({
            base: g.base, pasta: g.pasta, n: g.parcelas.length,
            vNome, soma, razao: [...razoes][0] || '', emit: [...emits][0] || '',
            periodos: g.periodos.size, entidadeDiverge,
            excesso: vNome / Math.max(soma, 1),
        });
    }

    // INVARIANTE: o caso que originou o script TEM de aparecer. Sem isto, um erro de
    // chave devolve "0 suspeitos" e zero parece resultado — foi o que aconteceu na
    // primeira versão ([[chave-do-parser-e-em-portugues]]).
    const CONHECIDO = 'PIX ENVIADO Macponta';
    if (!suspeitos.some(s => s.base.includes(CONHECIDO))) {
        console.error(`\n⚠  INVARIANTE FALHOU: "${CONHECIDO}" não foi detectado.`);
        console.error(`   A régua está quebrada — o resultado abaixo NÃO é confiável.\n`);
    }

    suspeitos.sort((a, b) => b.vNome - a.vNome);
    console.log(`=== ${suspeitos.length} documentos com parcelas que NÃO explicam o valor do nome ===`);
    console.log(`(>= ${MIN_PARC} parcelas; carnê legítimo — nome bate com uma parcela ou com a soma — já excluído)\n`);

    let comEntidade = 0;
    for (const s of suspeitos) if (s.entidadeDiverge) comEntidade++;
    console.log(`destes, com ENTIDADE divergente (emitente do nome × razão social da nota): ${comEntidade}\n`);

    for (const s of suspeitos.slice(0, N)) {
        const flags = [];
        if (s.excesso > 3) flags.push('nome≫soma');
        if (s.entidadeDiverge) flags.push('entidade≠');
        if (s.periodos >= 12) flags.push(`espalhado(${s.periodos}m)`);
        console.log(`${BRL(s.vNome).padStart(16)} nome | ${BRL(s.soma).padStart(15)} soma de ${String(s.n).padStart(3)} parc | ${flags.join(' ') || '—'}`);
        console.log(`   ${s.base.slice(0, 74)}`);
        if (s.entidadeDiverge) console.log(`   emitente=${s.emit.slice(0, 26)}  razão social=${s.razao.slice(0, 34)}`);
    }

    if (CSV) {
        // A triagem NÃO é veredito — é para o humano filtrar. A distinção que importa:
        // num financiamento o nome do arquivo é descritivo ("GIRO CAIXA EMPRESARIAL") e
        // a razão social é a formal do MESMO banco; no caso ruim são entidades
        // diferentes de verdade (MACPONTA × DAYCOVAL). Separar isso por regra não foi
        // medido, então a coluna marca a SUSPEITA e deixa a decisão com quem olha.
        const BANCOS = /CAIXA|SANTANDER|BRADESCO|ITAU|SICRED|UNIPRIME|DAYCOVAL|JOHNDEERE|BANCODOBRASIL|PORTOSEG|BV|SAFRA/;
        const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
        const linhas = [['arquivo', 'pasta', 'valor_do_nome', 'soma_parcelas', 'n_parcelas',
            'periodos', 'emitente', 'razao_social', 'entidade_diverge', 'triagem'].join(';')];
        for (const s of suspeitos) {
            const ambosBanco = BANCOS.test(s.emit) && BANCOS.test(s.razao);
            let triagem;
            if (s.entidadeDiverge && !ambosBanco) triagem = 'SUSPEITO-entidade-trocada';
            else if (ambosBanco) triagem = 'provavel-financiamento';
            else if (s.excesso > 3) triagem = 'nome-maior-que-soma';
            else triagem = 'rever';
            linhas.push([s.base, s.pasta, s.vNome.toFixed(2).replace('.', ','),
                s.soma.toFixed(2).replace('.', ','), s.n, s.periodos, s.emit, s.razao,
                s.entidadeDiverge ? 'sim' : 'nao', triagem].map(esc).join(';'));
        }
        fs.writeFileSync(CSV, '﻿' + linhas.join('\r\n'), 'utf8');
        const porTriagem = {};
        for (const l of linhas.slice(1)) {
            const t = l.split(';').pop().replace(/"/g, '');
            porTriagem[t] = (porTriagem[t] || 0) + 1;
        }
        console.log(`\n=== CSV salvo: ${CSV} (${suspeitos.length} linhas) ===`);
        for (const [k, v] of Object.entries(porTriagem).sort((a, b) => b[1] - a[1]))
            console.log(`   ${String(v).padStart(4)}  ${k}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
