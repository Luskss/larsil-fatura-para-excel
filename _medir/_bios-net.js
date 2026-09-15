/**
 * _medir/_bios-net.js — os documentos BIOS NET, lado a lado.
 *
 * Pergunta do usuário (11/09/2026): dá para diferenciar esses BIOS NET?
 *
 * O sintoma: 5 arquivos quase idênticos, todos com gabarito 75,00 (ou 95/125), e a IA
 * leu 1.170,00 em alguns e 75,00 em outros — MESMA pergunta, respostas diferentes,
 * com `temperature: 0`. Chamei isso de "instabilidade", mas não conferi. Antes de
 * aceitar essa explicação é preciso ver se os documentos são mesmo iguais: se forem
 * DIFERENTES, não há instabilidade nenhuma — há um detalhe no papel que decide, e
 * decidir certo é uma regra, não sorte.
 *
 * 1.170 = 15,6 × 75. Não é múltiplo inteiro, então não é "total de um carnê de 15".
 * Pode ser a soma de várias linhas de serviço — e aí a pergunta é qual linha é a que
 * se paga.
 *
 * Mostra: o gabarito, o que foi gravado, e o TEXTO do PDF em volta dos números.
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_bios-net.js [trecho] [--texto]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const TRECHO = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'BIOS';
const VER_TEXTO = process.argv.includes('--texto');
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

(async () => {
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA ORDER BY PERIODO');

    const doc = new Map();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (!arq.toUpperCase().includes(TRECHO.toUpperCase())) continue;
            let pd = null; try { pd = JSON.parse(x.dados_parser || 'null'); } catch (_) {}
            doc.set(arq, { arq, pd, tipo: x.tipo, origem: x.origem, conteudo: x.conteudo });
        }
    console.log(`documentos casando "${TRECHO}": ${doc.size}\n`);

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    for (const l of doc.values()) {
        const base = path.basename(l.arq.replace(/#p\d+$/, ''));
        const g = j.gabaritos(base);
        console.log('═'.repeat(74));
        console.log(base.slice(0, 70));
        console.log(`   gabarito do nome: valor=${g.valor}  nº=${g.numero}`);
        console.log(`   origem=${l.origem}  tipo=${l.tipo}  conteudo=${l.conteudo}`);
        if (l.pd) {
            const nums = [];
            for (const [k, v] of Object.entries(l.pd)) {
                if (k === 'Itens') continue;
                const n = j.num(v);
                if (n != null) nums.push(`${k}=${n}`);
            }
            console.log(`   números gravados: ${nums.join('  ') || '(nenhum)'}`);
            const its = l.pd['Itens'] || [];
            if (its.length) {
                console.log(`   itens (${its.length}):`);
                for (const it of its.slice(0, 8))
                    console.log(`      ${String(it['Descrição']).slice(0, 42).padEnd(42)} ${it['Valor total']}`);
            }
        }

        const abs = idx.get(base);
        if (!abs) { console.log('   (não achei no disco)'); continue; }
        try {
            const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
            const res = await p.getText();
            try { await p.destroy(); } catch (_) {}
            const text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
            console.log(`   PDF: ${res.total || 1} página(s), ${text.replace(/\s/g, '').length} chars`);

            // Todos os valores monetários do texto, com frequência.
            const vals = (text.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []);
            const cont = new Map();
            for (const v of vals) cont.set(v, (cont.get(v) || 0) + 1);
            const top = [...cont].sort((a, b) => b[1] - a[1]).slice(0, 10);
            console.log(`   valores no texto (${vals.length} ocorrências, ${cont.size} distintos):`);
            console.log('      ' + top.map(([v, n]) => `${v}${n > 1 ? '×' + n : ''}`).join('  '));

            // O gabarito aparece no texto? E o que a IA leu?
            const alvo = g.valor != null
                ? g.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : null;
            if (alvo) console.log(`   o valor do nome (${alvo}) aparece no texto? ` +
                (cont.has(alvo) ? `SIM (${cont.get(alvo)}×)` : 'NÃO'));

            if (VER_TEXTO) {
                console.log('   ── texto ──');
                console.log(text.slice(0, 1800));
            }
        } catch (e) { console.log('   (pdf falhou):', e.message); }
    }
    process.exit(0);
})();
