/**
 * _medir/_fallback-parser-no-banco.js — o fallback do parser sujou o banco?
 *
 * ── A pergunta ───────────────────────────────────────────────────────────────
 * [[parser-nao-cobre-campos-do-pareamento]] mediu que o parser determinístico
 * acerta 4% do valor, 13% do número e 20% da data. Mas isso foi medido na PASTA,
 * rodando o parser ao vivo. A pergunta que ficou é outra: **quantas linhas do
 * BANCO foram gravadas por esse caminho fraco, e elas estão sem os campos?**
 *
 * Em `process-folder.js` a IA vem primeiro e o parser é reserva:
 *     const rowsIA = await analyzeViaAI(...); if (rowsIA) return rowsIA;
 *     console.warn('IA sem resultado — usando parser local');
 * A coluna `origem` do CSV registra qual caminho gravou a linha: 'IA' quando a IA
 * respondeu, senão a origem do `classify` ('conteúdo', 'nome do arquivo', 'OCR',
 * 'visão (IA)'...). É esse o carimbo que esta consulta cruza.
 *
 * ── Por que ir ao banco e não à pasta ────────────────────────────────────────
 * [[auditar-contra-pasta-real]] registra o inverso (ir ao disco achou o que a
 * medição agregada não via), e aqui vale o mesmo raciocínio na outra direção: o
 * banco é o que a TELA mostra. Uma linha gravada sem valor há semanas continua sem
 * valor hoje, mesmo que o parser tenha melhorado — releitura não é automática
 * ([[cache-esconde-mudanca-de-extracao]]).
 *
 * ── O que se conta ───────────────────────────────────────────────────────────
 * Por origem: quantas linhas, e em quantas os 4 campos do pareamento estão VAZIOS.
 * Além disso, a taxa de "documento sem NENHUM dos 4" — a linha que existe no banco
 * mas não pode casar com lançamento nenhum, que é o dano concreto.
 *
 * SOMENTE LEITURA: nenhuma escrita, nenhum UPDATE. Consulta e agrega.
 *
 * Uso: node _medir/_fallback-parser-no-banco.js [periodo...]
 *      (sem argumento: jan–jun/2026, os períodos padrão do harness)
 */
'use strict';
const h = require('./harness');
const { getConnection, sql } = require('../config');

const PERIODOS = process.argv.slice(2).length ? process.argv.slice(2) : h.PERIODOS;

