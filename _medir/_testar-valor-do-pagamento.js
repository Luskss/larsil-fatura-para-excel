/**
 * _medir/_testar-valor-do-pagamento.js — bateria de casos do módulo novo.
 *
 * Roda ANTES de ligar o módulo no pipeline. Os casos vêm todos de documentos reais
 * vistos nesta sessão, incluindo os que quebraram as versões anteriores da âncora.
 *
 * Um conserto que passa no caso que o motivou mas quebra o vizinho já aconteceu duas
 * vezes aqui — daí a bateria em vez de um teste só.
 */
'use strict';
const h = require('./harness');
const V = require('../routes/_valor-do-pagamento');

let ok = 0, falhou = 0;
function caso(nome, real, esperado) {
    const bate = JSON.stringify(real) === JSON.stringify(esperado);
    if (bate) ok++; else falhou++;
    console.log(`   ${bate ? '✓' : '✗ FALHOU'}  ${nome}`);
    if (!bate) console.log(`        esperado=${JSON.stringify(esperado)}  real=${JSON.stringify(real)}`);
}

console.log('ÂNCORA — acha o valor ao lado do número da fatura\n');

// Real: 075.DOC- 125,00 ... BIOS NET . FT 242502.pdf
caso('boleto BIOS NET 242502 → 125,00',
    V.valorPelaAncora(
        'Data Doc Número Doc Valor do documento 11/10/25 242502 125,00 ' +
        'Instruções de pagamento Após o vencimento cobrar juros de R$ 0,04 ao dia. ' +
        'Após o vencimento cobrar multa de R$ 2,50.', '242502'),
    125);

// Real: 058.DOC- 75,00 ... BIOSNET. FT 245612.pdf
caso('boleto BIOS NET 245612 → 75,00',
    V.valorPelaAncora(
        'Número Doc 245612 Beneficiário BIOS NETWORKS 05.881.177/0001-68 ' +
        '74891.12529 04760.007288 18008.931075 2 13530000007500 Vencimento 10/02/26 ' +
        'Data Doc Número Doc Valor do documento 11/11/25 245612 75,00 ' +
        'cobrar juros de R$ 0,02 ao dia. cobrar multa de R$ 1,50.', '245612'),
    75);

// A trava de encargo: sem ela a resposta seria 1,70 (juros)
caso('não pega JUROS logo após o número',
    V.valorPelaAncora(
        'Número Doc 728001 Após o vencimento cobrar juros de R$ 1,70 ao dia ' +
        'Valor do documento 728,00', '728001'),
    728);

// A trava de piso: 0,08 é <1% do maior valor
caso('não pega valor irrisório (piso de 1%)',
    V.valorPelaAncora('Doc 910203 R$ 0,08 ... Valor do documento 236,31', '910203'),
    236.31);

caso('número colado em dígitos (linha digitável) é ignorado',
    V.valorPelaAncora('74891125290476000728818008931075213530000007500 1.234,56', '007288'),
    null);

caso('número curto demais não ancora',
    V.valorPelaAncora('Doc 12 valor 999,00', '12'), null);

caso('número ausente do texto → null (não inventa)',
    V.valorPelaAncora('Valor do documento 500,00', '999999'), null);

caso('texto vazio → null',
    V.valorPelaAncora('', '242502'), null);

// REGRESSÃO — achados na validação do pipeline (_depurar-perdas-pipeline.js)

// Sem `(?<![\d.,])` a regex casava o SUFIXO: "1653,04" devolvia 653,04.
caso('não lê SUFIXO de número sem separador de milhar',
    V.valorPelaAncora('Número Doc 152197 Valor do documento 1653,04', '152197'),
    1653.04);
caso('RE_MOEDA casa o número INTEIRO, não o sufixo',
    '1653,04'.match(V.RE_MOEDA), ['1653,04']);
caso('RE_MOEDA ainda casa com separador de milhar',
    'valor 1.653,04 total'.match(V.RE_MOEDA), ['1.653,04']);

// O "901512" do nome era a ORDEM DE COMPRA; a janela caiu na tabela de materiais.
caso('número que é ORDEM DE COMPRA não ancora',
    V.valorPelaAncora(
        '901512 PROJETO: Observações : SOLICITANTE: DEPTO: Código Material UND ' +
        'Qtde Valor IPI ICMS Data Entrega 653,04 Unit.', '901512'),
    null);

caso('mesmo número, mas rotulado como documento, ancora',
    V.valorPelaAncora('Número Doc 901512 Valor do documento 1.653,04', '901512'),
    1653.04);

console.log('\nPRECEDÊNCIA — quando a âncora não age\n');

caso('boleto MENOR que a nota vence (pacote +BOL)',
    V.valorPorPrecedencia({ 'Valor total da nota': '3.220,00', 'Valor do boleto': '805,00' }),
    { valor: 805, origem: 'boleto' });

// Real: 004.DOC- 78,09 ... SENATRAN — boleto 130,16 é multa, não parcela
caso('boleto MAIOR que a nota NÃO vence',
    V.valorPorPrecedencia({ 'Valor total da nota': '78,09', 'Valor do boleto': '130,16' }),
    { valor: 78.09, origem: 'valor total da nota' });

caso('sem boleto, Valor total vence',
    V.valorPorPrecedencia({ 'Valor total da nota': '11.960,00', 'Valor total': '3.986,66' }),
    { valor: 3986.66, origem: 'valor total' });

caso('só a nota → usa a nota',
    V.valorPorPrecedencia({ 'Valor total da nota': '1.500,00' }),
    { valor: 1500, origem: 'valor total da nota' });

caso('nada numérico → null',
    V.valorPorPrecedencia({ 'Emitente': 'FULANO' }), { valor: null, origem: null });

console.log('\nNÚMERO BRASILEIRO — a forma vem do ÚLTIMO separador\n');
caso('17.904,40 → 17904.4', V.paraNumero('17.904,40'), 17904.4);
caso('1.170,00 → 1170',     V.paraNumero('1.170,00'), 1170);
caso('R$ 75,00 → 75',       V.paraNumero('R$ 75,00'), 75);
caso('749000 → 749000',     V.paraNumero('749000'), 749000);
caso('zero → null',         V.paraNumero('0,00'), null);
caso('vazio → null',        V.paraNumero(''), null);

console.log('\nAPLICAÇÃO — o que fica gravado na linha\n');

{
    const pd = { 'Valor total': '1.170,00', 'Nº da NF-e': '242502' };
    const out = V.decidirValorPago(pd, {
        text: 'Data Doc Número Doc Valor do documento 11/10/25 242502 125,00',
        numeroDoNome: '242502',
    });
    caso('âncora sobrescreve e preserva o anterior',
        [out['Valor total'], out['Valor total da nota'], out['Origem do valor pago']],
        ['125,00', '1170,00', 'âncora do nº da fatura']);
    caso('não muta o objeto original', pd['Valor total'], '1.170,00');
}

{
    const out = V.decidirValorPago(
        { 'Valor total da nota': '3.220,00', 'Valor do boleto': '805,00' }, {});
    caso('sem âncora, usa precedência',
        [out['Valor total'], out['Origem do valor pago']], ['805,00', 'boleto']);
}

{
    const pd = { 'Emitente': 'X' };
    caso('linha sem valor fica intacta', V.decidirValorPago(pd, {}), pd);
}

console.log(`\n── ${ok} passaram, ${falhou} falharam ──`);
process.exit(falhou ? 1 : 0);
