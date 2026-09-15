/**
 * _medir/_imagens-sem-ocr.js — os PDFs que ficaram como "Imagem" (sem OCR).
 *
 * A pergunta: vale reenviá-los para a IA? Antes de montar o passe, é preciso
 * saber POR QUE ficaram assim. Duas causas com consequências opostas:
 *   (a) o serviço de OCR estava fora do ar → texto vazio → reenviar RESOLVE;
 *   (b) o OCR rodou e o documento é ilegível/em branco → reenviar não muda nada.
 *
 * O que o script mostra: quantos são, se já tinham dado (emitente/CNPJ/valor)
 * apesar de imagem, e a lista dos arquivos para conferência no disco.
 *
 * Uso: node _medir/_imagens-sem-ocr.js [periodo] [quantosExemplos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection, sql } = require('../config');

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

(async () => {
    const periodoArg = process.argv[2] || null;
    const quantos = Number(process.argv[3] || 25);
    const pool = await getConnection();

    const q = periodoArg
        ? await pool.request().input('p', sql.VarChar(20), periodoArg)
            .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M' AND PERIODO=@p")
        : await pool.request()
            .query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");

    const casos = [];
    let totalLinhas = 0;
    for (const row of q.recordset) {
        const rows = parseCsv(row.CONTEUDO);
        if (!rows.length) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        for (const r of rows.slice(1)) {
            if (!r[i('arquivo')]) continue;
            totalLinhas++;
            const conteudo = r[i('conteudo')] || '';
            const ocr = String(r[i('ocr_usado')]).toLowerCase() === 'true';
            if (conteudo !== 'Imagem' || ocr) continue;   // só imagem QUE NÃO passou por OCR
            let dp = {};
            try { dp = JSON.parse(r[i('dados_parser')] || '{}'); } catch (_) {}
            casos.push({
                periodo: row.PERIODO,
                arquivo: r[i('arquivo')],
                pasta: r[i('pasta')] || '',
                tipo: r[i('tipo')] || '',
                origem: r[i('origem')] || '',
                emitente: dp['Emitente'] || '',
                cnpj: dp['CNPJ emitente'] || '',
                valor: dp['Valor total da nota'] || dp['Valor'] || '',
                campos: Object.keys(dp).length,
            });
        }
    }

    console.log(`\n${'='.repeat(66)}`);
    console.log(`PDFs "Imagem" SEM OCR${periodoArg ? ' — ' + periodoArg : ''}`);
    console.log('='.repeat(66));
    console.log(`\n${casos.length} linhas de ${totalLinhas} (${(casos.length * 100 / Math.max(1, totalLinhas)).toFixed(1)}%)`);

    const arquivos = new Set(casos.map(c => c.arquivo.replace(/#p\d+$/i, '')));
    console.log(`${arquivos.size} PDFs distintos\n`);

    const porTipo = new Map(), porOrigem = new Map();
    let semNada = 0, comAlgo = 0;
    for (const c of casos) {
        porTipo.set(c.tipo, (porTipo.get(c.tipo) || 0) + 1);
        porOrigem.set(c.origem, (porOrigem.get(c.origem) || 0) + 1);
        if (c.campos === 0 && !c.emitente) semNada++; else comAlgo++;
    }
    console.log('── por tipo reconhecido ──');
    for (const [k, n] of [...porTipo].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}×  ${k || '(vazio)'}`);
    console.log('\n── por origem do dado ──');
    for (const [k, n] of [...porOrigem].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}×  ${k || '(vazio)'}`);
    console.log(`\n  com algum dado extraído: ${comAlgo}`);
    console.log(`  sem dado nenhum        : ${semNada}   <- estes é que o reenvio pode salvar`);

    console.log(`\n── exemplos (até ${quantos}) ──`);
    for (const c of casos.slice(0, quantos)) {
        console.log(`\n  ${c.arquivo.slice(0, 72)}`);
        console.log(`     ${c.periodo} · tipo=${c.tipo || '—'} · origem=${c.origem || '—'} · ${c.campos} campos`);
        if (c.emitente) console.log(`     emitente: ${c.emitente.slice(0, 50)}  CNPJ ${c.cnpj}`);
    }

    // Lista para o passe: um arquivo por linha, consumível pelo script de reenvio.
    const destino = path.join(RAIZ, 'scratchpad-imagens.txt');
    fs.writeFileSync(destino, [...arquivos].join('\n'), 'utf8');
    console.log(`\n\nlista salva em ${destino}`);
})().catch(e => { console.error(e); process.exit(1); });
