/**
 * _medir/fundir-orfas.js — funde as linhas duplicadas por renomeação de pasta.
 *
 * O PROBLEMA (ver memória [[pasta-renomeada-duplica-linha]]): o upsert casa por
 * `arquivo|pasta`. Quando a pasta-raiz do acervo foi renomeada, a releitura gravou a
 * linha nova AO LADO da antiga. São 1.606 PDFs com duas linhas, e o pareamento pode
 * casar com qualquer uma delas.
 *
 * POR QUE FUNDIR E NÃO ESCOLHER — medido em 09/09/2026:
 *   · `_orfa-quem-acerta.js`: nenhum lado vence sempre. Julgadas pelo valor escrito
 *     no nome do arquivo, a NOVA acerta sozinha 214× e a VELHA 161×.
 *   · `_orfas.js`: 6.089 campos existem SÓ na velha (Itens, Linha digitável, CFOP,
 *     Chave de acesso). Apagá-la perde dado real.
 *   · Só 506 dos 1.606 grupos têm conflito de verdade.
 *
 * A REGRA DE DESEMPATE, por campo, cada uma medida contra um árbitro independente
 * das duas leituras (`_orfa-regra.js`):
 *   · CHAVE  → VELHA. 80 conflitos, a velha acerta o DV mod-11 em 80. A nova, 0.
 *   · CNPJ   → VELHA. 64 conflitos julgados pelo CNPJ embutido na chave: velha 55×7.
 *   · VALOR  → NOVA.  288 conflitos julgados pelo nome do arquivo: nova 208×33.
 *   · demais → NOVA, por ser a leitura mais recente; nenhum árbitro independente
 *              disponível, e o empate técnico do NÚMERO (14×10) não sustenta regra.
 *
 * Campos que só um lado tem entram sem disputa — é o grosso do ganho.
 *
 * SEM `--gravar` não toca o banco: imprime o que faria. Com `--gravar`, reescreve o
 * CONTEUDO dos relatórios afetados, depois de salvar um backup .csv por período em
 * _medir/_backup-orfas/.
 *
 * Uso: node _medir/fundir-orfas.js [periodo] [--gravar]
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

// ── CSV: mesmo dialeto de routes/relatorio.js (BOM + ';') ────────────────────
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

// ── validação da chave: idêntica à de routes/_nf-parsers.js ──────────────────
const UFS = new Set([11,12,13,14,15,16,17,21,22,23,24,25,26,27,28,29,31,32,33,35,41,42,43,50,51,52,53]);
const MODELOS = new Set(['55', '57', '65']);
function chaveValida(ch) {
    const d = String(ch ?? '').replace(/\D/g, '');
    if (d.length !== 44 || !UFS.has(Number(d.slice(0, 2))) || !MODELOS.has(d.slice(20, 22))) return false;
    let peso = 2, soma = 0;
    for (let i = 42; i >= 0; i--) { soma += Number(d[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto) === Number(d[43]);
}

const RE_PASTA_NOVA = /^\d{4}\.\d{2}\.[^/]*EXTRATOS/i;
const CNPJ_LARSIL = '8420245000180';
const digitos = s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
const vazio = v => v == null || String(v).trim() === '' || String(v).trim() === '—';

// Campos em que a linha VELHA vence o conflito (ver cabeçalho).
const VENCE_VELHA = new Set(['Chave de acesso', 'CNPJ emitente']);

/**
 * Funde os dados_parser das duas linhas. Onde só um tem o campo, ele entra.
 * Onde os dois têm e divergem, decide a regra medida.
 */
