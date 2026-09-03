/**
 * _medir/harness.js — carrega as fontes reais (pasta + planilha) uma vez só e
 * deixa em cache no disco, para as medições seguintes serem instantâneas.
 *
 * Fica dentro do projeto (e não no scratchpad) porque `require` resolve a partir
 * da pasta do script: do scratchpad, `require('xlsx')` falha mesmo com chdir.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

// ── .env sem dotenv (não está instalado) ─────────────────────────────────────
function carregarEnv() {
    const txt = fs.readFileSync(path.join(RAIZ, '.env'), 'utf8');
    for (const linha of txt.split(/\r?\n/)) {
        const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
            v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
}
carregarEnv();

// ── Internas de comparar-notas.js, sem duplicar as ~23 regex ─────────────────
// A rota não exporta nada além do handler. Fatiamos o fonte até o `module.exports`
// e avaliamos o corpo, devolvendo as funções internas que a medição precisa.
function internasDaRota() {
    const src = fs.readFileSync(path.join(RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
    const corte = src.indexOf('module.exports = async function compararNotasRoute');
    if (corte < 0) throw new Error('não achei o module.exports da rota — fonte mudou?');
    const corpo = src.slice(0, corte);
    const requireRotas = require('module').createRequire(path.join(RAIZ, 'routes', 'x.js'));
    const f = new Function('require', 'module', 'exports', '__dirname', `
        ${corpo}
        return { contarNaPasta, contarNaPlanilha, contarNoCsv, camposOcr,
                 categoriaNaoFiscal, ehDoc, mesDoNome, mesDaPasta, mesDoDocumento,
                 ORIG_ESCOPO, FILIAL_ESCOPO, CONTAS_SEM_DOCUMENTO };
    `);
    return f(requireRotas, { exports: {} }, {}, path.join(RAIZ, 'routes'));
}

const CACHE = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

// ── Pasta (varredura do arquivo permanente) ──────────────────────────────────
function carregarPasta(rota) {
    const f = path.join(CACHE, 'pasta.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    const raiz = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
    console.error(`[harness] varrendo ${raiz} ...`);
    const t0 = Date.now();
    const r = rota.contarNaPasta(raiz);
    console.error(`[harness] pasta varrida em ${Date.now() - t0} ms (${r.docs} docs)`);
    const out = { porMes: r.porMes, arquivosPorMes: r.arquivosPorMes };
    fs.writeFileSync(f, JSON.stringify(out));
    return out;
}

// ── Planilha ─────────────────────────────────────────────────────────────────
function carregarPlanilha(rota) {
    const f = path.join(CACHE, 'planilha.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    console.error(`[harness] lendo ${process.env.PLANILHA_PATH} ...`);
    const t0 = Date.now();
    const porMes = rota.contarNaPlanilha(process.env.PLANILHA_PATH);
    console.error(`[harness] planilha lida em ${Date.now() - t0} ms`);
    // Só o que a medição usa: os itens por mês (o resto é contagem para card).
    const out = {};
    for (const [mes, m] of Object.entries(porMes))
        out[mes] = { lancamentos: m.lancamentos, itens: m.itens };
    fs.writeFileSync(f, JSON.stringify(out));
    return out;
}

let _cache = null;
function carregar() {
    if (_cache) return _cache;
    const rota = internasDaRota();
    _cache = { rota, pasta: carregarPasta(rota), planilha: carregarPlanilha(rota) };
    return _cache;
}

// Períodos de medição: jan–jun/2026, os mesmos de TIPOS-IGNORADOS §10.
const PERIODOS = ['01.2026', '02.2026', '03.2026', '04.2026', '05.2026', '06.2026'];

module.exports = { carregar, internasDaRota, PERIODOS, RAIZ, CACHE };
