/**
 * _medir/_bios-acha-a-fatura.js — o número da fatura está DENTRO do PDF?
 *
 * Pergunta do usuário (11/09/2026): "não dá pra diferenciar pela fatura mesmo?"
 *
 * Eu afirmei que a informação que liga `FT 245650` a um endereço específico NÃO está
 * no PDF, e concluí que nenhuma leitura resolveria. Não conferi — só olhei os
 * primeiros 1.800 caracteres da página 1 (a Ordem de Compra). O PDF tem 2 páginas.
 *
 * Se o número da fatura aparecer no texto, a conclusão inverte: dá para localizar a
 * linha certa e o conserto é uma REGRA determinística, não IA.
 *
 * Procura, no texto inteiro de cada PDF:
 *   1. o número da fatura do nome do arquivo (245650, 242547, ...)
 *   2. o que está em volta dele
 *   3. se há mais de uma fatura citada (o PDF pode listar todas)
 *
 * SOMENTE LEITURA.
 *
 * Uso: node _medir/_bios-acha-a-fatura.js [trecho] [--pag2]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const j = require('./_julgar-campos');
const { PDFParse } = require('pdf-parse');
const pare = require('../routes/_pareamento');
const { getConnection, sql } = require('../config');
const pf = require('../routes/process-folder');

const TRECHO = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'BIOS';
const VER_PAG2 = process.argv.includes('--pag2');
const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;

(async () => {
    const pool = await getConnection();
    const rr = await pool.request()
        .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA');
    const nomes = new Set();
    for (const reg of rr.recordset)
        for (const x of pf.csvToRows(reg.CONTEUDO)) {
            const arq = String(x.arquivo);
            if (arq.toUpperCase().includes(TRECHO.toUpperCase()))
                nomes.add(path.basename(arq.replace(/#p\d+$/, '')));
        }

    const idx = new Map();
    (function anda(d) {
        let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const x of e) { const q = path.join(d, x.name);
            if (x.isDirectory()) anda(q); else if (!idx.has(x.name)) idx.set(x.name, q); }
    })(RAIZ_ARQ);

    let achou = 0, naoAchou = 0, semArquivo = 0;
    const lista = [...nomes].slice(0, 14);
    console.log(`testando ${lista.length} de ${nomes.size} documentos\n`);

    for (const base of lista) {
        const abs = idx.get(base);
        if (!abs) { semArquivo++; continue; }
        const g = pare.numeroDoNome(base);
        const gv = pare.valorDoNome(base);

        let text = '';
        try {
            const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
            const res = await p.getText();
            try { await p.destroy(); } catch (_) {}
            text = (res.text || '').replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ');
        } catch (e) { console.log(`(pdf falhou) ${base.slice(0, 40)}`); continue; }

        const num = String(g || '').replace(/\D/g, '');
        const temNumero = num && text.replace(/\D/g, '').includes(num);
        if (temNumero) achou++; else naoAchou++;

        console.log('─'.repeat(72));
        console.log(`${base.slice(0, 66)}`);
        console.log(`   nome: fatura=${g}  valor=${gv}`);
        console.log(`   o número ${num} aparece no texto? ${temNumero ? 'SIM' : 'NÃO'}`);

        if (temNumero) {
            // Mostra o contexto em volta de cada ocorrência.
            const re = new RegExp(num.split('').join('\\s*'), 'g');
            let m, n = 0;
            while ((m = re.exec(text)) !== null && n < 3) {
                const ini = Math.max(0, m.index - 160), fim = Math.min(text.length, m.index + 200);
                console.log(`   ── ocorrência ${++n} ──`);
                console.log('   ' + text.slice(ini, fim).replace(/\s+/g, ' ').trim());
            }
        }

        // Que outros números de 6 dígitos o PDF cita? Se citar VÁRIOS, ele lista
        // todas as faturas e a linha certa pode ser localizada.
        const seis = [...new Set(text.match(/\b\d{6}\b/g) || [])];
        console.log(`   números de 6 dígitos no PDF (${seis.length}): ${seis.slice(0, 12).join(' ')}`);
    }

    console.log('\n── RESUMO ──────────────────────────────────────────────────');
    console.log(`   número da fatura ACHADO no PDF:    ${achou}`);
    console.log(`   não achado:                        ${naoAchou}`);
    console.log(`   arquivo não encontrado no disco:   ${semArquivo}`);

    if (VER_PAG2) {
        const abs = idx.get(lista[0]);
        if (abs) {
            const p = new PDFParse({ data: new Uint8Array(fs.readFileSync(abs)) });
            const res = await p.getText();
            try { await p.destroy(); } catch (_) {}
            const t = (res.text || '');
            console.log('\n── TEXTO COMPLETO DO 1º (as duas páginas) ──');
            console.log(t);
        }
    }
    process.exit(0);
})();
