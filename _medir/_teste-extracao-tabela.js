/**
 * _medir/_teste-extracao-tabela.js — outro caminho de extração dá mais veracidade?
 *
 * A causa raiz dos bugs de §15.1/§15.2 é sempre a mesma: `getText` devolve texto
 * PLANO e joga fora o layout. Perdido o layout, perde-se qual número estava em qual
 * coluna — e daí:
 *   · GENUSCLIN: `ISSQN 179,43` e `COFINS 179,43` colidem, indistinguíveis;
 *   · G.A.R: `PIS/COFINS/CSLL 4,65%: R$ 25,39` faz a regex pegar a alíquota;
 *   · notas onde o rótulo fica numa linha e o número em outra (`_nf-itens.js` §2 já
 *     documenta que ler por POSIÇÃO de coluna no texto plano está REPROVADO).
 *
 * Mas o pdf-parse 2.x expõe `getTable`/`getPageTables`, que reconstrói a TABELA a
 * partir da geometria do PDF (linhas e células), não do fluxo de texto. Se as
 * células vierem separadas, rótulo e valor ficam pareados por construção — a
 * ambiguidade que causa os bugs deixa de existir na origem.
 *
 * Este script NÃO muda nada. Compara as duas leituras nos casos reais difíceis e
 * mostra o que cada uma entrega, para a decisão vir do que se vê.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const { PDFParse } = require('pdf-parse');

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
// Os casos que custaram depuração hoje, mais um controle que já funciona.
// A CORREA está em ABRIL (foi ela que abriu o assunto), o resto em março.
const ALVOS = [
    ['GENUSCLIN  (ISSQN×COFINS mesmo valor)', 'GENUSCLIN',              '2026.03.EXTRATOS CONTABILIDADE'],
    ['G.A.R      (alíquota colada no rótulo)', 'G. A. R MEDICINA',       '2026.03.EXTRATOS CONTABILIDADE'],
    ['MRD        (layout nacional)',           'MRD ENGENHARIA. NFS 107','2026.03.EXTRATOS CONTABILIDADE'],
    ['CORREA     (controle: já funciona)',     'CORREA TRUCK',           '2026.04.EXTRATOS CONTABILIDADE'],
    ['SKILLHUB   (alíquotas, deve recusar)',   'SKILLHUB NFS 10737',     '2026.03.EXTRATOS CONTABILIDADE'],
];

function achar(dir, alvo, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) achar(p, alvo, out);
        else if (e.name.includes(alvo)) out.push(p);
    }
    return out;
}

// Achata uma tabela em linhas legíveis, para inspeção.
function mostrarTabela(t, max = 14) {
    const linhas = [];
    const rows = t && (t.rows || t.data || t);
    if (!Array.isArray(rows)) return ['(formato inesperado: ' + JSON.stringify(t).slice(0, 160) + ')'];
    for (const r of rows.slice(0, max)) {
        const cels = Array.isArray(r) ? r : (r.cells || r.values || []);
        const txt = cels.map(c => {
            const v = (c && typeof c === 'object') ? (c.text ?? c.value ?? JSON.stringify(c)) : c;
            return String(v ?? '').replace(/\s+/g, ' ').trim();
        }).filter(Boolean);
        if (txt.length) linhas.push('| ' + txt.join(' | '));
    }
    return linhas;
}

(async () => {
    for (const [rotulo, alvo, pasta] of ALVOS) {
        const achados = achar(path.join(RAIZ_ARQ, pasta), alvo);
        console.log('\n' + '='.repeat(78));
        console.log(rotulo);
        console.log('='.repeat(78));
        if (!achados.length) { console.log('  (arquivo não encontrado)'); continue; }

        const buf = fs.readFileSync(achados[0]);

        // ── caminho ATUAL: texto plano ──
        let plano = '';
        {
            const pr = new PDFParse({ data: new Uint8Array(buf) });
            try { plano = (await pr.getText()).text || ''; } catch (e) { plano = '[erro] ' + e.message; }
            finally { try { await pr.destroy(); } catch (_) {} }
        }
        const n = plano.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
        const i = n.search(/VALOR LIQUIDO|TOTAL (DAS RETENCOES|TRIB)|ISSQN|PIS\s*\//);
        console.log('\n── getText (texto plano, o que usamos hoje) ──');
        console.log(i >= 0 ? n.slice(Math.max(0, i - 160), i + 300) : n.slice(0, 300));

        // ── caminho NOVO: tabelas com geometria ──
        console.log('\n── getPageTables (células com layout preservado) ──');
        const pr2 = new PDFParse({ data: new Uint8Array(buf) });
        try {
            // `getTable` é a entrada pública (carrega o documento); `getPageTables`
            // é interna e exige a página já resolvida — chamá-la direto quebra em
            // `getViewport`.
            const r = await pr2.getTable();
            const paginas = r && (r.pages || r.tables || []);
            if (!paginas.length) { console.log('  (nenhuma tabela detectada)'); }
            else {
                let mostradas = 0;
                for (const pg of paginas) {
                    const tabs = pg.tables || pg || [];
                    for (const t of (Array.isArray(tabs) ? tabs : [tabs])) {
                        const linhas = mostrarTabela(t);
                        // Só as tabelas que contêm número com centavos — as fiscais.
                        if (!linhas.some(l => /\d,\d{2}/.test(l))) continue;
                        console.log(`  [tabela ${++mostradas}]`);
                        for (const l of linhas) console.log('   ' + l.slice(0, 170));
                        if (mostradas >= 3) break;
                    }
                    if (mostradas >= 3) break;
                }
                if (!mostradas) console.log('  (tabelas detectadas, mas nenhuma com valores monetários)');
            }
        } catch (e) {
            console.log('  [erro] ' + e.message);
        } finally { try { await pr2.destroy(); } catch (_) {} }
    }
    process.exit(0);
})();
