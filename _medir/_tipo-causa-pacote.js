/**
 * _medir/_tipo-causa-pacote.js — a REGRA DE PACOTE explica o erro NF→FATURA?
 *
 * HIPÓTESE (21/09/2026): `_tipo-regua-confere.js` isolou 130 erros REAIS NF→FATURA
 * (+22 NFS→FATURA), quase todos pela via IA. O FULL_PROMPT (_nf-ai-full.js:67-75)
 * tem a "REGRA DE PACOTE MULTI-DOCUMENTO", que manda classificar como FATURA
 * quando o PDF agrupa nota + boleto:
 *
 *     "Nesse caso há UM documento PRINCIPAL: o que está sendo PAGO (a FATURA/
 *      duplicata/boleto)."
 *
 * Memória do projeto (`acessorio-nao-separa-do-fiscal`): "+ AUT" é nota MAIS
 * autorização — o acessório NÃO se separa do fiscal. "NF 96309 + BOL" é uma NOTA
 * acompanhada do boleto de pagamento, não uma fatura. Se a regra de pacote está
 * disparando aí, ela inverte a classificação de um acervo inteiro.
 *
 * ── O que se mede ───────────────────────────────────────────────────────────
 * Entre os erros REAIS (confirmados pelo nome do arquivo), qual fração tem
 * marcador de acessório no nome (+ BOL / + AUT / +pv)?
 *
 *   fração alta → a regra de pacote é a causa; o conserto é de PROMPT, localizado
 *   fração baixa → é leitura errada do papel, e o conserto é outro
 *
 * Mede também o CONTRAPESO: quantos documentos que a planilha chama FATURA têm o
 * mesmo marcador? Se forem muitos, a regra acerta neles e mexer nela tem custo.
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
// Marcador de ACESSÓRIO no nome: o papel de pagamento que acompanha o fiscal.
const ACESSORIO_RE = /\+\s*(BOL|BOLETO|AUT|AUTORIZACAO|PV|COMP|COMPROVANTE)\b|\bBOL\b\s*$/;
const temAcessorio = nome => ACESSORIO_RE.test(norm(nome));

(async () => {
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

    // erros reais NF/NFS → FATURA, e o contrapeso (FATURA de verdade)
    let errPkgComAcess = 0, errPkgSemAcess = 0;
    let fatCertaComAcess = 0, fatCertaSemAcess = 0;
    let errOutrosComAcess = 0, errOutrosSemAcess = 0;
    const viaErr = new Map();
    const amostraSem = [];

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
            const gab = tipoPlanilhaParaBanco(tipoPl);
            if (!gab || gab === '*') continue;
            const arq = x.documento.arquivo;
            const ac = temAcessorio(arq);
            const tn = tipoDoNome(arq);

            if (gab === 'FATURA' && lido === 'FATURA') {       // contrapeso
                if (ac) fatCertaComAcess++; else fatCertaSemAcess++;
                continue;
            }
            if (gab === lido) continue;
            if (tn !== gab) continue;                          // só erro REAL

            if ((gab === 'NF' || gab === 'NFS') && lido === 'FATURA') {
                if (ac) { errPkgComAcess++; } else { errPkgSemAcess++; if (amostraSem.length < 8) amostraSem.push(arq); }
                const v = info.origem || '(nd)';
                viaErr.set(v, (viaErr.get(v) || 0) + 1);
            } else {
                if (ac) errOutrosComAcess++; else errOutrosSemAcess++;
            }
        }
    }

    const errPkg = errPkgComAcess + errPkgSemAcess;
    console.log('── erros REAIS  NF/NFS → FATURA  (a família dominante) ───────');
    console.log(`  total ${errPkg}`);
    console.log(`    COM marcador de acessório (+BOL/+AUT/+pv) ${String(errPkgComAcess).padStart(4)}  ${pct(errPkgComAcess, errPkg)}`);
    console.log(`    SEM marcador                              ${String(errPkgSemAcess).padStart(4)}  ${pct(errPkgSemAcess, errPkg)}`);
    console.log('\n  via que classificou:');
    for (const [v, n] of [...viaErr].sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(v).padEnd(22)} ${String(n).padStart(4)}`);

    const fatCerta = fatCertaComAcess + fatCertaSemAcess;
    console.log('\n── CONTRAPESO: FATURA que a planilha confirma ────────────────');
    console.log(`  total ${fatCerta}`);
    console.log(`    COM marcador de acessório ${String(fatCertaComAcess).padStart(4)}  ${pct(fatCertaComAcess, fatCerta)}`);
    console.log(`    SEM marcador              ${String(fatCertaSemAcess).padStart(4)}  ${pct(fatCertaSemAcess, fatCerta)}`);

    console.log('\n── demais erros reais (fora da família) ──────────────────────');
    console.log(`  com acessório ${errOutrosComAcess}   sem ${errOutrosSemAcess}`);

    if (amostraSem.length) {
        console.log('\n  erros NF/NFS→FATURA SEM marcador (o resíduo, não explicado pela regra):');
        for (const a of amostraSem) console.log(`    ${a.slice(0, 70)}`);
    }

    console.log('\nLEITURA: se a fração COM acessório for alta nos erros e BAIXA no');
    console.log('contrapeso, a regra de pacote separa mal — e o conserto é de prompt.');
    console.log('Se for alta nos dois, a regra não discrimina e mexer nela troca erro por erro.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
