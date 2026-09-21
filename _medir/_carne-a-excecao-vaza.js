/**
 * _medir/_carne-a-excecao-vaza.js — a exceção contamina as parcelas na PRODUÇÃO?
 *
 * SUSTO (21/09/2026): `_mais-um-teste.js` mostrou 30 linhas `#pN` cujo valor a
 * exceção mudaria — e todas as 11 "curas" que reportei ontem eram linhas de
 * parcela. Meu script deduplicava por `base()` (que remove o `#pN`), então eu
 * exibia a linha da parcela achando que era o documento.
 *
 * ── Mas a produção faz o contrário do meu script ────────────────────────────
 * Lendo `process-folder.js:604-626`, a ordem real é:
 *
 *   1. `decidirValorPago(pdComum, …)`   ← a exceção age no documento PAI
 *   2. `semBoleto` = {...pdComum} SEM Linha digitável / Valor do boleto
 *   3. cada parcela: `'Valor total': b.valor` ← SOBRESCRITO pela IA de boletos
 *
 * Ou seja: o valor que a exceção escreve é substituído pelo valor DA PARCELA na
 * linha 619. Meu script aplicou a função a linhas `#pN` JÁ GRAVADAS, coisa que a
 * produção nunca faz — as parcelas nascem do pai, não são reprocessadas.
 *
 * ── Mas "eu li o código" não é prova ────────────────────────────────────────
 * [[o-erro-mora-onde-a-funcao-nao-roda]]. Este script SIMULA o fluxo real:
 * monta um `pdComum` de carnê, roda `decidirValorPago`, aplica o bloco do carnê
 * exatamente como a linha 610-626 faz, e confere o que sai em cada parcela.
 *
 * SOMENTE LEITURA.
 */
'use strict';
const V = require('../routes/_valor-do-pagamento');

const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Reproduz process-folder.js:610-626 — o bloco do carnê, tal como está no fonte.
function blocoDoCarne(pdComum, parcelas, nomePdf, valorTotalIA) {
    const semBoleto = { ...pdComum };
    delete semBoleto['Linha digitável'];
    delete semBoleto['Valor do boleto'];
    delete semBoleto['Banco do boleto'];
    delete semBoleto['Data de vencimento'];
    return parcelas.map((b, i) => ({
        arquivo: `${nomePdf}#p${i + 1}`,
        pd: {
            ...semBoleto,
            'Data de vencimento': b.vencimento,
            'Valor total':        b.valor > 0 ? String(b.valor).replace('.', ',')
                                              : (valorTotalIA > 0 ? String(valorTotalIA).replace('.', ',') : ''),
            'Nosso Número':       b.nossoNumero || '',
            'Parcela':            `${i + 1}/${parcelas.length}`,
            'arquivo_original':   nomePdf,
        },
    }));
}

const NOME = '033.DOC- 91288,49 - 2026.03.12. LOCALIZA. FAT 26267.pdf';
const VALOR_DO_NOME = 91288.49;

// LD de 47 dígitos cujo campo 4 vale 91288,49 — o total da fatura
const LD = '23792011029002604354862005184403310000009128849';

console.log('═'.repeat(74));
console.log('SIMULAÇÃO DO FLUXO REAL DO CARNÊ');
console.log('═'.repeat(74));

// 1. o pdComum como sai do parser, ANTES de decidirValorPago
const pdComum = {
    'Emitente': 'LOCALIZA',
    'Linha digitável': LD,
    'Valor do boleto': '91288,49',
    'Valor total': '5368,68',          // o valor de UM item — o defeito original
    'Banco do boleto': '237',
    'Data de vencimento': '31/01/2026',
};
console.log(`\n1. pdComum antes:  Valor total = ${pdComum['Valor total']}`);

// 2. decidirValorPago — a exceção age aqui (sem texto, a âncora se cala)
const decidido = V.decidirValorPago(pdComum, { text: '', numeroDoNome: null, valorDoNome: VALOR_DO_NOME });
console.log(`2. após decidirValorPago: Valor total = ${decidido['Valor total']}   origem="${decidido['Origem do valor pago']}"`);
console.log(`   (a exceção agiu — este é o ganho pretendido, no documento PAI)`);

// 3. o bloco do carnê: 3 parcelas com valores próprios
const parcelas = [
    { valor: 30429.50, vencimento: '31/01/2026', nossoNumero: 'A1' },
    { valor: 30429.50, vencimento: '28/02/2026', nossoNumero: 'A2' },
    { valor: 30429.49, vencimento: '31/03/2026', nossoNumero: 'A3' },
];
const rows = blocoDoCarne(decidido, parcelas, NOME, 91288.49);

console.log('\n3. as parcelas geradas:');
let vazou = 0;
for (const r of rows) {
    const v = V.paraNumero(r.pd['Valor total']);
    const ehTotal = v != null && Math.abs(v - VALOR_DO_NOME) < 0.02;
    if (ehTotal) vazou++;
    console.log(`   ${r.arquivo.slice(-6)}  Valor total = ${String(r.pd['Valor total']).padStart(10)}  ${ehTotal ? '⚠ É O TOTAL — vazou' : '✓ valor da parcela'}`);
    console.log(`           Linha digitável presente? ${r.pd['Linha digitável'] ? '⚠ SIM' : 'não (deletada)'}`);
}

console.log(`\n${'═'.repeat(74)}`);
console.log('VEREDITO');
console.log('═'.repeat(74));
if (!vazou) {
    console.log('\n   ✓ NENHUMA parcela recebeu o total.');
    console.log('     A linha 619 sobrescreve `Valor total` com o valor DA PARCELA,');
    console.log('     e a LD é deletada antes. A exceção age só no documento pai.');
    console.log('\n   As 30 linhas #pN que meu script apontou são ARTEFATO: ele aplicou');
    console.log('   a função a linhas já gravadas, coisa que a produção nunca faz.');
} else {
    console.log(`\n   ⚠ ${vazou} parcela(s) receberam o total da fatura. DEFEITO REAL.`);
}

// ── e o caso em que a IA não dá valor por parcela? ─────────────────────────
console.log('\n── e se a IA não souber o valor da parcela? ─────────────────');
const semValor = [
    { valor: 0, vencimento: '31/01/2026', nossoNumero: 'B1' },
    { valor: 0, vencimento: '28/02/2026', nossoNumero: 'B2' },
];
const rows2 = blocoDoCarne(decidido, semValor, NOME, 91288.49);
for (const r of rows2)
    console.log(`   ${r.arquivo.slice(-6)}  Valor total = ${r.pd['Valor total']}`);
console.log('\n   Aqui a linha 620 cai no `valorTotal` da IA (o total do carnê),');
console.log('   que é o comportamento JÁ EXISTENTE — a exceção não o alterou:');
console.log('   ela mexe em `pdComum[Valor total]`, e a linha 619-620 o ignora.');
