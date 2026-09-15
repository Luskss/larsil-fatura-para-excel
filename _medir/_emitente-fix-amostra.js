/**
 * _medir/_emitente-fix-amostra.js — o fix em `analyzeViaAI` (o nome do ARQUIVO passa a
 * ter precedência sobre o que a IA leu do PDF) só surte efeito ao reprocessar. Antes de
 * gastar horas relendo o acervo, esta amostra responde: quantas das linhas com "LARSIL"
 * no `Emitente` o reprocesso realmente conserta?
 *
 * Roda o pipeline ATUAL (mesmo caminho do reprocesso) num punhado de PDFs que hoje estão
 * doentes, e compara o `Emitente` antes × depois. Sem gravar nada.
 *
 * Importante: mede também quantos ficam com nome RUIM (resíduo do nome do arquivo, como
 * "GRUPO 1153 COTA") — porque o fix dá precedência ao nome do arquivo, e já sabemos por
 * `_emitente-qualidade.js` que ele nem sempre presta. A pergunta é se o pipeline inteiro
 * (que tem outras fontes) sai melhor do que a troca cega que reprovei.
 *
 * Uso: node _medir/_emitente-fix-amostra.js [quantos]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { getConnection } = require('../config');

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

const ehLarsil = s => /\bLARSIL\b/i.test(String(s ?? ''));
function pareceLixo(s) {
    const t = String(s || '').trim();
    if (t.length < 3 || t.length > 40) return true;
    if (/R\$|\d+,\d{2}/.test(t)) return true;
    if (/\b\d{2}[./;-]\d{2}\b|\b20\d{2}\b/.test(t)) return true;
    if (/^GRUPO\b|\bCOTA\b/i.test(t)) return true;
    if (/\bCDC\b|\bFT\d|ANEXAR|EXTRATO/i.test(t)) return true;
    return false;
}

(async () => {
    const quantos = Number(process.argv[2] || 12);
    const raizArq = process.env.ARQUIVO_PATH;

    // acha, no banco, linhas doentes cujo PDF exista no disco
    const pool = await getConnection();
    const r = await pool.request().query("SELECT PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO='M'");
    const alvos = [];
    for (const rec of r.recordset) {
        const rows = parseCsv(rec.CONTEUDO);
        if (rows.length < 2) continue;
        const h = rows[0];
        const i = n => h.indexOf(n);
        for (const row of rows.slice(1)) {
            if (alvos.length >= quantos * 4) break;
            const arq = row[i('arquivo')];
            if (!arq || /#p\d+$/i.test(arq)) continue;      // parcela: o PDF-base é o mesmo
            let d = null;
            try { d = JSON.parse(row[i('dados_parser')] || '{}'); } catch (_) { continue; }
            if (!d || !ehLarsil(d['Emitente'])) continue;
            const pasta = String(row[i('pasta')] || '');
            const p = path.join(raizArq, pasta, arq);
            if (!fs.existsSync(p)) continue;
            alvos.push({ periodo: rec.PERIODO, arquivo: arq, pasta, caminho: p, antes: d['Emitente'] });
        }
    }
    if (!alvos.length) { console.log('nenhum PDF doente encontrado no disco'); return; }

    const amostra = alvos.slice(0, quantos);
    console.log(`amostra: ${amostra.length} PDFs hoje com "LARSIL" no Emitente\n`);

    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const corte = src.indexOf('async function processFolderAuto');
    const f = new Function('require', 'module', 'exports', '__dirname', `${src.slice(0, corte)} return { analyzePdf };`);
    const req = require('module').createRequire(path.join(RAIZ, 'routes', 'x.js'));
    const { analyzePdf } = f(req, { exports: {} }, {}, path.join(RAIZ, 'routes'));

    let consertados = 0, aindaLarsil = 0, virouLixo = 0, falhou = 0;
    for (const a of amostra) {
        let depois = '(erro)';
        try {
            const rows = await analyzePdf({ name: a.arquivo, path: a.caminho, folder: a.pasta }, { forceAI: true });
            const d = JSON.parse(rows[0].dados_parser || '{}');
            depois = d['Emitente'] || '(vazio)';
        } catch (e) { falhou++; console.log(`   ERRO ${a.arquivo.slice(0, 50)}: ${e.message}`); continue; }

        let veredito;
        if (ehLarsil(depois)) { aindaLarsil++; veredito = 'AINDA LARSIL'; }
        else if (pareceLixo(depois)) { virouLixo++; veredito = 'LIXO'; }
        else { consertados++; veredito = 'ok'; }
        console.log(`${veredito.padEnd(13)} ${a.arquivo.slice(0, 46)}`);
        console.log(`              "${a.antes}" → "${depois}"`);
    }

    const n = amostra.length - falhou;
    const pct = x => (n ? (100 * x / n).toFixed(0) + '%' : '—');
    console.log(`\nresultado em ${n} PDFs relidos:`);
    console.log(`  consertados (nome utilizável) ${consertados}  ${pct(consertados)}`);
    console.log(`  ainda com LARSIL              ${aindaLarsil}  ${pct(aindaLarsil)}`);
    console.log(`  virou lixo                    ${virouLixo}  ${pct(virouLixo)}`);
    if (falhou) console.log(`  falharam ao reler             ${falhou}`);
})().catch(e => { console.error(e); process.exit(1); });
