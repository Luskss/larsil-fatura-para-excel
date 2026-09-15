/**
 * _medir/_contraditos.js — a coluna `contrad` saiu de 0 para 131. Por quê?
 *
 * Contradito = o CNPJ do documento diverge do CNPJ do lançamento, num par em que
 * o emitente lido corrobora o fornecedor. Era 0 em todas as medições anteriores,
 * e passou a 131 depois que o extrator fiscal começou a gravar `CNPJ emitente`
 * em muito mais documentos (99,2% dos DANFEs, contra quase nada antes).
 *
 * Duas explicações possíveis, com consequências opostas:
 *   (a) o extrator está lendo o CNPJ ERRADO — bug meu, a corrigir;
 *   (b) o CNPJ agora existe onde antes faltava, e a divergência é REAL —
 *       evidência nova, que o comparador nunca teve.
 *
 * Este script imprime os pares contraditos com os dois CNPJs e os nomes, para a
 * resposta sair do dado e não do palpite.
 *
 * Uso: node _medir/_contraditos.js [quantos]
 */
'use strict';
const h = require('./harness');
const ocr = require('./ocr');
const v = require('./variantes');
const P = require('../routes/_pareamento');

const soDig = s => String(s || '').replace(/\D/g, '');
function normCnpj(c) {
    const d = soDig(c);
    if (!d) return null;
    if (d.length === 14 || d.length === 11) return d;
    if (d.length === 13 || d.length === 12) return d.padStart(14, '0');
    if (d.length === 10 || d.length === 9) return d.padStart(11, '0');
    return null;
}
const raiz = c => { const d = normCnpj(c); return d ? (d.length === 14 ? d.slice(0, 8) : d) : null; };

(async () => {
    const quantos = Number(process.argv[2] || 20);
    const c = h.carregar();
    const idx = await ocr.indexar();

    const periodos = Object.keys(c.planilha).filter(p => /^\d{2}\.\d{4}$/.test(p)).sort();
    const casos = [];

    for (const periodo of periodos) {
        const itens = (c.planilha[periodo] || {}).itens || [];
        if (!itens.length) continue;
        const lancamentos = itens.map(P.lancamentoDaPlanilha).filter(Boolean);

        const documentosPorMes = {};
        for (const [mes, arquivos] of Object.entries(c.pasta.arquivosPorMes || {})) {
            documentosPorMes[mes] = arquivos.map(a => {
                const doc = P.documentoDoArquivo(a.nome, a.rel);
                const o = idx ? idx[a.nome] : null;
                const d = o ? P.enriquecerComOcr(doc, o) : doc;
                if (o && o.cnpj) d.cnpj = o.cnpj;          // o CNPJ que o extrator gravou
                return d;
            });
        }
        const r = P.conferirPeriodo(lancamentos, documentosPorMes, periodo);
        for (const p of [...r.pares, ...r.paresVizinhos]) {
            const rl = raiz(p.lancamento.cnpj), rd = raiz(p.documento.cnpj);
            if (!rl || !rd || rl === rd) continue;
            casos.push({
                periodo,
                arquivo: p.documento.arquivo,
                entidade: p.lancamento.entidade || '',
                cnpjLanc: p.lancamento.cnpj,
                cnpjDoc: p.documento.cnpj,
                rl, rd,
                via: p.via,
            });
        }
    }

    console.log(`${casos.length} pares com CNPJ divergente (raiz ≠ raiz)\n`);

    // O CNPJ do documento é o do EMITENTE. O do lançamento pode ser o da conta
    // paga. Agrupar por raiz do documento mostra se há um punhado de fornecedores
    // respondendo por tudo — sinal de padrão, não de erro espalhado.
    const porDoc = new Map();
    for (const k of casos) porDoc.set(k.rd, (porDoc.get(k.rd) || 0) + 1);
    console.log('── raízes de CNPJ do DOCUMENTO que mais aparecem ──');
    for (const [r, n] of [...porDoc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
        console.log(`  ${String(n).padStart(4)}×  ${r}`);

    console.log('\n── exemplos ──');
    for (const k of casos.slice(0, quantos)) {
        console.log(`\n  ${k.arquivo.slice(0, 66)}`);
        console.log(`     lançamento: ${k.entidade.slice(0, 40).padEnd(40)} CNPJ ${k.cnpjLanc}  (raiz ${k.rl})`);
        console.log(`     documento : ${''.padEnd(40)} CNPJ ${k.cnpjDoc}  (raiz ${k.rd})`);
        console.log(`     via: ${k.via}  ·  ${k.periodo}`);
    }
})();
