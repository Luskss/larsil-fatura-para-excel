/**
 * _medir/_tipo-alertas-no-painel.js — quantos erros de tipo VIRAM ALERTA?
 *
 * ACHADO (21/09/2026): `tipoBate` (_baseline.js:184) é ASSIMÉTRICO. A regra da
 * linha 197 absolve `planilha=FATURA × banco=NF/NFS`, mas os 152 erros medidos são
 * o INVERSO — `planilha=NF/NFS × banco=FATURA` — e esses ACUSAM divergência.
 *
 * Isso contradiz [[ocp-no-numero-e-correto]] (18/09), que concluiu "custo zero,
 * é rótulo de exibição". A conclusão valia para o pareamento (que de fato não lê
 * `tipo`), mas não para o PAINEL.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Sobre os pares reais, aplicando o `tipoBate` DE PRODUÇÃO: quantos alertas de
 * divergência de tipo o usuário vê, e quantos deles são erro do classificador
 * (não divergência real)? Esse é o número que a queixa do usuário enxerga.
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
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
function tipoDoNome(nome) {
    const t = norm(nome);
    if (/\bNFS-?E?\b/.test(t))                 return 'NFS';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t))  return 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t))   return 'FATURA';
    if (/\bCT-?E\b|\bDACTE\b/.test(t))         return 'CTE';
    if (/\bRCB\b|\bRECIBO\b|\bREC\b/.test(t))  return 'RECIBO';
    if (/\bDARF\b|\bGPS\b|\bGUIA\b|\bFGTS\b|\bINSS\b/.test(t)) return 'IMPOSTO';
    return '';
}

// o tipoBate DE PRODUÇÃO, extraído do fonte (não reescrito à mão). Leva junto o
// helper `temAcessorioNoNome` e sua regex — desde 21/09/2026 tipoBate depende deles,
// e recortar só a função dá "temAcessorioNoNome is not defined".
function carregarTipoBate() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    if (!m) throw new Error('não achei tipoBate — fonte mudou?');
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    if (!re) throw new Error('não achei temAcessorioNoNome — fonte mudou?');
    return new Function('norm', `${re[0]}\n${m[0]}; return tipoBate;`)(norm);
}

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const tipoBate = carregarTipoBate();

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
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE');
        const iTipo = header.indexOf('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        if (iTipo < 0 || iVal < 0) continue;
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]);
            const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, norm(r[iTipo]));
        }
        break;
    }

    let pares = 0, alertas = 0, alertaFalso = 0, alertaReal = 0, alertaMudo = 0;
    const porFamilia = new Map();

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
            const info = idx[x.documento.arquivo] || {};
            const lido = x.documento.tipo || info.tipo || '';
            if (!lido || !tipoPl) continue;
            const gabMap = tipoPlanilhaParaBanco(tipoPl);
            if (!gabMap) continue;
            pares++;

            // exatamente o que a produção faz: tipoBate(tipoDoBanco, nota, rowB).
            // O 3º argumento PRECISA trazer o `arquivo`: desde 21/09/2026 tipoBate
            // consulta o nome para reconhecer o pacote nota+boleto. Passar `{}` aqui
            // media silenciosamente o código ANTIGO — o script dizia 240 alertas com
            // o conserto já aplicado.
            const ok = tipoBate(lido, { tipoBanco: gabMap }, { arquivo: x.documento.arquivo });
            if (ok) continue;
            alertas++;

            const fam = `${gabMap}→${lido}`;
            if (!porFamilia.has(fam)) porFamilia.set(fam, { n: 0, falso: 0, real: 0, mudo: 0 });
            const f = porFamilia.get(fam); f.n++;

            // o alerta é FALSO se o classificador errou (nome confirma o gabarito)
            const tn = tipoDoNome(x.documento.arquivo);
            if (tn === gabMap)      { alertaFalso++; f.falso++; }
            else if (tn === lido)   { alertaReal++;  f.real++;  }
            else                    { alertaMudo++;  f.mudo++;  }
        }
    }

    console.log(`pares com tipo dos dois lados: ${pares}`);
    console.log(`ALERTAS de divergência de tipo: ${alertas}  (${pct(alertas, pares)} dos pares)\n`);
    console.log('── o alerta procede? (testemunha: o nome do arquivo) ─────────');
    console.log(`  FALSO   — o classificador errou, o documento está certo  ${String(alertaFalso).padStart(4)}  ${pct(alertaFalso, alertas)}`);
    console.log(`  procede — a planilha é que diverge do papel              ${String(alertaReal).padStart(4)}  ${pct(alertaReal, alertas)}`);
    console.log(`  indecidível                                              ${String(alertaMudo).padStart(4)}  ${pct(alertaMudo, alertas)}`);

    console.log('\n── por família ──────────────────────────────────────────────');
    for (const [fam, f] of [...porFamilia].sort((a, b) => b[1].n - a[1].n))
        console.log(`  ${fam.padEnd(18)} ${String(f.n).padStart(4)}   falso ${String(f.falso).padStart(3)} | procede ${String(f.real).padStart(3)} | mudo ${String(f.mudo).padStart(3)}`);

    console.log('\nLEITURA: "alerta FALSO" é ruído que o usuário vê no painel e precisa');
    console.log('conferir à mão. É o custo real do erro de tipo — e o que a queixa enxerga.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
