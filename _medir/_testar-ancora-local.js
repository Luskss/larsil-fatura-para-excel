/**
 * _medir/_testar-ancora-local.js — A/B da âncora no caminho local, RELENDO os PDFs
 * com o código de HOJE.
 *
 * Por que não serve medir sobre o banco: `decidirValorPago` entrou no caminho local
 * no commit be8c511 (15/09/2026). As linhas gravadas antes disso descrevem um parser
 * que não existe mais — medir sobre elas responde sobre o passado
 * ([[releitura-congela-versao-do-parser]], [[cache-esconde-mudanca-de-extracao]]).
 *
 * Aqui cada PDF é RELIDO com `analyzePdf` (parsers locais, sem IA: `forceAI` fica
 * desligado, então nenhum token é gasto) em duas configurações:
 *
 *   COM   = como está hoje em produção (âncora ligada)
 *   SEM   = `numeroDoNome: null` no caminho local (âncora desligada)
 *
 * A troca é feita por variável de ambiente lida pelo próprio process-folder
 * (`ANCORA_LOCAL=0`), não por reimplementação da regra — senão mediria a minha
 * cópia, não o código.
 *
 * Régua: valor lido × valor do NOME do arquivo, pareado ganho/perda, e só entre os
 * documentos em que as duas configurações DIFEREM. Retenção conferida na aritmética
 * da linha fica fora ([[retencao-na-fonte-nao-e-divergencia]]).
 *
 * Uso:
 *   node _medir/_testar-ancora-local.js 04.2026 [--limite N] [--csv saida.csv]
 *   node _medir/_testar-ancora-local.js --todos
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

for (const l of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
}

// A visão custa API e é irrelevante para este A/B (o que muda é a escolha entre
// campos já lidos). Desligar mantém a medição gratuita e determinística.
process.env.VISAO_PDF = '0';
process.env.TRANSCRICAO_PDF = '0';

const { paraNumero } = require('../routes/_valor-do-pagamento');

const args = process.argv.slice(2);
const TODOS = args.includes('--todos');
const iLim = args.indexOf('--limite');
const LIMITE = iLim >= 0 ? parseInt(args[iLim + 1], 10) : Infinity;
const iCsv = args.indexOf('--csv');
const CSV = iCsv >= 0 ? args[iCsv + 1] : null;
const ALVO = args.find(a => /^\d{2}\.\d{4}$/.test(a));
if (!TODOS && !ALVO) { console.error('informe MM.AAAA ou --todos'); process.exit(1); }

const RAIZ_ARQ = process.env.ARQUIVO_PATH || process.env.MONITOR_PATH;
const BRL = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const bate = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.02;

const CHAVES_RET = ['Total das retenções', 'Total tributos federais', 'ISSRF', 'ISS retido',
                    'IRRF', 'PIS', 'COFINS', 'CSLL', 'INSS'];
function ehRetencao(pd, vLido, vNome) {
    if (!(vLido > vNome)) return false;
    const dif = vLido - vNome;
    let soma = 0;
    for (const k of CHAVES_RET) { const v = paraNumero(pd[k]); if (v != null) soma += v; }
    return soma > 0 && Math.abs(soma - dif) <= 0.02;
}

// Roda um lote inteiro com a âncora ligada ou desligada. `process-folder` é
// recarregado a cada configuração porque ele lê a env no topo do módulo.
async function rodar(pdfs, ancoraLigada) {
    process.env.ANCORA_LOCAL = ancoraLigada ? '1' : '0';
    for (const k of Object.keys(require.cache)) {
        if (k.includes(`routes${path.sep}process-folder.js`)) delete require.cache[k];
    }
    const pf = require('../routes/process-folder');
    const out = new Map();
    for (const pdf of pdfs) {
        try {
            const rows = await pf.analyzePdf(pdf, {});   // sem forceAI: parsers locais
            const r = (rows || []).find(x => !/#p\d+$/i.test(x.arquivo)) || (rows || [])[0];
            if (!r) continue;
            let pd = {};
            try { pd = JSON.parse(r.dados_parser || '{}') || {}; } catch (_) {}
            out.set(pdf.name, pd);
        } catch (e) {
            out.set(pdf.name, { __erro: e.message });
        }
    }
    return out;
}

(async () => {
    // O índice de PDFs vem do process-folder com a env padrão; `collectPdfs` não
    // depende da âncora.
    const pfBase = require('../routes/process-folder');
    const periodos = TODOS ? ['01.2026','02.2026','03.2026','04.2026','05.2026','06.2026'] : [ALVO];
    let pdfs = [];
    for (const p of periodos) {
        const [MM, AAAA] = p.split('.');
        try {
            const lote = await pfBase.collectPdfs(path.join(RAIZ_ARQ, `${AAAA}.${MM}.EXTRATOS CONTABILIDADE`));
            for (const x of lote) pdfs.push(x);
        } catch (e) { console.log(`${p}: pasta inacessível`); }
    }

    // A âncora só pode agir onde há número de fatura no nome; o resto seria ruído
    // com custo de releitura.
    const { valorDoNomeArquivo, numeroDoNomeArquivo } = (() => {
        const src = fs.readFileSync(path.join(RAIZ, 'routes', 'process-folder.js'), 'utf8');
        const L = src.split(/\r?\n/);
        const pega = (decl) => {
            const i = L.findIndex(x => x.startsWith(decl));
            let f = -1;
            for (let j = i + 1; j < L.length; j++) if (L[j] === '}') { f = j; break; }
            return L.slice(i, f + 1).join('\n');
        };
        const re = L.find(x => x.startsWith('const RE_NUM_NOME ='));
        const mod = { exports: {} };
        new Function('module', `${pega('function valorDoNomeArquivo')}\n${re}\n${pega('function numeroDoNomeArquivo')}
module.exports = { valorDoNomeArquivo, numeroDoNomeArquivo };`)(mod);
        return mod.exports;
    })();

    pdfs = pdfs.filter(p => valorDoNomeArquivo(p.name) && numeroDoNomeArquivo(p.name) != null);
    if (Number.isFinite(LIMITE)) pdfs = pdfs.slice(0, LIMITE);
    console.log(`documentos com valor E número no nome: ${pdfs.length}\n`);
    if (!pdfs.length) { console.log('nada a medir.'); process.exit(0); }

    console.log('── relendo COM âncora (produção de hoje) ──');
    const com = await rodar(pdfs, true);
    console.log('── relendo SEM âncora ─────────────────────');
    const sem = await rodar(pdfs, false);

    const c = { avaliados: 0, erro: 0, iguais: 0, ganho: 0, perda: 0, ambos: 0, retencao: 0 };
    const exG = [], exP = [];
    for (const pdf of pdfs) {
        const a = com.get(pdf.name), b = sem.get(pdf.name);
        if (!a || !b) continue;
        if (a.__erro || b.__erro) { c.erro++; continue; }
        const vNome = valorDoNomeArquivo(pdf.name);
        const vCom = paraNumero(a['Valor total']), vSem = paraNumero(b['Valor total']);
        if (!vNome || (vCom == null && vSem == null)) continue;
        c.avaliados++;
        if (ehRetencao(a, vCom, vNome) || ehRetencao(b, vSem, vNome)) { c.retencao++; continue; }
        if (bate(vCom, vSem)) { c.iguais++; continue; }
        const okCom = bate(vCom, vNome), okSem = bate(vSem, vNome);
        if (!okCom && okSem) { c.ganho++; exG.push({ n: pdf.name, vCom, vSem, vNome, o: a['Origem do valor pago'] }); }
        else if (okCom && !okSem) { c.perda++; exP.push({ n: pdf.name, vCom, vSem, vNome, o: a['Origem do valor pago'] }); }
        else c.ambos++;
    }

    console.log(`\n══ DESLIGAR A ÂNCORA NO CAMINHO LOCAL ═══════════════════`);
    console.log(`   avaliados            : ${c.avaliados}`);
    console.log(`   erro de leitura      : ${c.erro}`);
    console.log(`   retenção (fora)      : ${c.retencao}`);
    console.log(`   valor idêntico       : ${c.iguais}`);
    console.log(`\n   ── só os que MUDAM ──`);
    console.log(`   GANHO (âncora errava → acerta sem ela) : ${c.ganho}`);
    console.log(`   PERDA (âncora acertava → erra sem ela) : ${c.perda}   ← decide`);
    console.log(`   ambos erram                            : ${c.ambos}`);
    console.log(`\n   LÍQUIDO: ${c.ganho - c.perda >= 0 ? '+' : ''}${c.ganho - c.perda}`);

    for (const e of exP.slice(0, 10)) {
        console.log(`\n   PERDA  com ${BRL(e.vCom)} → sem ${BRL(e.vSem)}   (nome: ${BRL(e.vNome)})`);
        console.log(`      ${e.n.slice(0, 70)}`);
    }
    for (const e of exG.slice(0, 8)) {
        console.log(`\n   ganho  com ${BRL(e.vCom)} → sem ${BRL(e.vSem)}   (nome: ${BRL(e.vNome)})`);
        console.log(`      ${e.n.slice(0, 70)}`);
    }

    if (CSV) {
        const linhas = [['efeito','arquivo','valor_nome','com_ancora','sem_ancora'].join(';')];
        for (const [ef, arr] of [['GANHO', exG], ['PERDA', exP]]) {
            for (const e of arr) linhas.push([ef, `"${e.n}"`, String(e.vNome).replace('.', ','),
                String(e.vCom).replace('.', ','), String(e.vSem).replace('.', ',')].join(';'));
        }
        fs.writeFileSync(path.join(RAIZ, CSV), linhas.join('\n'), 'utf8');
        console.log(`\nCSV: ${CSV}`);
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