// O separador é PONTO E VÍRGULA, não vírgula — conferido em `process-folder.js:77`
// (`COLS.map(...).join(';')`), e `csvEscape` só põe aspas quando o campo contém
// `;`, `"` ou quebra de linha. Minha 1ª versão usava vírgula e teria lido a linha
// inteira como uma coluna só, devolvendo "cabeçalho inesperado" para tudo — ou,
// pior, zeros que pareceriam resultado ([[chave-do-parser-e-em-portugues]]).
//
// `dados_parser` é JSON com vírgulas E aspas internas, logo vem sempre citado:
// o tratamento de `""` escapado é obrigatório aqui.
const SEP = ';';
function parseCsv(txt) {
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === SEP) { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

const VAZIO = v => v == null || String(v).trim() === '' || String(v).trim() === '—'
                || String(v).trim() === 'null' || String(v).trim() === '0';

// Os 4 campos do pareamento, nos rótulos do `dados_parser` (português, por tipo —
// ver [[chave-do-parser-e-em-portugues]]). Um documento preenche só o rótulo do
// seu tipo, por isso a lista.
const ROTULOS = {
    valor:  ['Valor total da nota', 'Valor total', 'Valor do serviço', 'Valor principal',
             'Valor da prestação', 'Valor líquido'],
    numero: ['Nº da NFS-e', 'Nº da NF-e', 'Nº do CT-e', 'Número do documento'],
    data:   ['Data de emissão'],
    emitente: ['Emitente', 'Razão social (nota)', 'Nome social'],
};
const CAMPOS = Object.keys(ROTULOS);

function temCampo(pd, campo) {
    if (!pd) return false;
    return ROTULOS[campo].some(k => !VAZIO(pd[k]));
}

(async () => {
    const pool = await getConnection();
    console.log(`períodos: ${PERIODOS.join(', ')}\n`);

    // acc[origem] = { n, semCampo:{...}, semNenhum, tipos:Set }
    const acc = {};
    let totalLinhas = 0, semParser = 0;
    const exemplos = [];

    for (const periodo of PERIODOS) {
        // Relatório MENSAL ('M'); é o que a tela de conferência usa.
        const r = await pool.request()
            .input('tipo', sql.Char(1), 'M')
            .input('periodo', sql.VarChar(20), periodo)
            .query('SELECT CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO=@tipo AND PERIODO=@periodo');
        if (!r.recordset.length) { console.log(`  ${periodo}: (sem relatório)`); continue; }

        // `rowsToCsv` prefixa BOM ('﻿') na linha de cabeçalho; sem removê-lo,
        // a 1ª coluna vira "﻿arquivo" e todo indexOf falha.
        const linhas = parseCsv(String(r.recordset[0].CONTEUDO || '').replace(/^﻿/, ''));
        if (!linhas.length) continue;
        const head = linhas[0].map(s => String(s).replace(/^﻿/, '').trim());
        const iOrigem  = head.indexOf('origem');
        const iDados   = head.indexOf('dados_parser');
        const iArquivo = head.indexOf('arquivo');
        const iTipo    = head.indexOf('tipo');
        if (iOrigem < 0 || iDados < 0) {
            console.log(`  ${periodo}: cabeçalho inesperado (${head.join('|')}) — pulando`);
            continue;
        }

        let n = 0;
        for (const l of linhas.slice(1)) {
            if (!l[iArquivo]) continue;
            n++; totalLinhas++;
            const origem = String(l[iOrigem] || '(vazio)').trim() || '(vazio)';
            let pd = null;
            try { pd = JSON.parse(l[iDados] || 'null'); } catch (_) { pd = null; }
            if (!pd) semParser++;

            const a = acc[origem] || (acc[origem] = { n: 0, sem: {}, semNenhum: 0, tipos: {} });
            a.n++;
            a.tipos[String(l[iTipo] || '?')] = (a.tipos[String(l[iTipo] || '?')] || 0) + 1;
            let tem = 0;
            for (const c of CAMPOS) {
                if (temCampo(pd, c)) tem++;
                else a.sem[c] = (a.sem[c] || 0) + 1;
            }
            if (tem === 0) {
                a.semNenhum++;
                if (exemplos.length < 25) exemplos.push({ periodo, origem, arquivo: l[iArquivo], tipo: l[iTipo] });
            }
        }
        console.log(`  ${periodo}: ${n} linhas`);
    }

    console.log(`\ntotal: ${totalLinhas} linhas   sem dados_parser legível: ${semParser}\n`);

    // ── por origem ──────────────────────────────────────────────────────────
    const ordenadas = Object.entries(acc).sort((a, b) => b[1].n - a[1].n);
    console.log('POR ORIGEM (quantas linhas, e em quantas o campo está VAZIO)');
    console.log('origem                 linhas   s/valor  s/número  s/data  s/emit   SEM NENHUM');
    for (const [org, a] of ordenadas) {
        const pct = n => a.n ? (n / a.n * 100).toFixed(0) + '%' : '—';
        console.log(org.slice(0, 20).padEnd(22) +
            String(a.n).padStart(6) +
            `${String(a.sem.valor || 0).padStart(6)} ${pct(a.sem.valor || 0).padStart(4)}` +
            `${String(a.sem.numero || 0).padStart(6)} ${pct(a.sem.numero || 0).padStart(4)}` +
            `${String(a.sem.data || 0).padStart(5)} ${pct(a.sem.data || 0).padStart(4)}` +
            `${String(a.sem.emitente || 0).padStart(5)} ${pct(a.sem.emitente || 0).padStart(4)}` +
            `${String(a.semNenhum).padStart(8)} ${pct(a.semNenhum).padStart(5)}`);
    }

    // ── o recorte que responde a pergunta ───────────────────────────────────
    // 'IA' contra tudo o que NÃO é IA: é a comparação que mede o fallback.
    const ehIA = org => /\bIA\b/i.test(org);
    const soma = (filtro, chave) => ordenadas.filter(([o]) => filtro(o))
        .reduce((s, [, a]) => s + (chave === 'n' ? a.n : chave === 'semNenhum' ? a.semNenhum : (a.sem[chave] || 0)), 0);

    const nIA = soma(ehIA, 'n'), nLocal = soma(o => !ehIA(o), 'n');
    console.log('\n── IA × PARSER LOCAL ───────────────────────────────────────');
    for (const [rot, filtro, tot] of [['IA', ehIA, nIA], ['parser local', o => !ehIA(o), nLocal]]) {
        if (!tot) { console.log(`${rot.padEnd(14)} (nenhuma linha)`); continue; }
        const p = n => (n / tot * 100).toFixed(0) + '%';
        console.log(`${rot.padEnd(14)} ${String(tot).padStart(5)} linhas   ` +
            CAMPOS.map(c => `s/${c[0]}=${p(soma(filtro, c))}`).join('  ') +
            `   SEM NENHUM=${p(soma(filtro, 'semNenhum'))}`);
    }

    if (exemplos.length) {
        console.log('\n── exemplos de linha SEM NENHUM dos 4 campos ───────────────');
        for (const e of exemplos)
            console.log(`  [${e.periodo}] origem=${String(e.origem).slice(0, 14).padEnd(15)} tipo=${String(e.tipo || '?').slice(0, 16).padEnd(17)} ${String(e.arquivo).slice(0, 46)}`);
    }

    console.log('\nSEM NENHUM é o dano concreto: a linha existe no banco e não pode');
    console.log('casar com lançamento algum — nem por valor, nem por número, nem por entidade.');
    process.exit(0);
})();
