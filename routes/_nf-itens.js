/**
 * routes/_nf-itens.js
 * Extração dos campos fiscais pedidos em 08/09/2026: nome/nome social, CNPJ,
 * valor total, chave de acesso, CFOP, itens (descrição, unidade, valor).
 *
 * ── Por que este arquivo existe, e por que a estratégia é a que é ─────────────
 * Medido sobre 250 DANFEs reais do arquivo (`_medir/_layouts.js`, 08/09/2026):
 *
 *   chave de acesso (44 díg)   99,2%      ← determinística, já validada
 *   "VALOR TOTAL DA NOTA"      94,0%
 *   bloco "DADOS DO PRODUTO"   53,6%      ← âncora fraca
 *   cabeçalho canônico          18,0%      ← ordem de colunas previsível
 *
 * Ou seja: ancorar os itens no bloco/cabeçalho atenderia metade das notas, e
 * confiar na ORDEM das colunas atenderia menos de um quinto. Uma segunda medição
 * (`_medir/_semblo.js`) mostrou que, dos DANFEs sem o bloco, 49 de 56 AINDA têm
 * linhas com NCM + valor — o cabeçalho falta, os itens não. Só 7 de 120 (≈6%)
 * não têm âncora nenhuma.
 *
 * Daí a decisão: **classificar cada token pela sua própria forma, não pela
 * posição na coluna**. NCM tem 8 dígitos; CFOP tem 4 e começa em 1-7; a unidade
 * vem de um conjunto fechado (UN, PC, BD, L, KG...); valores têm vírgula decimal.
 * Isso sobrevive aos layouts que a amostra mostrou:
 *
 *   IGUACU   COD DESC NCM CST CFOP UN QTD UNIT TOTAL...   (canônico)
 *   BOBIG    Código NCM CFOP UND QTD UNIT ... DESCRIÇÃO   (descrição no fim)
 *   TRATORNEM  0,00 12,00 ... UN 520 84328000 DESC 5102   (linha INVERTIDA)
 *   RIO PRETO  descrição em linhas ACIMA da linha numérica
 *
 * O preço de não depender de posição é não poder distinguir com certeza valor
 * unitário de valor total quando a linha traz muitos números — por isso o valor
 * do item é escolhido por regra explícita (ver `valorDoItem`) e o resultado
 * carrega `confianca`, para o consumidor saber quando conferir.
 */
'use strict';

const { norm, chaveAcessoDoTexto, cnpjDaChaveAcesso } = require('./_nf-parsers');

// ── Unidades comerciais ──────────────────────────────────────────────────────
// Conjunto fechado do que aparece de fato nas notas da operação (combustível,
// peças, lubrificante, serviço). Serve de âncora: um token curto alfabético no
// meio de números só é unidade se estiver aqui — assim "PR" de "TELEMACO/PR"
// ou a sigla de uma marca não viram unidade.
const UNIDADES = new Set([
    'UN', 'UND', 'UNID', 'PC', 'PÇ', 'PCS', 'PECA', 'PEC',
    'CX', 'CJ', 'JG', 'KIT', 'PAR', 'PT', 'FD', 'BD', 'BB', 'GL', 'TB', 'BS',
    'KG', 'G', 'TON', 'T', 'L', 'LT', 'LTS', 'M', 'M2', 'M3', 'ML', 'MM', 'CM',
    'H', 'HR', 'HORA', 'SC', 'RL', 'RO', 'DZ', 'MIL', 'AMP', 'SERV', 'VB',
]);

// NCM/SH: exatamente 8 dígitos, sem vírgula/ponto decimal grudado (senão
// "20.500,00" e "1.023,210" entrariam).
const RE_NCM = /(?<![\d.,])(\d{8})(?![\d.,])/;

// CFOP: 4 dígitos começando em 1-7 (1/2/3 = entrada, 5/6/7 = saída). Aceita o
// ponto de "5.102" — a impressão varia. Recusa se houver vírgula decimal em
// seguida, para não capturar os 4 primeiros dígitos de "5.102,33".
const RE_CFOP = /(?<![\d.,])([1-7])[.]?(\d{3})(?![\d,])/;

// Valor monetário/quantidade no padrão brasileiro: 1.234,56 · 4,00 · 419,9000
const RE_NUM_BR = /(?<![\d.,])(\d{1,3}(?:\.\d{3})*,\d{1,6}|\d+,\d{1,6})(?![\d])/g;

const paraNumero = s => {
    const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : null;
};

const fmtBR = n => (n == null ? '' : n.toFixed(2).replace('.', ','));

