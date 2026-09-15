/**
 * ⛔ REPROVADO — NÃO RODAR COM --gravar. Mantido como registro do que foi medido.
 *
 * A ideia era consertar o `Emitente` em massa pelo nome do arquivo. Medido em
 * 09/09/2026 (`_medir/_emitente-qualidade.js`) sobre as 1.752 linhas afetadas:
 * só 19% dos nomes extraídos são utilizáveis; 72% são LIXO — "R$ 13.721,99- CDC
 * VEICULOS P.JURIDICA - PRE", "GRUPO 1153 COTA", "03;20.PRIMO ROSSI". Trocar
 * "LARSIL" (errado, mas reconhecível) por isso PIORA o pareamento.
 *
 * `extrairEmitente` foi escrita para nomes no padrão "NNN.DOC- valor - data. NOME. NF…"
 * e só acerta quando o arquivo o segue. No pipeline isso é aceitável (o campo tem
 * outras fontes e os tokens se somam); numa reescrita cega do acervo, não é.
 *
 * O conserto de verdade é reprocessar com o fix de `analyzeViaAI` (que passou a dar
 * precedência ao nome do arquivo, como `analyzePdf` já fazia) — aí o nome ruim é
 * descartado pelo próprio pipeline em vez de gravado por cima.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * _medir/corrigir-emitente-larsil.js — conserta no BANCO os documentos que ficaram com
 * "LARSIL …" no campo `Emitente` (o nome do PAGADOR gravado como se fosse o do
 * fornecedor), sem reprocessar PDF nenhum.
 *
 * Dá para fazer sem reler o PDF porque a informação certa já está no NOME DO ARQUIVO,
 * e `extrairEmitente` — a mesma função que o pipeline usa — a extrai deterministicamente:
 * "070.DOC- 72,57 - 2026.03.10. DALIANI CRISTINI. NFS 886 + AUT.pdf" → "DALIANI CRISTINI".
 *
 * A causa foi corrigida em `analyzeViaAI` (process-folder.js): o caminho da IA gravava
 * o nome lido do PDF sem consultar o do arquivo, ao contrário de `analyzePdf`. Isto aqui
 * limpa o que já está gravado; ver memória [[emitente-nao-vem-do-extrator]].
 *
 * Segurança: só troca quando `extrairEmitente` devolve um nome que NÃO é a LARSIL —
 * se o nome do arquivo também disser LARSIL (documento nosso mesmo), nada muda. O nome
 * antigo é preservado em `Razão social (nota)`, como faz o pipeline.
 *
 * SEM `--gravar` não toca o banco. Uso: node _medir/corrigir-emitente-larsil.js [periodo] [--gravar]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');
const { extrairEmitente, norm } = require('../routes/_nf-parsers');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

function parseCsv(txt) {
    txt = String(txt || '').replace(/^﻿/, '');
    const linhas = [];
    let campo = '', linha = [], dentro = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (dentro) {
            if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else dentro = false; }
            else campo += c;
        } else if (c === '"') dentro = true;
        else if (c === ';') { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}
function csvEscape(val) {
    const s = String(val ?? '');
    return (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = rows => '﻿' + rows.map(r => r.map(csvEscape).join(';')).join('\r\n');

const ehLarsil = s => /\bLARSIL\b/i.test(String(s ?? ''));

(async () => {
    const args = process.argv.slice(2);
    const gravar = args.includes('--gravar');
    const periodoArg = args.find(a => !a.startsWith('--')) || null;

    const pool = await getConnection();
    const req = pool.request();
    let q = "SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'";
    if (periodoArg) { q += ' AND PERIODO=@p'; req.input('p', sql.VarChar(20), periodoArg); }
    const r = await req.query(q);

    console.log(`escopo: ${periodoArg || 'todos os meses'}`);
    console.log(`modo  : ${gravar ? '*** GRAVANDO NO BANCO ***' : 'simulação (use --gravar para valer)'}\n`);

    let comLarsil = 0, corrigidos = 0, semNomeUtil = 0, nomeTambemLarsil = 0;
    const exemplos = [], porPeriodo = [];

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        const corpo = rows.slice(1).filter(x => x[i('arquivo')]);
        let mudou = 0;

        for (const row of corpo) {
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || typeof d !== 'object') continue;
            if (!ehLarsil(d['Emitente'])) continue;
            comLarsil++;

            // o nome do arquivo sem o sufixo de parcela
            const base = String(row[i('arquivo')]).replace(/#p\d+$/i, '');
            const doNome = extrairEmitente(base);
            if (!doNome) { semNomeUtil++; continue; }
            if (ehLarsil(doNome)) { nomeTambemLarsil++; continue; }   // documento nosso: correto como está

            if (norm(d['Emitente']) !== norm(doNome) && !d['Razão social (nota)'])
                d['Razão social (nota)'] = d['Emitente'];
            d['Emitente'] = doNome;
            row[i('dados_parser')] = JSON.stringify(d);
            corrigidos++; mudou++;
            if (exemplos.length < 8)
                exemplos.push(`${rec.PERIODO} · ${String(row[i('arquivo')]).slice(0, 58)}\n        "${d['Razão social (nota)'] || '—'}" → "${doNome}"`);
        }

        if (!mudou) continue;
        porPeriodo.push({ periodo: rec.PERIODO, n: mudou });
        if (gravar) {
            const dir = path.join(__dirname, '_backup-emitente');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${rec.PERIODO}.csv`), rec.CONTEUDO, 'utf8');
            await pool.request()
                .input('p', sql.VarChar(20), rec.PERIODO)
                .input('c', sql.NVarChar(sql.MAX), toCsv([h, ...corpo]))
                .query("UPDATE nfs.RELATORIOS_CONFERENCIA SET CONTEUDO=@c, ATUALIZADO_EM=GETDATE() WHERE TIPO='M' AND PERIODO=@p");
        }
    }

    console.log(`linhas com "LARSIL" como Emitente   ${comLarsil}`);
    console.log(`  corrigidas pelo nome do arquivo   ${corrigidos}`);
    console.log(`  nome do arquivo também é LARSIL   ${nomeTambemLarsil}   (documento nosso: correto)`);
    console.log(`  nome do arquivo não deu nome útil ${semNomeUtil}   (ficam como estão)`);

    if (porPeriodo.length) {
        console.log(`\npor período:`);
        for (const p of porPeriodo.sort((a, b) => b.n - a.n).slice(0, 12))
            console.log(`   ${String(p.n).padStart(5)}  ${p.periodo}`);
    }
    if (exemplos.length) {
        console.log(`\nexemplos da troca:`);
        for (const e of exemplos) console.log(`   · ${e}`);
    }
    console.log(gravar ? '\ngravado. backup em _medir/_backup-emitente/'
                       : '\nnada foi gravado. rode com --gravar para aplicar.');
})().catch(e => { console.error(e); process.exit(1); });
