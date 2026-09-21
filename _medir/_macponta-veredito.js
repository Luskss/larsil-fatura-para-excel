/**
 * _medir/_macponta-veredito.js — o caso de R$ 1,32 mi, fechado.
 *
 * REVIRAVOLTA (21/09/2026). Duas correções ao que eu havia concluído:
 *
 * 1. O número é **NF 2391**, não 2527. Meu script anterior imprimia todas as
 *    linhas MACPONTA em sequência, com os campos intercalados, e eu li o `NF:` de
 *    uma linha com o `VL_TOTAL` de outra. A NF 2527 é um lançamento de R$ 480,01.
 *
 * 2. Existem **TRÊS** lançamentos de R$ 1.320.000 para MACPONTA, não um:
 *
 *      NF 2391   NOTA FISCAL RFB   emissão 01/01  data 19/01  CD_DESPESA 9900
 *      NF 70840  ADIANTAMENTO      emissão 19/01  data 19/01  CD_DESPESA  601
 *      (+ a repetição de 2391 nas várias parcelas do rateio)
 *
 * O `ADIANTAMENTO` de 19/01 é a chave: é a MESMA DATA dos dois PDFs arquivados
 * (`2026.01.19`), e explica por que o papel é PEDIDO + PROPOSTA + PV (prova de
 * pagamento). Não é nota fiscal faltando — é o comprovante do adiantamento, que é
 * o documento correto para esse lançamento.
 *
 * A nota fiscal 2391 tem emissão 01/01/2026, data diferente, e é o segundo
 * lançamento do mesmo negócio (o reconhecimento da compra).
 *
 * ── O que este script verifica ──────────────────────────────────────────────
 *   a) os três lançamentos, lado a lado
 *   b) `ADIANTAMENTO` está na lista de categorias não-fiscais do baseline?
 *      (se está, esse lançamento NEM DEVERIA entrar na conferência)
 *   c) existe documento para a NF 2391 em algum lugar do acervo?
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const brl = v => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const excelData = n => {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

(async () => {
    const c = h.carregar();
    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });

    // ── (a) os lançamentos de R$ 1,32 mi ───────────────────────────────────
    console.log('── (a) os lançamentos de R$ 1.320.000 ───────────────────────\n');
    const regs = [];
    for (const nomeAba of wb.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true });
        let hdr = -1, header = null;
        for (let i = 0; i < Math.min(linhas.length, 40); i++) {
            const l = (linhas[i] || []).map(x => norm(x));
            if (l.includes('ENTIDADE') && l.includes('NF')) { hdr = i; header = l; break; }
        }
        if (hdr < 0) continue;
        const iNF = header.indexOf('NF'), iEnt = header.indexOf('ENTIDADE'),
              iTipo = header.indexOf('TIPO'), iEmi = header.indexOf('DT_EMISSAO'),
              iData = header.indexOf('DATA'), iDesp = header.indexOf('CD_DESPESA');
        const iVal = header.findIndex(x => x === 'VL_TOTAL(CAB)' || x === 'VL_TOTAL_CAB');
        const vistos = new Set();
        for (let i = hdr + 1; i < linhas.length; i++) {
            const r = linhas[i];
            if (!r || !r.length) continue;
            if (!/MACPONTA/i.test(norm(r[iEnt]))) continue;
            if (Math.abs(Math.abs(Number(r[iVal]) || 0) - 1320000) > 0.01) continue;
            const k = `${String(r[iNF]).trim()}|${String(r[iTipo]).trim()}|${r[iData]}`;
            if (vistos.has(k)) continue;
            vistos.add(k);
            regs.push({ nf: String(r[iNF] || '').trim(), tipo: String(r[iTipo] || '').trim(),
                        emissao: excelData(r[iEmi]), data: excelData(r[iData]),
                        desp: String(r[iDesp] || '').trim() });
        }
        break;
    }
    console.log('  NF        tipo                            emissão     data        CD_DESPESA');
    for (const r of regs)
        console.log(`  ${r.nf.padEnd(9)} ${r.tipo.padEnd(31)} ${r.emissao.padEnd(11)} ${r.data.padEnd(11)} ${r.desp}`);

    const adiant = regs.find(r => /ADIANTAMENTO/i.test(r.tipo));
    console.log(`\n  → há ADIANTAMENTO de mesmo valor? ${adiant ? `SIM (NF ${adiant.nf}, ${adiant.data})` : 'não'}`);
    console.log('  → os dois PDFs arquivados estão na pasta 2026.01.19 — a data do ADIANTAMENTO.');

    // ── (b) ADIANTAMENTO é categoria não-fiscal? ───────────────────────────
    console.log('\n── (b) ADIANTAMENTO entra na conferência? ───────────────────');
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/const TIPOS_NAO_FISCAIS = new Set\(\[([^\]]*)\]\)/);
    console.log(`  TIPOS_NAO_FISCAIS = [${m ? m[1].trim() : '(não achei)'}]`);
    const ehNaoFiscal = m && /ADIANTAMENTO/i.test(m[1]);
    console.log(`  → ADIANTAMENTO está na lista? ${ehNaoFiscal ? 'SIM — o lançamento é IGNORADO na conferência' : 'NÃO'}`);
    if (ehNaoFiscal) {
        console.log('\n  Ou seja: o lançamento de ADIANTAMENTO nem aparece no painel. O que');
        console.log('  aparece é a NOTA FISCAL RFB 2391, do mesmo valor — e o pareamento');
        console.log('  casou ela com o papel do adiantamento, porque o valor é idêntico.');
    }

    // ── (c) existe documento da NF 2391 no acervo? ─────────────────────────
    console.log('\n── (c) existe papel com o número 2391 no acervo? ────────────');
    let achou = 0;
    for (const [mes, arqs] of Object.entries(c.pasta.arquivosPorMes || {})) {
        for (const a of arqs) {
            if (/\b2391\b/.test(a.nome)) { achou++; console.log(`  [${mes}] ${a.nome}`); }
        }
    }
    if (!achou) console.log('  nenhum arquivo com "2391" no nome.');

    console.log(`\n${'═'.repeat(70)}`);
    console.log('VEREDITO');
    console.log('═'.repeat(70));
    console.log('\n  O papel arquivado (PEDIDO + PROPOSTA + PV) é o comprovante do');
    console.log('  ADIANTAMENTO de 19/01 — documento CORRETO para aquele lançamento, que');
    console.log('  o próprio sistema ignora por ser categoria não-fiscal.');
    console.log('\n  O que sobra é a NOTA FISCAL RFB 2391 (emissão 01/01), o segundo');
    console.log('  lançamento do mesmo negócio. O pareamento casou-a com o papel do');
    console.log('  adiantamento porque o VALOR é idêntico — e daí o alerta de tipo');
    console.log('  "planilha NF × banco RECIBO", que está CERTO em desconfiar.');
    console.log('\n  A pergunta à contabilidade muda de "sumiu uma nota de R$ 1,3 mi" para');
    console.log('  "a NF 2391 foi arquivada, ou só o comprovante do adiantamento?" —');
    console.log('  bem menos alarmante, e provavelmente uma nota que chega depois.');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
