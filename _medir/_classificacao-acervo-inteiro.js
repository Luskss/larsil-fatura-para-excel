/**
 * _medir/_classificacao-acervo-inteiro.js — a classificação está certa?
 *
 * PERGUNTA DIRETA do usuário (21/09/2026). Até agora medi o tipo só sobre os
 * 1.775 pares COM gabarito da planilha. Isto olha os **4.844 documentos do banco**,
 * incluindo os que nunca parearam.
 *
 * ── A régua, e o que aprendi hoje sobre ela ─────────────────────────────────
 * A testemunha independente é o marcador que o ARQUIVISTA escreveu no nome
 * ("NF 1825", "RCB 901432", "FT 4180"). Ele não participa da classificação, que é
 * 100% por conteúdo — então concordar é evidência real.
 *
 * MAS ela tem um viés medido: em frete o arquivista escreve "NF" querendo dizer
 * *nota* genérica, e o papel é CT-e ([[nf-para-cte-nao-e-defeito]]). Por isso aqui
 * a discordância é **SUSPEITA**, não erro — e separo as que têm evidência FORTE
 * (marcador canônico lido do papel), onde quem provavelmente erra é a régua.
 *
 * ── As três medidas ─────────────────────────────────────────────────────────
 *   1. CONCORDÂNCIA: onde o nome diz o tipo, o banco concorda?
 *   2. as discordâncias, separadas por FORÇA DA EVIDÊNCIA:
 *        evidência forte (marcador do papel) → provável acerto do sistema
 *        evidência fraca / IA (só o emitente) → suspeita real
 *   3. os 'Não identificado' e o que são
 *
 * SOMENTE LEITURA.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '—';
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

// O marcador de tipo no NOME. Ordem importa: NFS antes de NF, senão "NFS 603"
// casa como NF. Exige fronteira de palavra ([[regua-frouxa-inventa-confirmacao]]).
function tipoDoNome(nome) {
    const t = norm(nome);
    if (/\bNFS-?E?\b/.test(t))                 return 'NFS';
    if (/\bCT-?E\b|\bDACTE\b/.test(t))         return 'CTE';
    if (/\bNF-?E?\b|\bNOTA FISCAL\b/.test(t))  return 'NF';
    if (/\bFAT\b|\bFATURA\b|\bFT\b/.test(t))   return 'FATURA';
    if (/\bRCB\b|\bRECIBO\b|\bREC\b/.test(t))  return 'RECIBO';
    if (/\bDARF\b|\bGPS\b|\bGUIA\b|\bFGTS\b|\bINSS\b/.test(t)) return 'IMPOSTO';
    if (/\bCONSORCIO\b|\bCOTA\b/.test(t))      return 'CONSORCIO';
    return '';
}

// evidência FORTE = o classificador casou um marcador canônico NO PAPEL
const CANONICA = {
    NF:        /^(DANFE|DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRONI|NATUREZA DA OPERACAO)/,
    NFS:       /^(NFS-?E|NOTA FISCAL DE SERVICOS?|NOTA FISCAL ELETRONICA DE SERVICOS?)/,
    CTE:       /^(DACTE|CT-?E|MDF-?E|CONHECIMENTO DE TRANSPORTE)/,
    IMPOSTO:   /^(DARF|ARRECADACAO DE RECEITAS|GUIA DA PREVIDENCIA|DCTFWEB|FGTS|GUIA DO FGTS|GPS|INSS|GUIA DE (RECOLHIMENTO|ARRECADACAO))/,
    CONSORCIO: /^(CONSORCIO|COTA DE CONSORCIO|PARCELA DE CONSORCIO|ADMINISTRADORA DE CONSORCIOS?|GRUPO DE CONSORCIO)/,
    FATURA:    /^(FATURA)/,
    RECIBO:    /^(RECIBO)/,
};

(async () => {
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));

    // dedupe pelo PDF de origem: carnê vira 1 linha por parcela
    const docs = new Map();
    for (const [arq, info] of Object.entries(idx)) {
        const k = base(arq);
        if (!docs.has(k)) docs.set(k, info);
    }
    console.log(`linhas no índice: ${Object.keys(idx).length}`);
    console.log(`documentos únicos (sem #pN): ${docs.size}\n`);

    let comMarcador = 0, concorda = 0, discorda = 0, semMarcador = 0, naoIdent = 0;
    const disc = new Map();       // "nome→banco" → { forte: [], fraca: [] }
    const naoIdentEx = [];

    for (const [arq, info] of docs) {
        const tb = String(info.tipo || '').trim();
        if (!tb || tb === 'Não identificado') {
            naoIdent++;
            if (naoIdentEx.length < 12) naoIdentEx.push(arq);
            continue;
        }
        const tn = tipoDoNome(arq);
        if (!tn) { semMarcador++; continue; }
        comMarcador++;
        if (tn === tb) { concorda++; continue; }
        discorda++;
        const k = `${tn}→${tb}`;
        if (!disc.has(k)) disc.set(k, { forte: [], fraca: [] });
        const ev = norm(info.evidencia || '');
        const re = CANONICA[tb];
        const ehForte = String(info.origem || '').startsWith('conteúdo') && re && re.test(ev);
        disc.get(k)[ehForte ? 'forte' : 'fraca'].push({ arq, ev: info.evidencia, org: info.origem });
    }

    console.log('── (1) CONCORDÂNCIA com o marcador do nome ─────────────────');
    console.log(`  documentos com marcador no nome: ${comMarcador}`);
    console.log(`    CONCORDAM:  ${String(concorda).padStart(5)}  ${pct(concorda, comMarcador)}`);
    console.log(`    discordam:  ${String(discorda).padStart(5)}  ${pct(discorda, comMarcador)}`);
    console.log(`  sem marcador no nome (não avaliável): ${semMarcador}`);
    console.log(`  'Não identificado':                   ${naoIdent}`);

    console.log('\n── (2) as discordâncias, por força da evidência ────────────');
    console.log('  nome→banco          total   evid.FORTE   evid.fraca/IA');
    let totForte = 0, totFraca = 0;
    const ord = [...disc].sort((a, b) => (b[1].forte.length + b[1].fraca.length) - (a[1].forte.length + a[1].fraca.length));
    for (const [k, v] of ord) {
        const n = v.forte.length + v.fraca.length;
        totForte += v.forte.length; totFraca += v.fraca.length;
        console.log(`  ${k.padEnd(20)} ${String(n).padStart(5)}   ${String(v.forte.length).padStart(10)}   ${String(v.fraca.length).padStart(13)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(20)} ${String(discorda).padStart(5)}   ${String(totForte).padStart(10)}   ${String(totFraca).padStart(13)}`);

    console.log('\n  Evidência FORTE = o classificador leu DANFE/NFS-e/DACTE/DARF no papel.');
    console.log('  Aí quem provavelmente erra é a RÉGUA (o arquivista escreve "NF" para');
    console.log('  qualquer nota) — foi o caso do frete em [[nf-para-cte-nao-e-defeito]].');

    console.log('\n── as discordâncias com evidência FORTE (sistema provavelmente certo) ──');
    for (const [k, v] of ord) {
        if (!v.forte.length) continue;
        console.log(`\n  ${k}  (${v.forte.length})`);
        for (const e of v.forte.slice(0, 4))
            console.log(`     evid="${String(e.ev).slice(0, 26)}"  ${e.arq.slice(0, 52)}`);
    }

    console.log('\n── as discordâncias com evidência FRACA/IA (suspeitas reais) ──');
    for (const [k, v] of ord) {
        if (!v.fraca.length) continue;
        console.log(`\n  ${k}  (${v.fraca.length})`);
        for (const e of v.fraca.slice(0, 4))
            console.log(`     [${e.org}] "${String(e.ev).slice(0, 30)}"  ${e.arq.slice(0, 46)}`);
    }

    console.log('\n── (3) os Não identificado ─────────────────────────────────');
    for (const a of naoIdentEx) console.log(`  ${a.slice(0, 66)}`);

    console.log(`\n${'═'.repeat(68)}`);
    console.log('RESUMO');
    console.log('═'.repeat(68));
    console.log(`\n  Concordância com a testemunha independente: ${pct(concorda, comMarcador)}`);
    console.log(`  Das ${discorda} discordâncias, ${totForte} têm marcador canônico lido do PAPEL`);
    console.log(`  (provável acerto do sistema) e ${totFraca} vêm de evidência fraca ou da IA.`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
