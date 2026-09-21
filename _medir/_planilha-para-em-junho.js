/**
 * _medir/_planilha-para-em-junho.js — a planilha tem mesmo 0 em 07-09/2026?
 *
 * `_meses-nao-processados-v2.js` diz que 07, 08 e 09/2026 têm **0 lançamentos**
 * pela régua da rota — mas a leitura bruta da v1 via 1.653 linhas em 07/2026.
 * Uma das duas está errada, e a diferença decide se vale processar 1.385 PDFs.
 *
 * Três hipóteses para o zero:
 *   a) a rota agrupa por outro campo de data (lançamento × emissão × vencimento)
 *      e esses registros caem noutro mês;
 *   b) os filtros de escopo (ORIG/FILIAL/contas) removem tudo depois de junho;
 *   c) a planilha REALMENTE só tem despesa lançada até junho, e o que aparece
 *      depois são PARCELAS FUTURAS de contratos (financiamento, consórcio) — que
 *      é o que explicaria a cauda até 2030 vista na v1.
 *
 * A (c) é a mais provável: uma parcela de consórcio com vencimento em 2029 é uma
 * linha da planilha, mas não é despesa de 2029 esperando documento.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const h = require('./harness');

const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const serialParaMes = n => {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
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

        const col = n => header.indexOf(n);
        const iData = col('DATA'), iEmi = col('DT_EMISSAO'), iLanc = col('DT_LANCAMENTO');
        const iTipo = col('TIPO'), iEnt = col('ENTIDADE'), iOrig = col('ORIG');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');

        console.log('colunas de data disponíveis:');
        for (const [nome, i] of [['DATA', iData], ['DT_EMISSAO', iEmi], ['DT_LANCAMENTO', iLanc]])
            console.log(`   ${nome}: ${i >= 0 ? 'índice ' + i : 'AUSENTE'}`);

        // ── por que campo de data os meses futuros aparecem? ───────────────
        const ALVO = new Set(['07.2026', '08.2026', '09.2026']);
        const porCampo = { DATA: 0, DT_EMISSAO: 0, DT_LANCAMENTO: 0 };
        const tiposNoAlvo = new Map();
        const origNoAlvo = new Map();
        let exemplos = [];

        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            const ent = norm(r[iEnt]);
            const val = Math.abs(Number(r[iVal]) || 0);
            if (!ent || !val) continue;

            const mData = iData >= 0 ? serialParaMes(r[iData]) : '';
            const mEmi = iEmi >= 0 ? serialParaMes(r[iEmi]) : '';
            const mLanc = iLanc >= 0 ? serialParaMes(r[iLanc]) : '';
            if (ALVO.has(mData)) porCampo.DATA++;
            if (ALVO.has(mEmi)) porCampo.DT_EMISSAO++;
            if (ALVO.has(mLanc)) porCampo.DT_LANCAMENTO++;

            if (ALVO.has(mData)) {
                const tp = String(r[iTipo] || '').trim() || '(vazio)';
                tiposNoAlvo.set(tp, (tiposNoAlvo.get(tp) || 0) + 1);
                const og = String(r[iOrig] || '').trim() || '(vazio)';
                origNoAlvo.set(og, (origNoAlvo.get(og) || 0) + 1);
                if (exemplos.length < 10)
                    exemplos.push({ tp, ent: String(r[iEnt]).trim().slice(0, 28), val,
                                    mData, mEmi, mLanc, og });
            }
        }

        console.log('\n── linhas que caem em 07-09/2026, por campo de data ────────');
        for (const [k, v] of Object.entries(porCampo))
            console.log(`   por ${k.padEnd(14)} ${String(v).padStart(6)} linhas`);

        console.log('\n── (por DATA) que TIPO são essas linhas? ───────────────────');
        for (const [k, v] of [...tiposNoAlvo].sort((a, b) => b[1] - a[1]).slice(0, 12))
            console.log(`   ${k.padEnd(34)} ${String(v).padStart(6)}`);

        console.log('\n── (por DATA) qual a ORIG? ─────────────────────────────────');
        for (const [k, v] of [...origNoAlvo].sort((a, b) => b[1] - a[1]).slice(0, 10))
            console.log(`   ${k.padEnd(20)} ${String(v).padStart(6)}`);

        console.log('\n── amostra ─────────────────────────────────────────────────');
        for (const e of exemplos)
            console.log(`   ${e.tp.padEnd(26)} ${brl(e.val).padStart(14)}  DATA=${e.mData} EMI=${e.mEmi} LANC=${e.mLanc}  ${e.ent}`);

        // ── o que a ROTA usa para agrupar? ─────────────────────────────────
        const fs2 = require('fs');
        const src = fs2.readFileSync(path.join(h.RAIZ, 'routes', 'comparar-notas.js'), 'utf8');
        const mp = src.match(/periodo[^\n]*=[^\n]*DT_LANCAMENTO|lancamentoMs[^\n]*|periodo:\s*[^\n]+/g);
        console.log('\n── como a rota define o PERÍODO de um lançamento ──────────');
        for (const l of (mp || []).slice(0, 6)) console.log(`   ${l.trim().slice(0, 78)}`);

        console.log('\n── LEITURA ────────────────────────────────────────────────');
        console.log('   Se as linhas de 07-09 forem quase todas PREVISAO/FINANC/parcela');
        console.log('   futura, a planilha NÃO tem despesa lançada nesses meses — ela');
        console.log('   para em junho, e os 1.385 PDFs não têm contraparte a conferir.');
        break;
    }
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
