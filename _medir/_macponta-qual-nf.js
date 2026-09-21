/**
 * _medir/_macponta-qual-nf.js — 2391 ou 2527? qual lançamento é o de R$ 1,32 mi?
 *
 * CONTRADIÇÃO (21/09/2026): `_macponta-1-3-milhao.js` leu a planilha e mostrou o
 * lançamento de R$ 1.320.000 com **NF 2527**. Mas `_fila-exportar.js`, percorrendo
 * os pares do motor, imprime **NF 2391** para o mesmo valor.
 *
 * Um dos dois está lendo errado, e a diferença importa: é o número que vai na
 * pergunta à contabilidade ("a nota X foi arquivada?").
 *
 * A causa provável do meu erro anterior: `_macponta-1-3-milhao.js` imprime TODAS
 * as linhas MACPONTA da planilha em sequência, e eu li o `NF:` de uma linha com o
 * `VL_TOTAL(CAB)` de outra — os campos saem intercalados e o olho junta o par
 * errado. Aqui cada linha é lida como registro ÚNICO, com o valor ao lado do
 * número.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
// serial do Excel → DD/MM/AAAA
const excelData = n => {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

(async () => {
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });

    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;

        const col = nome => header.indexOf(nome);
        const iNF = col('NF'), iEnt = col('ENTIDADE'), iTipo = col('TIPO');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        const iEmi = col('DT_EMISSAO'), iData = col('DATA'), iDesp = col('CD_DESPESA');

        console.log('── TODOS os lançamentos MACPONTA, um registro por linha ─────\n');
        console.log('NF        valor            emissão     data        desp  entidade');
        const alvo = [];
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = String(r[iEnt] || '');
            if (!/MACPONTA|MAC PONTA/i.test(norm(ent))) continue;
            const val = Math.abs(Number(r[iVal]) || 0);
            const nf = String(r[iNF] || '').trim();
            const reg = {
                nf, val,
                emissao: excelData(r[iEmi]), data: excelData(r[iData]),
                desp: String(r[iDesp] || '').trim(),
                ent: ent.trim(), tipo: String(r[iTipo] || '').trim(),
            };
            console.log(`${nf.padEnd(9)} ${brl(val).padStart(16)}  ${reg.emissao.padEnd(11)} ${reg.data.padEnd(11)} ${reg.desp.padEnd(5)} ${reg.ent.slice(0, 34)}`);
            if (Math.abs(val - 1320000) < 0.01) alvo.push(reg);
        }

        console.log(`\n${'═'.repeat(70)}`);
        console.log('O(S) LANÇAMENTO(S) DE R$ 1.320.000');
        console.log('═'.repeat(70));
        if (!alvo.length) console.log('  nenhum!');
        for (const a of alvo) {
            console.log(`\n  NF:          ${a.nf}`);
            console.log(`  valor:       ${brl(a.val)}`);
            console.log(`  entidade:    ${a.ent}`);
            console.log(`  tipo:        ${a.tipo}`);
            console.log(`  emissão:     ${a.emissao}`);
            console.log(`  data:        ${a.data}`);
            console.log(`  CD_DESPESA:  ${a.desp}`);
        }
        console.log('\n  → ESTE é o número que vai na pergunta à contabilidade.');
        break;
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
