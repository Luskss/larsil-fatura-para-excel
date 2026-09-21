/**
 * _medir/_fila-exportar-v2.js — a fila de conferência, depois dos consertos de hoje
 *
 * A fila encolheu em três etapas, todas medidas:
 *   52 (xlsx antigo) → 32 (vereditos já medidos aplicados) → 11 (força 1 desligada)
 *   → 8 (regex de acessório ampliada para "BIL"/"BOIL"/". BOL")
 *
 * O corte da força 1 foi o que mais rendeu: 21 daqueles "alertas de tipo" estavam em
 * pares FALSOS — o documento não tinha relação com o lançamento, então o tipo
 * divergente era sintoma, não a doença ([[forca-1-desligada-implementado]]).
 *
 * ── O que a planilha traz ───────────────────────────────────────────────────
 * Mesmo formato de colunas que o usuário aprovou em `_fila-exportar.js`, mais:
 *   • "Natureza" — a leitura já feita do caso, para não conferir do zero
 *   • "Valor no nome" — quando difere do lançado, sinaliza parcelamento, que é
 *     esperado e faria o conferente estranhar à toa
 *     ([[total-da-nota-nao-e-valor-lancado]])
 *
 * A aba "Já resolvido" lista o que fecha em bloco, com o motivo — para o usuário
 * poder discordar de uma decisão minha em vez de ter de confiar nela.
 *
 * ESCREVE `fila-conferencia-tipo.xlsx` na raiz (substitui o de 52 linhas).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const h = require('./harness');
const p = require('../routes/_pareamento');
const { indexar } = require('./ocr');

const brl = v => Number(v || 0);
const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const base = s => String(s || '').replace(/#p\d+$/i, '');

const TRANSPORTADOR = /\bEXPRESSO\b|\bTRANSPORTES?\b|TRANSPORTADORA|RODOVIARIO|\bLOGISTICA\b|\bRODONAVES\b|PRINCESA DOS CAMPOS|\bACITEL\b|\bCADORE\b|SAVACINSK|\bJB PRESTACAO\b/;
const FATURA_RECORRENTE = /TRACKPLUS|RIO DOCE NET|MEGA REDES|\bBIOS ?NET\b|ALLREDE|\bCEMIG\b|EQUATORIAL|SANESUL|ELEKTRO|EMBASA|\bVIVO\b|\bCLARO\b|FIG TELECOM|ECONET|INNOVA NET|MICROLINK/;

function tipoPlanilhaParaBanco(t0) {
    const t = norm(t0);
    if (t === 'NOTA FISCAL RFB')     return 'NF';
    if (t === 'NOTA FISCAL SERVICO') return 'NFS';
    if (t === 'FATURA')              return 'FATURA';
    if (t === 'IMPOSTO')             return 'IMPOSTO';
    if (t === 'RECIBO E OUTROS')     return '*';
    return '';
}
const MARCADOR_FORTE = {
    'DACTE': 'CTE', 'CT-E': 'CTE', 'MDF-E': 'CTE', 'MDFE': 'CTE',
    'NFS-E': 'NFS', 'NFSE': 'NFS', 'DANFE': 'NF', 'NF-E': 'NF',
    'RECIBO': 'RECIBO', 'FATURA': 'FATURA', 'GUIA': 'IMPOSTO'
};
const marcador = ev => { const e = norm(ev); return /^IA:/.test(e) ? '' : (MARCADOR_FORTE[e] || ''); };
function carregarTipoBate() {
    const src = fs.readFileSync(path.join(h.RAIZ, 'routes', '_baseline.js'), 'utf8');
    const m = src.match(/function tipoBate[\s\S]*?\n\}/);
    const re = src.match(/const ACESSORIO_NO_NOME_RE[\s\S]*?\n\}/);
    return new Function('norm', `${re ? re[0] : ''}\n${m[0]}; return tipoBate;`)(norm);
}
const fmtData = t => {
    if (t == null) return '';
    const d = new Date(t);
    return isNaN(d) ? '' : d.toLocaleDateString('pt-BR');
};

(async () => {
    const tipoBate = carregarTipoBate();
    const c = h.carregar();
    const idxOcr = await indexar();
    const idx = JSON.parse(fs.readFileSync(path.join(h.CACHE, 'tipo-por-arquivo.json'), 'utf8'));
    const vn = p.valorDoNome;

    const XLSX = require(path.join(h.RAIZ, 'node_modules', 'xlsx'));
    const wb0 = XLSX.readFile(process.env.PLANILHA_PATH, { cellDates: false });
    const tipoPorChave = new Map();
    for (const nomeAba of wb0.SheetNames) {
        const linhas = XLSX.utils.sheet_to_json(wb0.Sheets[nomeAba], { header: 1, raw: true });
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

    const conferir = [], resolvido = [];
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
            if (tipoBate(lido, { tipoBanco: gab }, { arquivo: arq })) continue;

            const ev = String(info.evidencia || '').trim();
            const ctx = norm(arq + ' ' + (x.lancamento.entidade || '') + ' ' + ev);
            const vLanc = Math.abs(Number(x.lancamento.valor) || 0);
            const vNome = Math.abs(Number(vn(arq)) || 0);
            let natureza = '', jaResolvido = null;

            if (/MACPONTA/i.test(ctx)) jaResolvido = 'Adiantamento MACPONTA — auditado: o papel é o comprovante, não há nota';
            else if (marcador(ev) && marcador(ev) === lido) jaResolvido = `O papel diz "${ev}" — o banco leu certo, a planilha generalizou`;
            else if (norm(ev) === 'GUIA') jaResolvido = 'Classificado por "GUIA" solto — já corrigido no código, some ao reprocessar';
            else if (lido === 'CTE' && TRANSPORTADOR.test(ctx)) jaResolvido = 'Transportadora: o papel é CT-e e a contabilidade lança frete como nota';
            else if (lido === 'FATURA' && FATURA_RECORRENTE.test(ctx)) jaResolvido = 'Serviço recorrente cobrado por fatura mensal';

            // pista para quem vai conferir
            if (vNome && Math.abs(vNome - vLanc) > 0.02) {
                const razao = vLanc / vNome;
                const n = Math.round(razao);
                if (n >= 2 && n <= 24 && Math.abs(razao - n) / n < 0.02)
                    natureza = `Parcelamento: o documento é 1 de ${n} parcelas`;
            }
            if (!natureza && TRANSPORTADOR.test(ctx)) natureza = 'Fornecedor é transportadora';
            if (!natureza && lido === 'FATURA') natureza = 'Pacote nota+boleto: a IA elegeu o boleto como principal';
            if (!natureza && lido === 'RECIBO') natureza = 'Comprovante/recibo de pagamento';

            const linha = {
                'Mês': periodo,
                'NF (planilha)': String(x.lancamento.nf || ''),
                'Fornecedor': String(x.lancamento.entidade || ''),
                'Valor': vLanc,
                'Valor no nome': vNome || '',
                'Emissão': fmtData(x.documento.dtEmissaoDoc),
                'Lançamento': fmtData(x.lancamento.data),
                'Tipo na planilha': gab === '*' ? 'RECIBO E OUTROS' : gab,
                'Tipo lido no papel': lido,
                'Natureza': natureza,
                'Evidência': ev,
                'Via': x.via || '',
                'Arquivo': arq,
                'Pasta': String(x.documento.caminho || ''),
                'Confere?': '',
                'Observação': '',
            };
            if (jaResolvido) resolvido.push({ ...linha, 'Por que fecha': jaResolvido });
            else conferir.push(linha);
        }
    }

    conferir.sort((a, b) => b.Valor - a.Valor);
    resolvido.sort((a, b) => b.Valor - a.Valor);

    const COLS = ['Mês', 'NF (planilha)', 'Fornecedor', 'Valor', 'Valor no nome', 'Emissão', 'Lançamento',
                  'Tipo na planilha', 'Tipo lido no papel', 'Natureza', 'Evidência', 'Via',
                  'Arquivo', 'Pasta', 'Confere?', 'Observação'];
    const COLS_RES = ['Mês', 'Fornecedor', 'Valor', 'Tipo na planilha', 'Tipo lido no papel',
                      'Por que fecha', 'Arquivo'];
    const LARG = [{ wch: 9 }, { wch: 13 }, { wch: 34 }, { wch: 14 }, { wch: 14 }, { wch: 11 }, { wch: 11 },
                  { wch: 18 }, { wch: 18 }, { wch: 40 }, { wch: 34 }, { wch: 16 },
                  { wch: 56 }, { wch: 40 }, { wch: 10 }, { wch: 28 }];

    const aoa = (arr, cols) => [cols, ...arr.map(o => cols.map(k => o[k] == null ? '' : o[k]))];
    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.aoa_to_sheet(aoa(conferir, COLS));
    ws1['!cols'] = LARG;
    ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: conferir.length, c: COLS.length - 1 } }) };
    ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
    for (let i = 2; i <= conferir.length + 1; i++)
        for (const col of ['D', 'E']) { const cel = ws1[`${col}${i}`]; if (cel && typeof cel.v === 'number') cel.z = '#,##0.00'; }
    XLSX.utils.book_append_sheet(wb, ws1, 'Conferir');

    const ws2 = XLSX.utils.aoa_to_sheet(aoa(resolvido, COLS_RES));
    ws2['!cols'] = [{ wch: 9 }, { wch: 34 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 68 }, { wch: 52 }];
    for (let i = 2; i <= resolvido.length + 1; i++) { const cel = ws2[`C${i}`]; if (cel && typeof cel.v === 'number') cel.z = '#,##0.00'; }
    XLSX.utils.book_append_sheet(wb, ws2, 'Já resolvido');

    const leiaMe = [
        ['FILA DE CONFERÊNCIA DE TIPO — 21/09/2026'],
        [''],
        ['O que é', 'Lançamentos cujo TIPO na planilha difere do tipo que o sistema leu no papel.'],
        [''],
        ['ABA "Conferir"', `${conferir.length} itens — abrir o PDF e dizer quem está certo`],
        ['ABA "Já resolvido"', `${resolvido.length} itens — fecham por análise já feita; a coluna "Por que fecha" explica`],
        [''],
        ['Como a fila encolheu', ''],
        ['  52 itens', 'planilha anterior (18/09), antes dos consertos'],
        ['  → 32', 'aplicados os vereditos já medidos (transportadora, GUIA, papel confirmando)'],
        ['  → 11', 'desligada a via de pareamento por VALOR sozinho: 21 desses "alertas de tipo"'],
        ['', 'estavam em pares FALSOS — documento sem relação com o lançamento'],
        [`  → ${conferir.length}`, 'ampliado o marcador de acessório para ". BOL", "BIL", "BOIL" (erros de digitação)'],
        [''],
        ['Colunas que ajudam', ''],
        ['  Natureza', 'a leitura já feita do caso — não precisa conferir do zero'],
        ['  Valor no nome', 'quando difere do Valor, costuma ser PARCELAMENTO: o documento é de uma'],
        ['', 'parcela e o lançamento é o total. Isso é normal, não é erro.'],
        ['  Via', 'como o par se formou. "numero+entidade+valor" é o mais forte.'],
        [''],
        ['Como responder', 'Preencher "Confere?" com OK (o sistema acertou) ou ERRO (o tipo está errado).'],
        ['', 'Em "Observação", o que o papel realmente é.'],
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(leiaMe);
    ws3['!cols'] = [{ wch: 22 }, { wch: 92 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Leia-me');

    const destino = path.join(h.RAIZ, 'fila-conferencia-tipo.xlsx');
    XLSX.writeFile(wb, destino);

    console.log('═'.repeat(70));
    console.log('FILA EXPORTADA');
    console.log('═'.repeat(70));
    console.log(`\n   ${destino}`);
    console.log(`\n   aba "Conferir":     ${String(conferir.length).padStart(3)} itens   R$ ${conferir.reduce((s, i) => s + i.Valor, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log(`   aba "Já resolvido": ${String(resolvido.length).padStart(3)} itens   R$ ${resolvido.reduce((s, i) => s + i.Valor, 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log('\n── os itens a conferir ─────────────────────────────────');
    for (const x of conferir)
        console.log(`   ${x['Mês']} ${String(x.Valor.toFixed(2)).padStart(12)}  ${x['Tipo na planilha']}×${x['Tipo lido no papel']}  ${x.Arquivo.slice(0, 40)}`);
    process.exit(0);
})().catch(e => { console.error('ERRO', e.stack); process.exit(1); });
