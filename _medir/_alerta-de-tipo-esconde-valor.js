/**
 * _medir/_alerta-de-tipo-esconde-valor.js — calar o tipo esconde erro de VALOR?
 *
 * ACHADO (21/09/2026): o rótulo em `_tipobate-simetrico.js:143` está invertido em
 * NOMENCLATURA (`tn === gab` é chamado 'falso' quando nome+planilha estão contra o
 * banco). A variante C segue aprovada por outro caminho — 60,9% da sua zona tem
 * número de NF no nome, ou seja, é pacote nota+boleto de verdade, e dos 58
 * documentos com marcador no papel, 58 dizem FATURA e 0 contradizem.
 *
 * Mas falta a pergunta que realmente importa ao usuário. O painel não existe para
 * auditar TIPO — existe para responder "o lançamento está na pasta e bate?". Se um
 * alerta de tipo, ao ser calado, levasse junto uma divergência de VALOR, o conserto
 * teria custo real.
 *
 * ── O teste ─────────────────────────────────────────────────────────────────
 * Dos pares cujo alerta de tipo a variante C silencia:
 *   • o valor do documento bate com o valor lançado?
 *   • o número bate?
 * Se batem, calar o tipo não esconde nada: o par está certo e o alerta era ruído.
 * Se NÃO batem, o alerta de tipo estava servindo de sintoma indireto — e aí ele
 * vale mesmo sendo "errado" na letra.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
function tipoBateDe(src) {
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const antes = tipoBateDe(execFileSync('git', ['show', 'HEAD:routes/_baseline.js'],
        { cwd: h.RAIZ, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    const agora = tipoBateDe(fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8'));

    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

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

    // pares cujo alerta de tipo a variante C SILENCIA
    const silenciados = [];
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
            const acusavaAntes = !antes(lido, { tipoBanco: gab }, { arquivo: arq });
            const acusaAgora   = !agora(lido, { tipoBanco: gab }, { arquivo: arq });
            if (acusavaAntes && !acusaAgora) silenciados.push({ x, arq, gab, lido });
        }
    }

    console.log('═'.repeat(74));
    console.log(`OS ${silenciados.length} ALERTAS QUE A VARIANTE C SILENCIOU`);
    console.log('═'.repeat(74));
    console.log('\nA pergunta: calar o tipo escondeu erro de VALOR ou de NÚMERO?\n');

    // como o par foi formado? o motor grava a força/vias em cada par
    const porForca = new Map();
    let valorBate = 0, valorNaoBate = 0, semValor = 0;
    const divergentes = [];
    for (const s of silenciados) {
        const x = s.x;
        const f = x.forca != null ? `força ${x.forca}` : (x.vias ? String(x.vias) : '(sem força)');
        porForca.set(f, (porForca.get(f) || 0) + 1);

        const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
        const vDoc  = Math.abs(Number(x.documento.valor) || 0);
        if (!vDoc) { semValor++; continue; }
        if (Math.abs(vLanc - vDoc) < 0.02) valorBate++;
        else { valorNaoBate++; divergentes.push({ s, vLanc, vDoc }); }
    }

    console.log('── como esses pares foram formados ─────────────────────────');
    for (const [k, n] of [...porForca].sort((a, b) => b[1] - a[1]))
        console.log(`   ${k.padEnd(20)} ${String(n).padStart(4)}  ${pct(n, silenciados.length)}`);

    console.log('\n── o VALOR do documento bate com o lançado? ────────────────');
    console.log(`   bate:          ${String(valorBate).padStart(4)}  ${pct(valorBate, silenciados.length)}`);
    console.log(`   NÃO bate:      ${String(valorNaoBate).padStart(4)}  ${pct(valorNaoBate, silenciados.length)}`);
    console.log(`   doc sem valor: ${String(semValor).padStart(4)}  ${pct(semValor, silenciados.length)}`);

    if (divergentes.length) {
        console.log('\n   os que divergem em valor (o alerta de tipo seria sintoma útil):');
        for (const d of divergentes.sort((a, b) => Math.abs(b.vLanc - b.vDoc) - Math.abs(a.vLanc - a.vDoc)).slice(0, 12))
            console.log(`      lanç=${brl(d.vLanc).padStart(15)}  doc=${brl(d.vDoc).padStart(15)}  ${d.s.arq.slice(0, 40)}`);
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(74));
    if (!valorNaoBate)
        console.log('\n   Nenhum alerta silenciado escondia divergência de valor.');
    else
        console.log(`\n   ${valorNaoBate} alertas silenciados tinham valor divergente — merecem olhar.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
