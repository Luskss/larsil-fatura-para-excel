/**
 * _medir/reprocessar-fiscal.js — regrava os relatórios com os campos fiscais
 * novos (nome, nome social, CNPJ, chave, CFOP, itens com unidade e valores).
 *
 * O cache de process-folder é por `arquivo|pasta` e reaproveita a row inteira, então
 * um scan normal NUNCA regravaria: o PDF no disco não mudou, só a lógica de extração.
 * Daí `forceLocal`, que ignora o cache e relê com os parsers locais — sem IA, sem
 * custo por documento.
 *
 * Rows de origem "IA" TAMBÉM são relidas. A primeira versão as preservava "para não
 * perder informação", e o resultado medido foi que só 33 de 7.160 linhas ganhavam os
 * campos novos — as já lidas por IA nunca entravam na fila. Ver o comentário de
 * `precisaReler` em process-folder.js: a informação da IA não se perde, `analyzePdf`
 * a relê do mesmo PDF.
 *
 *   node _medir/reprocessar-fiscal.js --dry     → só relata, não grava (padrão)
 *   node _medir/reprocessar-fiscal.js --gravar  → grava no banco
 */
'use strict';
const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..');

for (const linha of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const gravar = process.argv.includes('--gravar');
const comIA  = process.argv.includes('--ia');

// --pasta <caminho>  processa outra árvore que não o MONITOR_PATH.
// Existe porque o acervo real está em ARQUIVO_PATH (\\larsil-dell\LA26.EXT.BANC,
// ~15.761 PDFs em 10 pastas mensais), enquanto o MONITOR_PATH aponta só para o
// SANTANDER da 2ª Etapa (563 PDFs). Rodar um mês por vez é a forma de conferir o
// que foi gravado antes de tocar o acervo inteiro.
const iPasta = process.argv.indexOf('--pasta');
const pastaArg = iPasta >= 0 ? process.argv[iPasta + 1] : null;

(async () => {
    const alvo = pastaArg || process.env.MONITOR_PATH || process.env.ARQUIVO_PATH;
    if (!alvo) { console.error('MONITOR_PATH não configurado no .env'); process.exit(1); }

    console.log(`pasta: ${alvo}`);
    console.log(`modo : ${gravar ? '*** GRAVANDO NO BANCO ***' : 'simulação (use --gravar para valer)'}\n`);

    if (!gravar) {
        // Sem gravar, mede o que a regravação PRODUZIRIA, lendo os PDFs e
        // comparando os campos contra o que está hoje no banco.
        const { getConnection } = require('../config');
        const { csvToRows } = requireInternas();
        const pool = await getConnection();
        const res = await pool.request().query(
            "SELECT TIPO, PERIODO, CONTEUDO FROM nfs.RELATORIOS_CONFERENCIA WHERE TIPO = 'M'");
        let linhas = 0, comParser = 0, comChave = 0, comItens = 0, comCfop = 0, comTotal = 0;
        for (const rec of res.recordset) {
            for (const row of csvToRows(rec.CONTEUDO)) {
                linhas++;
                let d = null;
                try { d = JSON.parse(row.dados_parser); } catch (_) {}
                if (!d || typeof d !== 'object') continue;
                comParser++;
                if (d['Chave de acesso'] && d['Chave de acesso'] !== '—') comChave++;
                if (d['Itens']) comItens++;
                if (d['CFOP']) comCfop++;
                if (d['Valor total da nota'] && d['Valor total da nota'] !== '—') comTotal++;
            }
        }
        const pct = n => (linhas ? (100 * n / linhas).toFixed(1) + '%' : '—');
        console.log('── estado ATUAL no banco (relatórios mensais) ──');
        console.log(`  linhas totais        ${linhas}`);
        console.log(`  com dados_parser     ${comParser}  ${pct(comParser)}`);
        console.log(`  com chave de acesso  ${comChave}  ${pct(comChave)}`);
        console.log(`  com CFOP             ${comCfop}  ${pct(comCfop)}   ← campo novo`);
        console.log(`  com Itens            ${comItens}  ${pct(comItens)}   ← campo novo`);
        console.log(`  com valor total      ${comTotal}  ${pct(comTotal)}`);
        console.log('\nrode com --gravar para reprocessar e preencher os campos novos.');
        process.exit(0);
    }

    const { processFolderAuto } = require('../routes/process-folder');
    const t0 = Date.now();
    let ultimo = 0;
    // forceLocal relê tudo ignorando o cache (é a lógica de extração que mudou, não
    // os PDFs). Com --ia, a IA também roda: em `analyzeViaAI` o extrator local vem
    // primeiro e a IA só preenche o que ficou vazio — ela pega os itens em layouts
    // de linha quebrada, onde a regex falha.
    const opts = comIA ? { forceLocal: true, forceAI: true } : { forceLocal: true };
    console.log(`opções: ${JSON.stringify(opts)}\n`);
    const r = await processFolderAuto(alvo, (p) => {
        // um log a cada 5% para não inundar o terminal
        if (p.percent >= ultimo + 5) { ultimo = p.percent; console.log(`  ${p.percent}%  (${p.current}/${p.total})  ${p.filename.slice(0, 60)}`); }
    }, null, null, opts);

    console.log(`\nconcluído em ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
})().catch(e => { console.error('erro:', e); process.exit(1); });

// csvToRows não é exportado pela rota; fatiamos o fonte como o harness já faz.
function requireInternas() {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
    const corte = src.indexOf('async function processFolderAuto');
    const f = new Function('require', 'module', 'exports', '__dirname', `
        ${src.slice(0, corte)}
        return { csvToRows };
    `);
    const req = require('module').createRequire(path.join(RAIZ, 'routes', 'x.js'));
    return f(req, { exports: {} }, {}, path.join(RAIZ, 'routes'));
}
