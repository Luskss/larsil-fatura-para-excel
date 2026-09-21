/**
 * _medir/_emitente-data-com-hifen.js — quantos nomes têm data com HÍFEN?
 *
 * DEFEITO (21/09/2026), achado no caso MACPONTA: `extrairEmitente`
 * (_nf-parsers.js:38) corta o nome do arquivo até a DATA, com esta regex:
 *
 *     /(?:20\d{2}\.\d{2}\.\d{2}|\d{2}\.\d{2}\.20\d{2}|\b20\d{2})\.?/
 *
 * Ela só aceita PONTO como separador. Quando o arquivista escreve
 * `2026.01-19` (ponto + hífen), nenhuma das duas formas completas casa; sobra o
 * `\b20\d{2}` solto, que consome só "2026" e deixa "01-19- " no começo do
 * emitente:
 *
 *     "031.DOC- 1320000,00-2026.01-19- MACPONTA.pdf" → "01-19- MACPONTA"
 *
 * O emitente é o campo que o comparador usa para casar
 * ([[emitente-nao-vem-do-extrator]]), então o lixo na frente atrapalha o
 * pareamento, não só a exibição.
 *
 * ── O que se mede, ANTES de consertar ───────────────────────────────────────
 *   1. quantos arquivos do acervo têm data com separador misto/hífen
 *   2. em quantos o emitente extraído ficou com resto numérico na frente
 *   3. o CONTRAPESO: a regex corrigida muda o emitente de quem hoje está CERTO?
 *
 * Ganho possível = nomes hoje com lixo − nomes hoje certos que mudariam.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_nf-parsers');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';

// o emitente começa com resto de data? ("01-19- MACPONTA", "19- FULANO")
const LIXO_NA_FRENTE = /^[\d\-.\/\s]{2,}/;

(async () => {
    const c = h.carregar();

    const todos = [];
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) todos.push({ mes, nome: a.nome });

    console.log(`arquivos no acervo: ${todos.length}\n`);

    // ── 1) formas de data no nome ──────────────────────────────────────────
    const FORMAS = [
        ['AAAA.MM.DD  (ponto, canônica)', /20\d{2}\.\d{2}\.\d{2}/],
        ['DD.MM.AAAA  (ponto, canônica)', /\d{2}\.\d{2}\.20\d{2}/],
        ['AAAA.MM-DD  (ponto + HÍFEN)',   /20\d{2}\.\d{2}-\d{2}/],
        ['AAAA-MM-DD  (só hífen)',        /20\d{2}-\d{2}-\d{2}/],
        ['AAAA-MM.DD  (hífen + ponto)',   /20\d{2}-\d{2}\.\d{2}/],
        ['DD-MM-AAAA  (só hífen)',        /\d{2}-\d{2}-20\d{2}/],
    ];
    console.log('── formas de data encontradas nos nomes ─────────────────────');
    for (const [rot, re] of FORMAS) {
        const n = todos.filter(t => re.test(t.nome)).length;
        console.log(`  ${rot.padEnd(32)} ${String(n).padStart(5)}  ${pct(n, todos.length)}`);
    }

    // ── 2) emitentes com lixo na frente, hoje ──────────────────────────────
    const comLixo = [];
    for (const t of todos) {
        const e = p.extrairEmitente(t.nome);
        if (e && LIXO_NA_FRENTE.test(e)) comLixo.push({ ...t, emitente: e });
    }
    console.log(`\n── emitentes extraídos com RESTO DE DATA na frente ──────────`);
    console.log(`  ${comLixo.length} de ${todos.length}  (${pct(comLixo.length, todos.length)})\n`);
    for (const x of comLixo.slice(0, 25))
        console.log(`  "${x.emitente.slice(0, 40)}"\n     ← ${x.nome.slice(0, 62)}`);
    if (comLixo.length > 25) console.log(`  ... e mais ${comLixo.length - 25}`);

    // ── 3) o conserto: aceitar . - / como separador ────────────────────────
    // Reproduz `extrairEmitente` com a regex de data ampliada, e compara.
    const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const TIPO_DOC_RE = /\b(RCB|RC|RECIBO|FAT|FT|FATURA|NFS|NFE|NF|BOL|BOLETO|GUIA|DARF|GPS|INSS|FGTS|CTE|DACTE|IMOVEL|OCP|OC)\b/;
    const limpaBordas = s => s.replace(/^[\s.,\-]+|[\s.,\-]+$/g, '').trim();
    // SÓ muda aqui: [.\-\/] no lugar do ponto literal
    const DATA_NOVA = /(?:20\d{2}[.\-\/]\d{2}[.\-\/]\d{2}|\d{2}[.\-\/]\d{2}[.\-\/]20\d{2}|\b20\d{2})[.\-]?/;
    function extrairEmitenteNovo(filename = '') {
        const t = norm(String(filename).replace(/\.pdf$/i, ''));
        let resto = t;
        const data = t.match(DATA_NOVA);
        if (data) resto = t.slice(data.index + data[0].length);
        else {
            const pref = t.match(/^\d{1,4}\.?DOC[-\s]*[\d.,]*\s*-?\s*/);
            if (pref) resto = t.slice(pref[0].length);
        }
        const tipo = resto.match(TIPO_DOC_RE);
        let nome = limpaBordas(tipo ? resto.slice(0, tipo.index) : resto);
        if (nome.length < 2) nome = limpaBordas(resto);
        nome = limpaBordas(nome.replace(/\s+[A-Z]?\d[\w]*(\s+[A-Z]?\d[\w]*)*$/, ''));
        if (nome.length < 2 || /^[\d.,\s]+$/.test(nome)) return '';
        return nome;
    }

    let corrigidos = 0, mudouCerto = 0, igual = 0;
    const exCorrigido = [], exMudouCerto = [];
    for (const t of todos) {
        const antes = p.extrairEmitente(t.nome);
        const depois = extrairEmitenteNovo(t.nome);
        if (antes === depois) { igual++; continue; }
        if (antes && LIXO_NA_FRENTE.test(antes)) {
            corrigidos++;
            if (exCorrigido.length < 12) exCorrigido.push({ antes, depois, nome: t.nome });
        } else {
            mudouCerto++;
            if (exMudouCerto.length < 12) exMudouCerto.push({ antes, depois, nome: t.nome });
        }
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log('O CONSERTO: aceitar . - / como separador da data');
    console.log('═'.repeat(70));
    console.log(`\n  inalterados:                 ${String(igual).padStart(5)}`);
    console.log(`  CORRIGIDOS (tinham lixo):    ${String(corrigidos).padStart(5)}`);
    console.log(`  mudaram SEM ter lixo (risco):${String(mudouCerto).padStart(5)}`);

    console.log('\n── os corrigidos ────────────────────────────────────────────');
    for (const e of exCorrigido)
        console.log(`  "${e.antes.slice(0, 34)}" → "${e.depois.slice(0, 34)}"`);

    console.log('\n── os que mudaram SEM ter lixo (conferir um a um) ───────────');
    if (!exMudouCerto.length) console.log('  (nenhum)');
    for (const e of exMudouCerto) {
        console.log(`\n  "${e.antes}" → "${e.depois}"`);
        console.log(`     ${e.nome.slice(0, 64)}`);
    }

    console.log(`\n  ganho líquido = ${corrigidos} corrigidos − ${mudouCerto} em risco`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