// ── Identidade do emitente ───────────────────────────────────────────────────
// A NF traz DOIS blocos de identificação: o emitente e o destinatário (que aqui
// é sempre a LARSIL). Pegar "o primeiro CNPJ do texto" erra quando o boleto vem
// grudado antes do DANFE. Estratégia, em ordem de confiabilidade:
//   1. o CNPJ embutido na chave de acesso — determinístico, é o do EMITENTE;
//   2. o CNPJ rotulado que NÃO seja o do destinatário.
const RE_CNPJ = /(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/g;

const soDig = s => String(s || '').replace(/\D/g, '');

// A raiz de CNPJ da própria LARSIL. O documento é o que NÓS pagamos, então um
// CNPJ nosso lido como "emitente" é sempre erro de escopo: pegou o pagador.
const RAIZ_PROPRIA = new Set(['08420245']);

// CNPJ estruturalmente impossível — "00.000.000/0001-00" e afins aparecem em
// formulário em branco, marca d'água e rodapé de sistema.
function cnpjPlausivel(d) {
    const s = soDig(d);
    if (s.length !== 14) return false;
    if (/^0{8}/.test(s)) return false;            // raiz zerada
    if (/^(\d)\1{13}$/.test(s)) return false;     // todos os dígitos iguais
    return true;
}

const ehCnpjProprio = d => RAIZ_PROPRIA.has(soDig(d).slice(0, 8));

function cnpjDoEmitente(text, chave) {
    // 1) A chave de acesso é determinística: o CNPJ está embutido nela, e é o do
    //    EMITENTE por construção. Nada supera isso.
    const daChave = cnpjDaChaveAcesso(chave);
    if (daChave) return daChave;

    const t = norm(text);
    // 2) CNPJ rotulado ANTES do bloco do destinatário — o escopo do emitente.
    const iDest = t.search(/DESTINATARIO\s*\/?\s*REMETENTE|TOMADOR (?:DO )?SERVICO|\bPAGADOR\b|\bSACADO\b/);
    const escopo = iDest > 0 ? t.slice(0, iDest) : t;
    const m = escopo.match(/\bCNPJ[:\s/]*?(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/);
    if (m && cnpjPlausivel(m[1]) && !ehCnpjProprio(m[1])) return soDig(m[1]);

    // 3) Último recurso: o primeiro CNPJ do texto que NÃO seja o nosso e seja
    //    plausível.
    //
    // O filtro nasceu de medição (09/09/2026, `_medir/_contraditos.js`): sem ele,
    // 267 dos 410 pares com CNPJ divergente traziam a raiz 08420245 — a LARSIL —
    // no campo "CNPJ emitente". Em recibo e autorização de pagamento o único CNPJ
    // rotulado do papel é o do PAGADOR, e a varredura solta o capturava como se
    // fosse do fornecedor. Outros 4 casos gravavam "00000000000100", de formulário
    // em branco.
    //
    // Gravar o nosso CNPJ como o do fornecedor é pior que deixar vazio: o campo
    // passa a contradizer o lançamento em todo recibo, e o comparador conta isso
    // como par suspeito. Vazio é honesto — o documento não diz quem emitiu.
    RE_CNPJ.lastIndex = 0;
    const todos = t.match(RE_CNPJ) || [];
    RE_CNPJ.lastIndex = 0;
    for (const c of todos) {
        if (cnpjPlausivel(c) && !ehCnpjProprio(c)) return soDig(c);
    }
    return '';
}

// Nome / nome social (razão social) do emitente. "RECEBEMOS DE <NOME> OS
// PRODUTOS" é a frase padrão do canhoto do DANFE e nomeia sempre o emitente —
// medida como a âncora mais confiável na amostra. As demais são recuos.
function nomeDoEmitente(text) {
    const t = norm(text);
    // O canhoto é a única âncora que nomeia o emitente sem ambiguidade — mede
    // 100% de acerto nos DANFEs. As demais são recuos e passam pelo filtro.
    //
    // Aceita "RECEBEMOS DE:" (com dois-pontos) e "OS PRODUTOS E/OU SERVIÇOS":
    // sem isso a SAVANA caía no recuo do rótulo e gravava "LEGIVEL" — pedaço do
    // aviso "NÃO É DOCUMENTO LEGÍVEL" do rodapé — como razão social (achado ao
    // conferir o que foi gravado no banco, 09/09/2026).
    const canhoto = t.match(/RECEBEMOS DE[:\s]\s*(.{4,80}?)\s+OS\s+PRODUTOS/);
    if (canhoto) {
        const n = limpar(canhoto[1]);
        if (nomeAceitavel(n)) return n;
    }

    // Bloco "IDENTIFICAÇÃO DO EMITENTE": o nome vem na(s) linha(s) seguintes.
    // A extração de texto quebra razões sociais longas ("IGUACU MAQUINAS AGRICOLA"
    // + "S LTDA"), então juntamos linhas até fechar num sufixo societário.
    const linhas = text.split('\n').map(l => l.trim());
    const iEmit = linhas.findIndex(l => /IDENTIFICA[ÇC][ÃA]O DO EMITENTE/i.test(l));
    if (iEmit >= 0) {
        let acc = '';
        for (const l of linhas.slice(iEmit + 1, iEmit + 5)) {
            if (!l) continue;
            acc += (acc && !/^S\b|^A\b/.test(l) ? ' ' : '') + l;
            if (/\b(LTDA|S\/?A|S\.A|ME|EPP|EIRELI|MEI)\b\.?$/i.test(acc.trim())) break;
        }
        const n = limpar(norm(acc));
        if (nomeAceitavel(n)) return n;
    }

    const razao = t.match(/(?:NOME|RAZAO SOCIAL|NOME EMPRESARIAL)[:\s]*([A-Z0-9 .,&'-]{4,80})/);
    if (razao) {
        const n = limpar(razao[1]);
        if (nomeAceitavel(n)) return n;
    }
    return '';
}

// ── Nome social / nome fantasia ──────────────────────────────────────────────
// O pedido lista "nome" e "nome social" como campos distintos, e a NF-e de fato
// carrega os dois: `xNome` (razão social, o nome de registro) e `xFant` (nome
// fantasia, como a empresa é conhecida). Nas notas do arquivo o fantasia aparece
// de duas formas — rotulado, ou anexado à razão com barra, que é como o canhoto
// da BOBIG imprime: "BOBIG CONTATTO - EQUIPAMENTOS LTDA - ME / HIDRAUFLEX".
//
// Devolve '' quando a nota não distingue os dois. Campo vazio é resposta
// honesta: repetir a razão social no lugar do fantasia inventaria um dado que a
// nota não traz.
function nomeSocialDoEmitente(text, razaoSocial = '') {
    const t = norm(text);

    const rotulado = t.match(/(?:NOME FANTASIA|FANTASIA|NOME SOCIAL)[:\s]+([A-Z0-9 .,&'-]{3,60})/);
    if (rotulado) {
        const n = limpar(rotulado[1]);
        if (n.length >= 3 && n !== norm(razaoSocial)) return n;
    }

    // "RAZAO / FANTASIA" no canhoto: o trecho após a barra, quando é nome e não
    // continuação da razão (sufixo societário indica que a barra separou o CNPJ
    // ou o endereço, não o fantasia).
    const canhoto = t.match(/RECEBEMOS DE\s+(.{4,120}?)\s+OS\s+PRODUTOS/);
    if (canhoto && canhoto[1].includes('/')) {
        const partes = canhoto[1].split('/').map(s => limpar(s)).filter(Boolean);
        if (partes.length >= 2) {
            const ultima = partes[partes.length - 1];
            const ehNome = /^[A-Z][A-Z0-9 .&'-]{2,40}$/.test(ultima)
                && !/\b(LTDA|S\/?A|ME|EPP|EIRELI|MEI)\b/.test(ultima)
                && !/\d{3}/.test(ultima);
            if (ehNome && ultima !== norm(razaoSocial)) return ultima;
        }
    }
    return '';
}

function limpar(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.,;:\-|]+|[\s.,;:\-|]+$/g, '')
        .trim();
}

// ── Filtro do nome lido ──────────────────────────────────────────────────────
// Medido em 09/09/2026 (`_medir/_pipeline-nf.js`, 250 PDFs): sem este filtro, 60
// documentos teriam o campo `Emitente` — que o comparador usa para casar — trocado
// por lixo. As três formas de lixo, todas vistas na amostra:
//
//   RÓTULO capturado como se fosse nome:  "DO DOCUMENTO" (MULTIPLIKE, 5 arquivos),
//     "COMPLEMENTO CPF", "PEDIDO", "PRINCIPAL CODIGO TELEFONE ITAU CORRETORA DE"
//   O PRÓPRIO PAGADOR: "LARSIL FLORESTAL LTDA ENDERECO" — a âncora pegou o bloco
//     do destinatário. Casaria com qualquer lançamento nosso.
//   EMITENTE ERRADO: num contrato Daycoval com DANFE anexa, "GENERAL MOTORS DO
//     BRASIL" é o emitente da nota do veículo, não a contraparte do lançamento.
//
// Fora do DANFE as âncoras de nome não se sustentam, então o nome lido só é aceito
// quando parece razão social de verdade. Na dúvida devolve '', e o nome do arquivo
// (que é o que casa com a planilha) permanece.
const RE_LIXO_NOME = /^(DO |DA |DE |O )?(DOCUMENTO|PEDIDO|COMPLEMENTO|PRINCIPAL|CODIGO|ENDERECO|TELEFONE|NOME|RAZAO|EMITENTE|DESTINATARIO|REMETENTE|MUNICIPIO|BAIRRO|NUMERO|VALOR|DATA|SERIE|CHAVE|INSCRICAO|FONE|CEP|UF)\b/;

// Palavras que, sozinhas, denunciam que a captura invadiu o rótulo seguinte.
const RE_RABO_ROTULO = /\b(ENDERECO|COMPLEMENTO|CPF|CNPJ|TELEFONE|FONE|CEP|BAIRRO|MUNICIPIO|INSCRICAO|NOME SOCIAL|CODIGO)\b/;

// Avisos de rodapé do DANFE que a captura de nome confunde com razão social.
// "LEGIVEL" vem de "NÃO É DOCUMENTO LEGÍVEL" e foi gravado como razão social da
// SAVANA em produção antes de existir esta lista.
const RE_AVISO_RODAPE = /^(NAO |NÃO )?(E |É )?(DOCUMENTO )?(LEGIVEL|LEGÍVEL|VALIDO|VÁLIDO|CONSULTA|AUTENTICA|SEM VALOR)\b/;

function nomeAceitavel(n) {
    const s = norm(n);
    if (s.length < 4 || s.length > 70) return false;
    if (RE_LIXO_NOME.test(s)) return false;
    if (RE_RABO_ROTULO.test(s)) return false;
    if (RE_AVISO_RODAPE.test(s)) return false;
    if (/LARSIL/.test(s)) return false;              // é o pagador, não a contraparte
    if (!/[A-Z]{3}/.test(s)) return false;           // precisa ter palavra de verdade
    if (/^\d/.test(s)) return false;
    // pelo menos metade dos tokens tem de ser alfabética — "PRINCIPAL CODIGO
    // TELEFONE ITAU" passa nos testes acima mas é claramente uma varredura de
    // rótulos; a razão social real tem sufixo societário ou poucos tokens.
    const toks = s.split(' ').filter(Boolean);
    if (toks.length > 6 && !/\b(LTDA|S\/?A|S\.A|ME|EPP|EIRELI|MEI|COOPERATIVA|COMERCIO|INDUSTRIA)\b/.test(s)) return false;
    return true;
}

// ── Valor total da nota ──────────────────────────────────────────────────────
// Este campo custou três medições até o desenho ficar certo; o que se aprendeu
// determina o código abaixo (09/09/2026, sobre 300 DANFEs do arquivo):
//
// 1. O rótulo COLADO ao número — `VALOR TOTAL DA NOTA: 1.234,56` — só existe em
//    24% das notas (`_medir/_total-nf.js`). No DANFE de verdade o rótulo fica
//    numa linha de cabeçalho e os números vêm em linha separada.
//
// 2. Ler pela POSIÇÃO da coluna no cabeçalho foi medido e REPROVADO
//    (`_medir/_cabecalho-nf.js`): a extração de texto embaralha a ordem entre
//    rótulos e números. Na BOBIG a "coluna nº 5" devolvia 3,15 onde o total era
//    842,31. Contar colunas produz número errado com cara de certo — pior que
//    campo vazio.
//
// 3. Pegar o primeiro número DEPOIS do rótulo acha 40% e, à primeira vista,
//    "errava" 27 de 37 contra o valor do nome do arquivo. `_medir/_razao-nf.js`
//    mostrou que 82% dessas divergências são razão INTEIRA (999,42÷249,86 = 4;
//    4250,50÷425,05 = 10): a leitura estava certa e o NOME é que traz a parcela
//    do boleto. Total da nota e valor lançado são campos diferentes — por isso
//    nunca sobrescrevemos um com o outro.
//
// Sobra a falha real: layouts (BOBIG) onde o número seguinte ao rótulo é de
// outra coluna. Contra isso serve a soma dos itens, que é aritmética verificada
// item a item — quando ela discorda da leitura e os itens fecham entre si, a
// soma vence. Cada candidata carrega a sua ORIGEM, para o consumidor saber de
// onde veio o número em vez de receber um total anônimo.
const RE_VALOR = '([\\d.]{0,12}\\d,\\d{2})';

// Rótulos que NÃO são o total da nota, mas moram perto dele no quadro de
// impostos — se o número após o rótulo estiver logo depois de um destes, é da
// coluna errada.
const RE_ROTULO_VIZINHO = /VALOR (?:DO (?:ICMS|IPI|PIS|COFINS|FRETE|SEGURO)|TOTAL DOS PRODUTOS|APROX)|BASE DE CALCULO|OUTRAS DESPESAS|TOTAL DOS TRIBUTOS|DESCONTO/;

function porRotuloColado(t) {
    for (const re of [
        new RegExp(`VALOR TOTAL DA NOTA[:\\s]*R?\\$?\\s*${RE_VALOR}`),
        new RegExp(`TOTAL DA NOTA[:\\s]*R?\\$?\\s*${RE_VALOR}`),
        new RegExp(`VALOR TOTAL DA NF-?E[:\\s]*R?\\$?\\s*${RE_VALOR}`),
    ]) {
        const m = t.match(re);
        if (m) { const v = paraNumero(m[1]); if (v > 0) return v; }
    }
    return null;
}

// NFS-e (nota de serviço): rótulos próprios, e aqui o rótulo VEM colado ao
// número — medido em 3/3 acertos, a única estratégia com precisão de 100%.
function porRotuloServico(t) {
    for (const re of [
        new RegExp(`VALOR LIQUIDO DA NFS-?E[:\\s]*R?\\$?\\s*${RE_VALOR}`),
        new RegExp(`VALOR TOTAL DOS SERVICOS[:\\s]*R?\\$?\\s*${RE_VALOR}`),
        new RegExp(`VALOR LIQUIDO[:\\s]*R?\\$?\\s*${RE_VALOR}`),
    ]) {
        const m = t.match(re);
        if (m) { const v = paraNumero(m[1]); if (v > 0) return v; }
    }
    return null;
}

// Primeiro número após o rótulo, recusando o que estiver atrás de um rótulo
// vizinho do quadro de impostos.
function porProximidade(t) {
    const i = t.search(/VALOR TOTAL DA NOTA/);
    if (i < 0) return null;
    const depois = t.slice(i + 'VALOR TOTAL DA NOTA'.length, i + 400);
    const m = depois.match(new RegExp(RE_VALOR));
    if (!m) return null;
    if (RE_ROTULO_VIZINHO.test(depois.slice(0, m.index))) return null;
    const v = paraNumero(m[1]);
    return v > 0 ? v : null;
}

/**
 * Devolve { valor, origem } — ou { valor: null } quando nada é confiável.
 * `itens` entra como testemunha: a soma deles é aritmética conferida.
 */
function totalDaNotaComOrigem(text, itens = []) {
    const t = norm(text);
    const soma = itens.reduce((s, it) => s + (it.valorTotal || 0), 0);
    const somaVale = itens.length > 0 && soma > 0
        && itens.every(it => it.confianca === 'alta');

    const cands = [
        ['rótulo', porRotuloColado(t)],
        ['serviço', porRotuloServico(t)],
        ['proximidade', porProximidade(t)],
    ].filter(([, v]) => v != null);

    // Um candidato que bate com a soma dos itens está duplamente confirmado.
    for (const [origem, v] of cands) {
        if (somaVale && Math.abs(v - soma) <= Math.max(0.05, v * 0.01)) {
            return { valor: v, origem: `${origem} (confere com os itens)` };
        }
    }
    // Sem confirmação: a soma de itens todos verificados vence a leitura solta,
    // porque foi ela que pegou os layouts em que o rótulo aponta outra coluna.
    if (somaVale && cands.length && cands[0][0] === 'proximidade') {
        return { valor: Math.round(soma * 100) / 100, origem: 'soma dos itens' };
    }
    if (cands.length) return { valor: cands[0][1], origem: cands[0][0] };
    if (somaVale) return { valor: Math.round(soma * 100) / 100, origem: 'soma dos itens' };
    return { valor: null, origem: '' };
}

function valorTotalDaNota(text, itens = []) {
    return totalDaNotaComOrigem(text, itens).valor;
}

// ── Itens ────────────────────────────────────────────────────────────────────
// Uma linha é candidata a item quando traz um NCM e pelo menos um número com
// casas decimais. A partir daí cada token é classificado pela sua forma.

// Tokens são separados por TAB ou por 2+ espaços — dentro de uma célula a
// descrição tem espaços simples ("FILTRO DE AR"), então split(/\s+/) destruiria
// exatamente o campo que queremos.
function celulas(linha) {
    return linha.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
}

// Recuo para o layout de espaço SIMPLES, o mesmo que já obrigou o recuo da
// unidade mais abaixo. Nele a impressão não deixa 2 espaços entre coluna alguma:
//
//   "22260 SOS SALVA VIDAS 1/4X1/4 PR \t84329000 0 500 6404 PC 2,0000 25,00 50,00"
//
// `celulas()` devolve 2 células e a linha morria na guarda `cels.length < 3` de
// `extrairItensDaLinha` — mesmo trazendo NCM, CFOP, unidade e valor legíveis.
// Medido em 10/09/2026: 18 de 89 documentos fiscais sem CFOP (20,2%) eram só
// isto, 158 linhas de item descartadas — ADS, THYAGO, INOVA, MACPONTA, RPS.
//
// O corte é no primeiro token que abre a parte numérica (o NCM de 8 dígitos, ou
// um decimal), a mesma assinatura que `cortarNaParteNumerica` já usa: o que vem
// antes é a descrição, que fica INTEIRA numa célula só; o que vem depois vira uma
// célula por token. Assim a descrição com espaços sobrevive e as colunas
// numéricas passam a existir para o classificador por forma.
//
// O CEP tem 8 dígitos e passa por `RE_NCM`. Enquanto a linha de endereço tinha
// menos de 3 células ela morria na guarda; ao relaxar a divisão ela passaria a
// entrar como item. Foi medido: a linha "…PARQUE LIMEIRA AREA VII, 84269090 -
// TELEMACO BORBA" (CEP 84269-090) virava um item de R$372.000 com a descrição
// "DESTINATÁRIO", e por ser `confianca: 'baixa'` derrubava o total da nota — que
// `totalDaNotaComOrigem` recusa somar quando algum item não fecha. Daí o veto
// ficar aqui, no recuo, e não em `extrairItensDaLinha`: só este caminho abriu a
// porta, e o caminho canônico não deve mudar de comportamento.
const RE_ENDERECO = /\b(DESTINAT[ÁA]RIO|REMETENTE|EMITENTE|ROD(?:OVIA)?\.?\s|\bRUA\b|\bAV\.?\b|AVENIDA|BAIRRO|\bCEP\b)/i;

function celulasEspacoSimples(linha) {
    if (RE_ENDERECO.test(linha)) return [];
    const toks = String(linha).split(/\s+/).filter(Boolean);
    let corte = -1;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (/^\d{8}$/.test(t) || /^\d{1,3}(\.\d{3})*,\d{1,6}$/.test(t)) { corte = i; break; }
    }
    if (corte <= 0) return [];                       // sem descrição antes: nada a ganhar
    return [toks.slice(0, corte).join(' '), ...toks.slice(corte)];
}

// A quantidade é o número que multiplica: qtd × unitário ≈ total. Quando dá para
// resolver essa conta, o valor do item deixa de ser adivinhação e vira
// verificação — é o único ponto do parser com autoconferência.
function resolverPorAritmetica(nums) {
    // procura tripla (q, u, t) com q*u ≈ t, preferindo o maior t (o valor do item)
    let melhor = null;
    for (let i = 0; i < nums.length; i++) {
        for (let j = 0; j < nums.length; j++) {
            if (j === i) continue;
            for (let k = 0; k < nums.length; k++) {
                if (k === i || k === j) continue;
                const q = nums[i], u = nums[j], tot = nums[k];
                if (!(q > 0) || !(u > 0) || !(tot > 0)) continue;
                const erro = Math.abs(q * u - tot);
                if (erro > Math.max(0.02, tot * 0.001)) continue;
                if (!melhor || tot > melhor.total) melhor = { quantidade: q, unitario: u, total: tot };
            }
        }
    }
    return melhor;
}

// Sem aritmética que feche, o valor do item é o MAIOR número da linha que não é
// NCM nem CFOP. Motivo: nas linhas de item o total do produto domina os demais
// (impostos, alíquotas, descontos são frações dele). Erra em nota com desconto
// grande — por isso o item sai com confianca 'baixa' e o campo `Conferir` marcado.
function valorDoItem(nums) {
    const arit = resolverPorAritmetica(nums);
    if (arit) return { ...arit, confianca: 'alta' };
    const positivos = nums.filter(n => n > 0);
    if (!positivos.length) return null;
    return { quantidade: null, unitario: null, total: Math.max(...positivos), confianca: 'baixa' };
}

// A descrição é a célula alfabética mais longa da linha — em todos os layouts da
// amostra ela é o único campo textual extenso. Códigos de produto ("CQM20204",
// "RE198488") são curtos e/ou alfanuméricos colados, e marcas soltas ("GEDORE")
// perdem para a descrição real ("JG CH ALLEN 3/32 A 3/8").
function descricaoDaLinha(cels, usados) {
    let melhor = '';
    for (let i = 0; i < cels.length; i++) {
        if (usados.has(i)) continue;
        const c = cels[i];
        if (!/[A-Za-zÀ-ÿ]{3}/.test(c)) continue;         // precisa ter texto de verdade
        if (/^\d[\d.,\s]*$/.test(c)) continue;            // só números
        if (UNIDADES.has(norm(c))) continue;              // é a unidade
        const letras = (c.match(/[A-Za-zÀ-ÿ]/g) || []).length;
        if (letras < 3) continue;
        if (c.length > melhor.length) melhor = c;
    }
    return limpar(cortarNaParteNumerica(melhor));
}

// Quando o layout separa as colunas por espaço SIMPLES (SAVANA), a célula da
// descrição carrega o resto da linha junto: "VAN 517 K54A UP7 UN 1,0000
// 372.000,0000 10,00". Sem cortar, a descrição gravada vira a linha inteira e a
// unidade ("UN") fica escondida dentro dela — foi o que o banco mostrou.
//
// O corte é no primeiro token que abre a parte numérica: uma unidade conhecida
// seguida de número, ou um número decimal. O que vem antes é descrição; o que vem
// depois são as colunas de quantidade/valor, que já são lidas à parte.
function cortarNaParteNumerica(s) {
    const txt = String(s || '');
    const toks = txt.split(/\s+/);
    for (let i = 1; i < toks.length; i++) {
        const t = norm(toks[i]);
        const proximoEhNumero = i + 1 < toks.length && /^\d[\d.,]*$/.test(toks[i + 1]);
        if (UNIDADES.has(t) && proximoEhNumero) return toks.slice(0, i).join(' ');
        if (/^\d{1,3}(\.\d{3})*,\d{2,6}$/.test(toks[i])) return toks.slice(0, i).join(' ');
    }
    return txt;
}

function extrairItensDaLinha(linha) {
    if (!RE_NCM.test(linha)) return null;
    let cels = celulas(linha);
    // Só recua quando a divisão canônica falhou. A regra primária continua
    // valendo onde funciona; isto não a substitui, apenas cobre o layout que
    // ela não enxerga (ver `celulasEspacoSimples`).
    if (cels.length < 3) cels = celulasEspacoSimples(linha);
    if (cels.length < 3) return null;

    const usados = new Set();
    let ncm = '', cfop = '', unidade = '';

    for (let i = 0; i < cels.length; i++) {
        const c = cels[i];
        if (!ncm) {
            const m = c.match(new RegExp(`^${RE_NCM.source.replace(/^\(\?<!\[\\d.,\]\)/, '')}`));
            const mm = c.match(/^(\d{8})$/);
            if (mm) { ncm = mm[1]; usados.add(i); continue; }
            if (m && m[1]) { ncm = m[1]; usados.add(i); continue; }
        }
        if (!unidade && UNIDADES.has(norm(c))) { unidade = norm(c); usados.add(i); continue; }
    }
    // NCM/CFOP podem vir grudados em células com outros campos — varre o texto
    // inteiro da linha como recuo, respeitando o que já foi consumido.
    if (!ncm) { const m = linha.match(RE_NCM); if (m) ncm = m[1]; }
    if (!ncm) return null;

    // CFOP: procura fora do NCM já achado (o NCM tem 8 díg, não colide, mas o
    // trecho precisa ser removido para "84328000" não doar "8432").
    const semNcm = linha.replace(new RegExp(ncm, 'g'), ' ');
    const mc = semNcm.match(RE_CFOP);
    if (mc) cfop = mc[1] + mc[2];

    if (!unidade) {
        for (const c of cels) if (UNIDADES.has(norm(c))) { unidade = norm(c); break; }
    }
    // Layout de espaço simples: a unidade não é uma célula, está DENTRO dela —
    // "VAN 517 K54A UP7 UN 1,0000 372.000,0000". Procura o token de unidade que
    // vem logo antes de um número, que é a assinatura da coluna de quantidade.
    // Sem isto a unidade saía vazia nesses layouts (medido: 39,6% de cobertura).
    if (!unidade) {
        const toks = String(linha).split(/\s+/);
        for (let i = 0; i < toks.length - 1; i++) {
            if (UNIDADES.has(norm(toks[i])) && /^\d[\d.,]*$/.test(toks[i + 1])) {
                unidade = norm(toks[i]);
                break;
            }
        }
    }

    // números da linha, tirando NCM e CFOP para não entrarem como valor
    const nums = [];
    let m;
    RE_NUM_BR.lastIndex = 0;
    while ((m = RE_NUM_BR.exec(semNcm)) !== null) {
        const v = paraNumero(m[1]);
        if (v != null) nums.push(v);
    }
    if (!nums.length) return null;

    const v = valorDoItem(nums);
    if (!v) return null;

    return {
        descricao: descricaoDaLinha(cels, usados),
        ncm,
        cfop,
        unidade,
        quantidade: v.quantidade,
        valorUnitario: v.unitario,
        valorTotal: v.total,
        confianca: v.confianca,
    };
}

// Descrição em linha própria (layout RIO PRETO): quando a linha numérica não
// trouxe texto, procura para trás a linha mais próxima que seja só texto.
function descricaoVizinha(linhas, idx) {
    for (let i = idx - 1; i >= Math.max(0, idx - 8); i--) {
        const l = limpar(linhas[i]);
        if (!l || l.length < 4) continue;
        if (/\d,\d{2}/.test(l)) break;                        // já é outra linha de números
        if (/^(DADOS|C[ÓO]D|DESCRI|INFORMA|CALCULO|C[ÁA]LCULO|VALOR|BASE)/i.test(norm(l))) continue;
        const letras = (l.match(/[A-Za-zÀ-ÿ]/g) || []).length;
        if (letras >= 4) return l;
    }
    return '';
}

function extrairItens(text) {
    const linhas = String(text || '').split('\n');
    const itens = [];
    const vistos = new Set();

    for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        if (!/\d,\d{2}/.test(linha)) continue;      // sem valor não é linha de item
        const it = extrairItensDaLinha(linha);
        if (!it) continue;
        if (!it.descricao) it.descricao = descricaoVizinha(linhas, i);
        // Uma NF pode repetir o mesmo produto legitimamente (lotes distintos), mas
        // o DANFE costuma repetir a MESMA página no PDF (via + canhoto). Deduplica
        // por assinatura completa da linha.
        const chave = `${it.ncm}|${it.descricao}|${it.valorTotal}|${it.quantidade}`;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        itens.push(it);
    }
    return itens;
}

// CFOP da nota: o mais frequente entre os itens (uma NF pode misturar CFOPs —
// venda + bonificação —, e o dominante é o que descreve a operação). Recuo para
// o rótulo solto no texto quando não houve item.
function cfopDaNota(text, itens) {
    const cont = new Map();
    for (const it of itens) if (it.cfop) cont.set(it.cfop, (cont.get(it.cfop) || 0) + 1);
    if (cont.size) {
        return [...cont.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    const m = norm(text).match(/\bCFOP[:\s]*([1-7])[.]?(\d{3})\b/);
    return m ? m[1] + m[2] : '';
}

/**
 * Extrai os campos fiscais pedidos. Devolve objeto estruturado — o consumidor
 * decide como achatar para `dados_parser`.
 */
function extrairNotaFiscal(text) {
    const chave = chaveAcessoDoTexto(text);
    const itens = extrairItens(text);
    // os itens entram na decisão do total: a soma deles é a testemunha que pega
    // os layouts em que o rótulo aponta para a coluna errada (ver §total).
    const { valor: total, origem: origemTotal } = totalDaNotaComOrigem(text, itens);
    const nome = nomeDoEmitente(text);

    // Conferência: a soma dos itens deve se aproximar do total da nota. Quando
    // não fecha, ou faltou item, ou algum valor foi lido errado — o campo existe
    // para a tela poder sinalizar em vez de exibir número errado com confiança.
    const somaItens = itens.reduce((s, it) => s + (it.valorTotal || 0), 0);
    const fecha = total != null && itens.length > 0
        && Math.abs(somaItens - total) <= Math.max(0.05, total * 0.05);

    return {
        nome,
        nomeSocial: nomeSocialDoEmitente(text, nome),
        cnpj: cnpjDoEmitente(text, chave),
        valorTotal: total,
        origemTotal,
        chaveAcesso: chave,
        cfop: cfopDaNota(text, itens),
        itens,
        conferencia: {
            somaItens: somaItens || 0,
            fechaComTotal: fecha,
            itensBaixaConfianca: itens.filter(i => i.confianca === 'baixa').length,
        },
    };
}

/**
 * Versão achatada para `dados_parser` (o formato que o resto do sistema já lê).
 * Mantém as chaves existentes com os MESMOS nomes — o comparador lê
 * 'Nº da NF-e', 'Valor total da nota', 'CNPJ emitente' — e acrescenta as novas.
 */
function camposParaDadosParser(nf) {
    const d = {};
    if (nf.nome) d['Emitente'] = nf.nome;
    if (nf.nomeSocial) d['Nome social'] = nf.nomeSocial;
    if (nf.cnpj) d['CNPJ emitente'] = nf.cnpj;
    if (nf.valorTotal != null) {
        d['Valor total da nota'] = fmtBR(nf.valorTotal);
        // De onde veio o número. Medido: a mesma nota pode ter total da nota e
        // valor lançado diferentes (parcela de boleto), então quem conferir
        // precisa saber se leu um rótulo, uma soma de itens, ou ambos.
        if (nf.origemTotal) d['Origem do valor total'] = nf.origemTotal;
    }
    if (nf.chaveAcesso) d['Chave de acesso'] = nf.chaveAcesso;
    if (nf.cfop) d['CFOP'] = nf.cfop;
    if (nf.itens.length) {
        d['Itens'] = nf.itens.map(it => ({
            'Descrição': it.descricao,
            'NCM': it.ncm,
            'CFOP': it.cfop,
            'Unidade': it.unidade,
            'Quantidade': it.quantidade,
            'Valor unitário': fmtBR(it.valorUnitario),
            'Valor total': fmtBR(it.valorTotal),
            'Confiança': it.confianca,
        }));
        d['Qtd. de itens'] = String(nf.itens.length);
        if (!nf.conferencia.fechaComTotal) d['Conferir itens'] = 'soma dos itens ≠ total da nota';
    }
    return d;
}

module.exports = {
    extrairNotaFiscal, camposParaDadosParser,
    extrairItens, valorTotalDaNota, totalDaNotaComOrigem,
    nomeDoEmitente, nomeSocialDoEmitente, cnpjDoEmitente, cfopDaNota,
    UNIDADES, RE_NCM, RE_CFOP,
};
