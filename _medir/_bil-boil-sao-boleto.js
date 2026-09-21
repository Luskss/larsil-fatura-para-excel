/**
 * _medir/_bil-boil-sao-boleto.js — "BIL" e "BOIL" são "BOL" digitado errado?
 *
 * ACHADO (`_fila-11-anatomia.js`): na fila final quase todos os NF→FATURA têm o
 * mesmo padrão, e o nome do arquivo denuncia:
 *
 *     131.DOC- 7650,00-...UNIFORMES . NF 775+ BIL.pdf      ← BIL
 *     014.DOC- 1333,60 - INGA- NF 67034- BOL.pdf           ← BOL sem o "+"
 *     007.DOC- 200,00-...FARO . NF 14853+ BOIL.pdf         ← BOIL
 *
 * A regra de acessório de `tipoBate` ([[tipobate-simetrico-restrito-aprovado]]) é:
 *
 *     /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/
 *
 * Ela exige `+ BOL` ou `BOL` no fim. Não pega `BIL`, `BOIL`, nem `- BOL` com
 * hífen. São erros de digitação do arquivista — o pacote é nota+boleto igual.
 *
 * ── Antes de mexer, DIMENSIONAR e checar o risco ────────────────────────────
 * Afrouxar a regex de acessório afrouxa a absolvição do `tipoBate`, que foi
 * aprovada com troca medida (147 falsos mortos × 1 cegado). Ampliar pode cegar
 * alertas procedentes — [[gabarito-frouxo-inventa-erro]].
 *
 *   1. quantos arquivos no ACERVO têm essas variantes?
 *   2. quantos alertas a mais seriam absolvidos?
 *   3. algum deles tem marcador no papel CONTRADIZENDO o banco? (cegaria defeito)
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

const ATUAL = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
// candidata: aceita separador -, ., espaço; e as grafias erradas BIL/BOIL/BOLETO
const AMPLA = /[+\-.]\s*(BOL|BOLETO|BOLET|BIL|BOIL|BOLL|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\b(BOL|BIL|BOIL)\b\s*$/;

const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
const marcador = ev => { const e = norm(ev); return /^IA:/.test(e) ? '' : (MARCADOR_FORTE[e] || ''); };
function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}

(async () => {
    const c = h.carregar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    // ── (1) o acervo ───────────────────────────────────────────────────────
    console.log('═'.repeat(78));
    console.log('(1) QUANTOS ARQUIVOS A REGEX AMPLA PEGA A MAIS?');
    console.log('═'.repeat(78));
    let total = 0, soAtual = 0, soAmpla = 0, ambas = 0;
    const exemplos = [];
    for (const arqs of Object.values(c.pasta.arquivosPorMes || {}))
        for (const a of arqs) {
            total++;
            const n = norm(a.nome);
            const x = ATUAL.test(n), y = AMPLA.test(n);
            if (x && y) ambas++;
            else if (x) soAtual++;
            else if (y) { soAmpla++; if (exemplos.length < 14) exemplos.push(a.nome); }
        }
    console.log(`\n   arquivos: ${total}`);
    console.log(`   pegos pelas DUAS:        ${ambas}`);
    console.log(`   só pela ATUAL:           ${soAtual}  ${soAtual ? '⚠ a ampla perdeu algo' : '✓'}`);
    console.log(`   só pela AMPLA (ganho):   ${soAmpla}`);
    console.log('\n   exemplos que só a ampla pega:');
    for (const e of exemplos) console.log(`      ${e.slice(0, 66)}`);

    // ── (2) quantos alertas seriam absolvidos ──────────────────────────────
    console.log(`\n${'═'.repeat(78)}`);
    console.log('(2) O EFEITO NOS ALERTAS DE TIPO');
    console.log('═'.repeat(78));
    const idxOcr = await indexar();
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE'), iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]); const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    // tipoBate com cada regex
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const corpo = srcB.match(/function tipoBate[\s\S]*?\n\}/)[0];
    const fazer = (re) => new Function('norm', 'RE', `
        function temAcessorioNoNome(a) { return RE.test(norm(a)); }
        ${corpo}; return tipoBate;`)(norm, re);
    const tbAtual = fazer(ATUAL), tbAmpla = fazer(AMPLA);

    let aAtual = 0, aAmpla = 0;
    const absolvidos = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idxOcr[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            const tipoPl = tipoPorChave.get(x.lancamento._chave);
            const info = idx[base(x.documento.arquivo)] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab) continue;
            const arq = x.documento.arquivo;
            const okA = tbAtual(lido, { tipoBanco: gab }, { arquivo: arq });
            const okB = tbAmpla(lido, { tipoBanco: gab }, { arquivo: arq });
            if (!okA) aAtual++;
            if (!okB) aAmpla++;
            if (!okA && okB) absolvidos.push({
                periodo, arq, lido, gab, ev: String(info.evidencia || '').trim(),
                valor: Math.abs(Number(x.lancamento.valor) || 0),
                papel: marcador(info.evidencia),
            });
        }
    }
    console.log(`\n   alertas com a regex ATUAL: ${aAtual}`);
    console.log(`   alertas com a regex AMPLA: ${aAmpla}   (${aAtual - aAmpla} a menos)`);

    console.log('\n── os que a ampla absolve ──────────────────────────────────');
    let risco = 0;
    for (const x of absolvidos.sort((a, b) => b.valor - a.valor)) {
        const perigo = x.papel && x.papel !== x.lido;
        if (perigo) risco++;
        console.log(`\n   ${perigo ? '⚠ ' : ''}${x.periodo} ${brl(x.valor).padStart(13)}  ${x.gab}×${x.lido}`);
        console.log(`      ${x.arq.slice(0, 62)}`);
        console.log(`      evidência: "${x.ev.slice(0, 40)}"${perigo ? '   ← o PAPEL contradiz o banco!' : ''}`);
    }
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`   absolvidos: ${absolvidos.length}   com papel contradizendo: ${risco}  ${risco ? '⚠' : '✓ custo zero'}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