function fundirParser(dNova, dVelha, log) {
    const out = { ...dNova };
    for (const k of Object.keys(dVelha)) {
        const temV = !vazio(dVelha[k]), temN = !vazio(out[k]);
        if (!temV) continue;
        if (!temN) { out[k] = dVelha[k]; log.ganhos++; continue; }
        if (String(out[k]) === String(dVelha[k])) continue;

        log.conflitos++;
        if (k === 'Chave de acesso') {
            // Caso mais forte: o DV decide sozinho, sem precisar de regra por lado.
            const okN = chaveValida(out[k]), okV = chaveValida(dVelha[k]);
            if (okV && !okN) { out[k] = dVelha[k]; log.velhaVence++; }
            else if (okN && !okV) log.novaVence++;
            else if (!okN && !okV) { delete out[k]; log.ambasLixo++; }  // nenhuma presta
            else log.novaVence++;
            continue;
        }
        if (k === 'CNPJ emitente') {
            // O CNPJ da própria LARSIL é o pagador, nunca o emitente. Se um dos lados
            // o traz e o outro não, o outro vence — independentemente de ser novo ou velho.
            const lN = digitos(out[k]) === CNPJ_LARSIL, lV = digitos(dVelha[k]) === CNPJ_LARSIL;
            if (lN && !lV) { out[k] = dVelha[k]; log.velhaVence++; }
            else if (lV && !lN) log.novaVence++;
            else { out[k] = dVelha[k]; log.velhaVence++; }   // regra medida: velha 55×7
            continue;
        }
        if (VENCE_VELHA.has(k)) { out[k] = dVelha[k]; log.velhaVence++; continue; }
        log.novaVence++;   // demais campos: a leitura mais recente
    }
    return out;
}

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

    const log = { ganhos: 0, conflitos: 0, novaVence: 0, velhaVence: 0, ambasLixo: 0 };
    let gruposFundidos = 0, linhasRemovidas = 0;
    const porPeriodo = [];

    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        const corpo = rows.slice(1).filter(x => x[i('arquivo')]);

        // agrupa por nome de arquivo; só interessa quem tem 2+ pastas distintas
        const porArquivo = new Map();
        for (const row of corpo) {
            const a = row[i('arquivo')];
            if (!porArquivo.has(a)) porArquivo.set(a, []);
            porArquivo.get(a).push(row);
        }

        const descartar = new Set();   // referências de linha a remover
        let mudou = 0;
        for (const [, grupo] of porArquivo) {
            if (grupo.length < 2) continue;
            if (new Set(grupo.map(g => g[i('pasta')])).size < 2) continue;
            const novas  = grupo.filter(g => RE_PASTA_NOVA.test(g[i('pasta')]));
            const velhas = grupo.filter(g => !RE_PASTA_NOVA.test(g[i('pasta')]));
            if (!novas.length || !velhas.length) continue;

            const pj = row => { try { return JSON.parse(row[i('dados_parser')] || '{}') || {}; } catch (_) { return {}; } };
            const alvo = novas[0];   // a linha que fica: pasta atual, caminho real no disco
            const fundido = fundirParser(pj(alvo), pj(velhas[0]), log);
            alvo[i('dados_parser')] = JSON.stringify(fundido);

            // o CNPJ da coluna acompanha o do parser, senão a coluna e o JSON divergem
            if (!vazio(fundido['CNPJ emitente'])) alvo[i('cnpj')] = fundido['CNPJ emitente'];

            for (const v of velhas) descartar.add(v);
            gruposFundidos++; mudou++;
            linhasRemovidas += velhas.length;
        }

        if (!mudou) continue;
        const novoCorpo = corpo.filter(x => !descartar.has(x));
        porPeriodo.push({ periodo: rec.PERIODO, antes: corpo.length, depois: novoCorpo.length, grupos: mudou });

        if (gravar) {
            const dir = path.join(__dirname, '_backup-orfas');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${rec.PERIODO}.csv`), rec.CONTEUDO, 'utf8');
            const csv = toCsv([h, ...novoCorpo]);
            await pool.request()
                .input('p', sql.VarChar(20), rec.PERIODO)
                .input('c', sql.NVarChar(sql.MAX), csv)
                .input('t', sql.Int, novoCorpo.length)
                .query("UPDATE nfs.RELATORIOS_CONFERENCIA SET CONTEUDO=@c, TOTAL_ARQUIVOS=@t, ATUALIZADO_EM=GETDATE() WHERE TIPO='M' AND PERIODO=@p");
        }
    }

    console.log(`grupos fundidos            ${gruposFundidos}`);
    console.log(`linhas removidas           ${linhasRemovidas}`);
    console.log(`\ncampos recuperados da velha ${log.ganhos}   ← o que apagar teria perdido`);
    console.log(`conflitos resolvidos        ${log.conflitos}`);
    console.log(`   pela linha NOVA          ${log.novaVence}`);
    console.log(`   pela linha VELHA         ${log.velhaVence}`);
    console.log(`   descartados (as 2 ruins) ${log.ambasLixo}`);

    if (porPeriodo.length) {
        console.log(`\npor período:`);
        for (const p of porPeriodo.sort((a, b) => b.grupos - a.grupos).slice(0, 15))
            console.log(`   ${p.periodo.padEnd(8)} ${String(p.antes).padStart(5)} → ${String(p.depois).padStart(5)} linhas  (${p.grupos} grupos)`);
    }
    console.log(gravar ? '\ngravado. backup dos CSVs originais em _medir/_backup-orfas/'
                       : '\nnada foi gravado. rode com --gravar para aplicar.');
})().catch(e => { console.error(e); process.exit(1); });
