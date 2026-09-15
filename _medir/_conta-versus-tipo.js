/**
 * _medir/_conta-versus-tipo.js — a CONTA CONTÁBIL prediz o TIPO do documento?
 *
 * PERGUNTA (15/09/2026): `CONTA_C` é a classificação que a própria contabilidade deu
 * ao lançamento, e o documento tem `tipo` (NF, NFS, CTE, RECIBO, IMPOSTO) lido pelo
 * extrator. Os dois campos existem, descrevem a mesma transação por ângulos
 * diferentes, e NUNCA se falam: hoje `CONTA_C` só serve para EXCLUIR lançamento sem
 * nota (`CONTAS_SEM_DOCUMENTO`), nunca para confirmar um par.
 *
 * Um lançamento em conta de SERVIÇO casado com um DANFE de mercadoria é um par
 * suspeito que o motor não sabe questionar.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Sobre os pares que o motor JÁ faz: a distribuição de `tipo` por `CONTA_C` é
 * concentrada ou dispersa?
 *
 *   concentrada → a conta prediz o tipo, e divergência vira evidência de par errado
 *   dispersa    → a conta não diz nada sobre o papel, e a ideia morre aqui
 *
 * E o teste que decide: a concentração difere entre par FORTE (força 3) e par FRACO
 * (força 1)? Se os pares fracos divergirem mais, o sinal discrimina — como a data de
 * emissão discrimina (`_data-como-sinal.js`: 70,7% × 3,3%).
 *
 * ── Por que este script lê a planilha por conta própria ─────────────────────
 * `CONTA_C` é lida na rota mas NÃO sobrevive ao `itens.push` (comparar-notas.js:1190):
 * o lançamento que chega ao pareamento tem nf, entidade, fantasia, cnpj, valor e as
 * duas datas — a conta fica pelo caminho. Medir exige relê-la da planilha.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

(async () => {
    const rota = h.internasDaRota();
    const c = h.carregar();
    console.error('[conta-tipo] reindexando...');
    const idx = await indexar();

    // ── relê a planilha só para recuperar CONTA_C por lançamento ────────────
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const planilhaPath = process.env.PLANILHA_PATH;
    const wb = XLSX.readFile(planilhaPath, { cellDates: false });
    let contaPorChave = new Map();
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE');
        const iConta = header.indexOf('CONTA_C');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iConta < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const nf = String(r[iNF] || '').trim();
            const ent = norm(r[iEnt]);
            const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            contaPorChave.set(`${nf}|${ent}|${val.toFixed(2)}`, norm(r[iConta]));
        }
        break;
    }
    console.log(`CONTA_C recuperada para ${contaPorChave.size} chaves da planilha\n`);
    if (!contaPorChave.size) { console.log('não consegui ler CONTA_C — abortando'); process.exit(1); }

    // ── pares do motor, cruzados com conta × tipo ───────────────────────────
    const tab = new Map();           // conta → { tipo → n }
    const porForca = { 3: new Map(), 2: new Map(), 1: new Map() };
    let comConta = 0, comTipo = 0, total = 0;

    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor)||0).toFixed(2)}`;
            return o;
        });
        const docsPorMes = {};
        for (const off of [0, ...p.VIZINHANCA]) {
            const alvo = p.deslocarPeriodo(periodo, off);
            docsPorMes[alvo] = (c.pasta.arquivosPorMes[alvo] || []).map(a =>
                p.enriquecerComOcr(p.documentoDoArquivo(a.nome, a.rel), idx[a.nome]));
        }
        const r = p.conferirPeriodo(lancs, docsPorMes, periodo);
        for (const x of [...r.pares, ...r.paresVizinhos]) {
            total++;
            const conta = contaPorChave.get(x.lancamento._chave);
            const tipo = x.documento.tipo || (idx[x.documento.arquivo] && idx[x.documento.arquivo].tipo);
            if (conta) comConta++;
            if (tipo) comTipo++;
            if (!conta || !tipo) continue;
            if (!tab.has(conta)) tab.set(conta, new Map());
            const m = tab.get(conta);
            m.set(tipo, (m.get(tipo) || 0) + 1);
            const f = x.forca || 1;
            const mf = porForca[f] || (porForca[f] = new Map());
            const k = `${conta}→${tipo}`;
            mf.set(k, (mf.get(k) || 0) + 1);
        }
    }

    console.log(`pares: ${total}   com CONTA_C: ${comConta} (${pct(comConta,total)})   com tipo: ${comTipo} (${pct(comTipo,total)})\n`);

    // concentração: qual fração dos pares de cada conta cai no tipo dominante?
    const linhas = [];
    for (const [conta, m] of tab) {
        const n = [...m.values()].reduce((a, b) => a + b, 0);
        if (n < 12) continue;
        const ord = [...m].sort((a, b) => b[1] - a[1]);
        linhas.push({ conta, n, dom: ord[0][0], domN: ord[0][1], conc: ord[0][1] / n, ord });
    }
    linhas.sort((a, b) => b.n - a.n);

    console.log('CONTA_C                              pares  tipo dominante   concentração');
    for (const l of linhas.slice(0, 22))
        console.log(`   ${l.conta.slice(0, 32).padEnd(34)} ${String(l.n).padStart(5)}  ${l.dom.padEnd(14)} ${pct(l.domN, l.n).padStart(6)}`);

    const media = linhas.reduce((s, l) => s + l.conc, 0) / (linhas.length || 1);
    console.log(`\nconcentração MÉDIA (peso igual por conta): ${(100*media).toFixed(0)}%`);
    console.log('\nLEITURA: concentração alta (>80%) = a conta prediz o tipo e a divergência');
    console.log('vira evidência. Concentração baixa = cada conta recebe todo tipo de papel,');
    console.log('e o cruzamento não distingue nada.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
