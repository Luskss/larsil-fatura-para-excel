/**
 * _medir/_fila-exportar.js — a fila de conferência de tipo, em planilha.
 *
 * PEDIDO (21/09/2026): depois dos consertos, sobraram 52 itens de conferência
 * (+5 de frete). São ~8,7 por mês, em 40 fornecedores. Este script os exporta num
 * .xlsx conferível, ordenado por VALOR decrescente — o critério que põe o MACPONTA
 * de R$ 1,32 mi na primeira linha e deixa a cauda de centavos no fim.
 *
 * ── O que cada coluna responde ──────────────────────────────────────────────
 * A pergunta do conferente é "este par está certo?". Para respondê-la sem abrir o
 * sistema ele precisa: o lançamento (NF, entidade, valor, data), o documento
 * (arquivo, pasta), e POR QUE o sistema desconfiou (tipo de cada lado + natureza).
 *
 * A coluna `natureza` é o veredito da terceira testemunha (o marcador de tipo no
 * nome do arquivo, que não participa da classificação):
 *   defeito do classificador → o papel está certo, o sistema errou o rótulo
 *   planilha diverge do papel → o documento é de outro tipo que o lançado
 *   indecidível              → o nome não diz o tipo; precisa abrir o PDF
 *
 * O frete (CT-e legítimo) vai em ABA SEPARADA: não é defeito, é divergência
 * contábil real ([[nf-para-cte-nao-e-defeito]]) e misturá-lo faria o conferente
 * procurar erro onde não há.
 *
 * SOMENTE LEITURA do banco/planilha; escreve o .xlsx na raiz do projeto.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

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
const EV_CTE_CANONICA = /^(DACTE|CT-?E|MDF-?E|CONHECIMENTO DE TRANSPORTE)$/;

function carregarTipoBate() {
    const srcB = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = srcB.match(/function tipoBate[\s\S]*?\n\}/);
    const re = srcB.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}
// epoch ms → "DD/MM/AAAA"
const dataBR = ms => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

(async () => {
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const tipoBate = carregarTipoBate();

    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb0 = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    // ── lançamentos NÃO-FISCAIS de mesmo fornecedor+valor ───────────────────
    // O caso MACPONTA (R$ 1,32 mi) mostrou o padrão: compra de imobilizado gera
    // ADIANTAMENTO **e** nota, com o MESMO valor. O adiantamento é ignorado na
    // conferência (TIPOS_NAO_FISCAIS), mas o papel arquivado é o comprovante DELE
    // — e o pareamento casa esse papel com a nota, por valor idêntico.
    // Sinalizar isso poupa ao conferente a investigação que me custou 3 scripts.
    const naoFiscalPorChave = new Map();   // "ENTIDADE|valor" → tipo não-fiscal
    const NAO_FISCAIS = /ADIANTAMENTO|PREVISAO|FINANC GIRO|DUPLICATA/;
    for (const nomeAba of wb0.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb0.Sheets[nomeAba], { header: 1, raw: true });
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
            const tp = norm(r[iTipo]);
            tipoPorChave.set(`${String(r[iNF] || '').trim()}|${ent}|${val.toFixed(2)}`, tp);
            if (NAO_FISCAIS.test(tp)) naoFiscalPorChave.set(`${ent}|${val.toFixed(2)}`, tp.trim());
        }
        break;
    }

    const fila = [], frete = [];
    for (const periodo of h.PERIODOS) {
        const lancs = ((c.planilha[periodo] || {}).itens || []).map(l => {
            const o = p.lancamentoDaPlanilha(l);
            o._chave = `${l.nf}|${norm(l.entidade)}|${Math.abs(Number(l.valor) || 0).toFixed(2)}`;
            o._entOrig = String(l.entidade || '');
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
            if (!gab) continue;
            const arq = x.documento.arquivo;
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;

            const linha = {
                'Mês': periodo,
                'NF (planilha)': x.lancamento.nf || '',
                'Fornecedor': x.lancamento._entOrig,
                'Valor': x.lancamento.valor || 0,
                'Emissão': dataBR(x.lancamento.dtEmissao),
                'Lançamento': dataBR(x.lancamento.dtLancamento),
                'Tipo na planilha': String(tipoPl).trim(),
                'Tipo lido no papel': lido,
                'Evidência': String(info.evidencia || '').slice(0, 60),
                'Via': String(info.origem || ''),
                'Arquivo': arq,
                // `documentoDoArquivo` guarda o caminho em `caminho` (não `pasta`):
                // com o nome errado a coluna saía vazia e o conferente não achava o PDF.
                'Pasta': path.dirname(String(x.documento.caminho || arq)).replace(/^\.$/, ''),
                'Confere?': '',      // coluna para o conferente preencher
                'Observação': '',
            };
            // o mesmo fornecedor tem lançamento não-fiscal de valor IDÊNTICO?
            const naoFiscal = naoFiscalPorChave.get(
                `${norm(x.lancamento._entOrig)}|${(x.lancamento.valor || 0).toFixed(2)}`);
            linha['Pista'] = naoFiscal
                ? `há ${naoFiscal} de mesmo valor — o papel pode ser o comprovante dele`
                : '';

            if (lido === 'CTE' && String(info.origem || '') === 'conteúdo'
                && EV_CTE_CANONICA.test(norm(info.evidencia))) {
                frete.push(linha);
                continue;
            }
            const tn = tipoDoNome(arq);
            linha['Natureza'] = tn === gab ? 'defeito do classificador'
                              : tn === lido ? 'planilha diverge do papel'
                              : 'indecidível — abrir o PDF';
            fila.push(linha);
        }
    }

    fila.sort((a, b) => b.Valor - a.Valor);
    frete.sort((a, b) => b.Valor - a.Valor);

    // ordem das colunas: Natureza logo após o par de tipos, que é o motivo do alerta
    const COLS = ['Mês', 'NF (planilha)', 'Fornecedor', 'Valor', 'Emissão', 'Lançamento',
                  'Tipo na planilha', 'Tipo lido no papel', 'Natureza', 'Pista', 'Evidência', 'Via',
                  'Arquivo', 'Pasta', 'Confere?', 'Observação'];
    const COLS_FRETE = COLS.filter(k => k !== 'Natureza' && k !== 'Pista');

    const aoa = (arr, cols) => [cols, ...arr.map(o => cols.map(k => o[k] ?? ''))];
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.aoa_to_sheet(aoa(fila, COLS));
    ws1['!cols'] = [{ wch: 9 }, { wch: 13 }, { wch: 34 }, { wch: 14 }, { wch: 11 }, { wch: 11 },
                    { wch: 20 }, { wch: 16 }, { wch: 26 }, { wch: 52 }, { wch: 34 }, { wch: 10 },
                    { wch: 56 }, { wch: 40 }, { wch: 10 }, { wch: 28 }];
    ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: fila.length, c: COLS.length - 1 } }) };
    ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
    // formata a coluna Valor como moeda
    for (let i = 2; i <= fila.length + 1; i++) {
        const cel = ws1[`D${i}`];
        if (cel) { cel.t = 'n'; cel.z = 'R$ #,##0.00'; }
    }
    XLSX.utils.book_append_sheet(wb, ws1, 'Conferir');

    const ws2 = XLSX.utils.aoa_to_sheet(aoa(frete, COLS_FRETE));
    ws2['!cols'] = ws1['!cols'].filter((_, i) => COLS[i] !== 'Natureza');
    for (let i = 2; i <= frete.length + 1; i++) {
        const cel = ws2[`D${i}`];
        if (cel) { cel.t = 'n'; cel.z = 'R$ #,##0.00'; }
    }
    XLSX.utils.book_append_sheet(wb, ws2, 'Frete (CT-e)');

    // aba de leitura: o que cada natureza significa, para não depender de mim
    const guia = [
        ['Fila de conferência de tipo — jan a jun/2026', ''],
        ['Gerado em', new Date().toLocaleDateString('pt-BR')],
        ['', ''],
        ['ABA "Conferir"', `${fila.length} itens — ordenados do maior valor para o menor`],
        ['ABA "Frete (CT-e)"', `${frete.length} itens — NÃO são erro do sistema (ver abaixo)`],
        ['', ''],
        ['O que significa cada NATUREZA', ''],
        ['defeito do classificador', 'O papel está certo; o sistema errou o rótulo. O nome do arquivo concorda com a planilha.'],
        ['planilha diverge do papel', 'O documento arquivado é de outro tipo que o lançado. O nome do arquivo concorda com o sistema.'],
        ['indecidível — abrir o PDF', 'O nome do arquivo não diz o tipo. Só abrindo o documento para saber.'],
        ['', ''],
        ['A coluna PISTA', 'Quando o mesmo fornecedor tem um lançamento NÃO-FISCAL (adiantamento, previsão, duplicata) de valor IDÊNTICO, o papel arquivado costuma ser o comprovante DELE, não a nota. Exemplo verificado: MACPONTA R$ 1.320.000 — o PDF é o pedido/proposta do adiantamento de 19/01, e a nota fiscal 2391 é lançamento separado do mesmo negócio.'],
        ['', ''],
        ['Sobre a aba Frete', 'O papel é conhecimento de transporte (DACTE/CT-e/MDF-e lido do próprio documento) e a planilha lança como nota fiscal. A classificação do sistema está CERTA; é decisão contábil, não defeito.'],
        ['', ''],
        ['Como usar', 'Preencha "Confere?" com OK ou ERRO e use "Observação" para o que precisar voltar.'],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(guia);
    ws3['!cols'] = [{ wch: 28 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Leia-me');

    const saida = path.join(h.RAIZ, 'fila-conferencia-tipo.xlsx');
    XLSX.writeFile(wb, saida);

    console.log(`gerado: ${saida}`);
    console.log(`  aba "Conferir":    ${fila.length} itens   R$ ${fila.reduce((s, i) => s + i.Valor, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log(`  aba "Frete (CT-e)": ${frete.length} itens   R$ ${frete.reduce((s, i) => s + i.Valor, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log('\n  primeiras linhas (maior valor):');
    for (const l of fila.slice(0, 5))
        console.log(`    R$ ${String(l.Valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })).padStart(14)}  ${l['Mês']}  NF ${String(l['NF (planilha)']).padEnd(8)} ${l.Fornecedor.slice(0, 30)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
