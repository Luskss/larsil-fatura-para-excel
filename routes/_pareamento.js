/**
 * routes/_pareamento.js
 * Casa lançamento da planilha × documento da pasta.
 *
 * A rota `comparar-notas.js` conta três fontes independentes e não casa nada —
 * por decisão de 14/08/2026, para reconstruir a conferência com chão firme. Este
 * módulo devolve o passo seguinte: quantos lançamentos têm, de fato, um documento
 * arquivado. Ele é aditivo — não altera nenhuma das três contagens.
 *
 * A REGRA e as constantes abaixo saíram de medição, não de intuição
 * (TIPOS-IGNORADOS-COMPARADOR.md §10, jan–jun/2026, 3.113 lançamentos × 3.132 PDFs):
 *
 *   estratégia                          pares  cobertura  confirmado por 2º campo
 *   só valor                            1.037     33,3%      774 (74,6%)
 *   valor OU (número E entidade)        1.143     36,7%      880 (77,0%)   <- domina
 *   ...com veto de data no caminho fraco 1.121     36,0%      878 (78,0%)  <- aplicada
 *
 * Casar só por VALOR erra muito: 263 dos 1.037 pares (25,4%) tinham entidade E
 * número discordando — BIOS NETWORKS casada com documento de VINICIUS, LOCALIZA
 * FLEET com ALESSANDRO PEREIRA. Valores redondos (R$ 1.000, R$ 1.500) colidem o
 * tempo todo.
 *
 * Exigir número E entidade juntos, como caminho alternativo ao valor, recupera 106
 * pares que o valor sozinho perde — são boletos com desconto ou retenção, em que a
 * NF e o fornecedor batem mas o valor não: ARPSEG NF 517 (planilha R$ 827,00 ×
 * boleto R$ 797,93), IMPERIUS NF 2182 (R$ 900,00 × R$ 881,98).
 *
 * O veto de data (JANELA_DIAS) vale SÓ para o par sustentado apenas por valor —
 * o caminho fraco. Como filtro geral a data só custa cobertura (≤7d derruba de
 * 36,7% para 25,4%); aplicada só ao caminho fraco, corta 8% dos suspeitos de graça.
 *
 * NÃO usa CNPJ. Ele separaria as 21 colisões de número medidas em §10.6, mas só
 * como evidência NEGATIVA (rejeitar um par), e o comparador nunca teve evidência
 * negativa — é mudança de política, que precisa de medição própria.
 *
 * A medição foi feita em 02/09/2026 e REPROVOU o veto por CNPJ — ver §11 de
 * TIPOS-IGNORADOS-COMPARADOR.md. O CNPJ que o OCR extrai não identifica o
 * fornecedor de forma confiável: em recibo e consórcio ele traz o do pagador ou o
 * da administradora, vem com dígito trocado (JOSE ROZAO ...849 × ...949), ou é
 * um CNPJ de outro anexo do mesmo PDF (recibo da FERNANDA com CNPJ da Copasa).
 * O veto custava 61 pares bons, quase todos de força 3. Ficou de fora.
 *
 * O que a mesma medição APROVOU foi usar o OCR para PREENCHER o que falta no nome
 * do arquivo (`enriquecerComOcr` abaixo): +48 pares e precisão de 88,9% para
 * 90,9% ao mesmo tempo — sem trade-off, o mesmo critério que escolheu a regra
 * principal.
 */
'use strict';

// Distância máxima, em dias, entre a data do documento e a do lançamento, exigida
// APENAS quando o par se apoia somente no valor. Medido: 15 dias corta 20 dos 263
// pares suspeitos custando 22 pares bons; 7 dias corta 70 mas custa 118.
const JANELA_DIAS = 15;

// Tolerância de centavos na comparação de valor (evita ruído de arredondamento).
const TOL_VALOR = 0.005;

// Mínimo de dígitos para um número servir de chave.
//
// Era 3, pelo raciocínio de que "1" ou "12" casaria com quase tudo. O raciocínio
// vale para o número SOZINHO — mas aqui ele nunca é usado sozinho: `casa()` exige
// (número E entidade), e o caminho por valor não olha número. Com o fornecedor
// junto, o risco de colisão de um número curto é outro.
//
// O piso de 3 escondia um defeito real: NF de 1-2 dígitos (6,6% dos lançamentos —
// 206 em jan–jun/2026) NUNCA casava por número, mesmo com o número idêntico no
// papel e na planilha. AGRO AIR NF 52, JUNIOR LOCACOES NF 69, G CORPORI NF 60 —
// todos caíam no caminho fraco (só valor) e eram vetados pela janela de 15 dias.
//
// Medido em 02/09/2026 baixando o piso para 2: +32 pares (1.982 → 2.014) e
// precisão SUBINDO junto (90,9% → 91,3%). Os 34 pares ganhos são todos de força
// 3 ou 4; os 2 perdidos eram colisão por valor (MONT KOYA casada com documento da
// BRV). Ver TIPOS-IGNORADOS-COMPARADOR.md §13.
//
// Baixado para 1 em 03/09/2026 (§19): +2 pares e a precisão se mantém em 91,5%.
// O ganho é pequeno porque NF de 1 dígito é rara, mas o piso não tem defesa
// própria — quem protege da colisão é `casa()`, que nunca usa o número sozinho
// (exige entidade OU valor junto). DARCI FERREIRA "NFS 2" era o caso típico:
// número idêntico no papel e na planilha, descartado por ter um dígito só.
const MIN_DIGITOS_NUM = 1;

// Mínimo de letras para um token de entidade valer. Com 4, "ROSA" vira prefixo de
// "ROSANE" e casa todo sobrenome da base (medido em PROGRESSO §4).
const MIN_LETRAS_TOKEN = 4;

const DIA_MS = 86400000;

// Ruído de nomenclatura: rótulo de documento, forma jurídica e palavra de processo.
// Nenhum deles identifica fornecedor, e todos aparecem em quase todo nome de arquivo.
const STOP = new Set([
    'DOC', 'CPV', 'PDF', 'NF', 'NFS', 'NFSE', 'NFE', 'RC', 'RCB', 'FT', 'FAT', 'DANFE',
    'BOL', 'BOLETO', 'DEB', 'AUT', 'PGTO', 'PAGTO', 'LARSIL',
    'DA', 'DE', 'DO', 'DOS', 'DAS', 'E', 'LTDA', 'SA', 'ME', 'EPP',
]);

const deacc = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');

// Normalização PRÓPRIA deste módulo, com remoção de acento. O `norm()` da rota não
// remove acento e alimenta as contagens — mexer nele mudaria número de card. Aqui a
// comparação precisa de acento removido: 489 entidades da planilha têm acento e o
// nome do arquivo é digitado à mão (PROGRESSO §9).
const normCmp = s => deacc(s).toUpperCase().replace(/\s+/g, ' ').trim();

const soDigitos = s => String(s || '').replace(/\D/g, '');

// ── Extração do NOME do arquivo ─────────────────────────────────────────────
// Quem arquiva nomeia o PDF com valor, data, fornecedor e (em 87% dos casos) o
// número do documento. Medido: valor em 98,8%, entidade em 99,3%, número em 87,2%.

// Valor: primeiro número depois de ".DOC-", tolerando "R$" e milhar com ponto.
// A ordem das alternativas importa — "166.960,86" tem que casar antes de "166".
//
// A terceira alternativa (valor sem centavos) exige grupos de 3 dígitos para o
// milhar. Sem isso ela era `(\d+)`, que PARA no primeiro ponto: "12.500" lia 12,
// "1.320.000" lia 1. E o estrago não é perder o par — é casar o errado: o
// documento entrava no pareamento com um valor falso e pequeno, colidindo com
// qualquer lançamento daquele valor (a colisão de valor redondo que o cabeçalho
// deste módulo descreve como o principal modo de falha). Por ser pequeno, o valor
// falso também escapava de `divergenciasDeValor`, que ordena pela diferença
// absoluta — o par errado ficava invisível nas duas telas.
//
// O `(?![\d,])` impede que esta alternativa morda a parte inteira de um valor COM
// centavos: as duas primeiras já tratam esse caso, e sem a trava "1.234,56" cairia
// aqui como 1.234 se a ordem mudasse.
//
// É uma correção DEFENSIVA, e a medição diz isso com todas as letras: em
// jan–jun/2026 nenhum dos 4.238 documentos usa milhar sem centavos, então o
// conserto move ZERO par hoje. O defeito era real e demonstrável, mas o padrão
// ainda não apareceu no acervo — quem escreve "1.320.000" em vez de
// "1320000,00" no nome é raro. Fica pelo custo assimétrico: a linha é barata e
// o modo de falha (valor falso e pequeno casando por colisão, invisível no card
// de divergências) é caro.
// A DATA no início do nome era lida como VALOR. Medido em 11/09/2026
// (`_medir/_auditar-caminho-pdf.js`, invariante B): 19 dos 15.982 PDFs do acervo
// entravam no pareamento com o ANO como gabarito —
//
//   "001.DOC- 2026.01.02. 17.904,40 -PAGTO FINANC VEIC 3148.pdf"  → R$ 2.026
//   "001.DOC- 2026.01.26- R$ 165.903,28. GIRO PEAC - FGI.pdf"     → R$ 2.026
//
// A 4ª alternativa casa "2026" porque seu lookahead `(?=\s*[-.\s])` aceita o PONTO
// da data, e o guarda de 8 dígitos não pega "2026.01.02" (tem separadores).
//
// O dano não é só perder par: o gabarito corrompido CONTAMINA a trava da visão.
// `conferirValor` compara a leitura boa (165.903,28) contra 2.026, marca `diverge`
// e descarta o valor certo como "não confere com o nome" — o valor real do
// documento deixa de ser gravado.
//
// O conserto REMOVE o trecho da data e segue procurando, em vez de desistir:
// descartar devolveria `null` e trocaria gabarito errado por gabarito nenhum,
// perdendo o par. O sufixo `[.\-\s]*` cobre as três formas de separador que o
// acervo usa depois da data ("2026.01.02. 17.904,40", "2026.01.26- R$ ...",
// "2026.02.02 - 8.099,99").
//
// MEDIDO em 03.2026 (`_medir/_efeito-conserto-gabarito.js`): 397 pares antes e
// depois, 0 perdidos, 0 trocados — corrige o gabarito sem mexer no casamento.
const RE_DATA_PREFIXO = /(\.DOC-?\s*)(?:R\$\s*)?20\d{2}[.\-]\s*\d{1,2}[.\-]\s*\d{1,2}[.\-\s]*/i;

function valorDoNome(nome) {
    const n = String(nome || '').replace(RE_DATA_PREFIXO, '$1 ');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+)(?![\d,])/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+)(?=\s*[-.\s])/i);
    if (!m) return null;
    // "20260102" é data lida como valor — 8 dígitos sem centavos não é dinheiro aqui.
    if (/^\d{8}$/.test(m[1])) return null;
    const v = Number(m[1].replace(/\./g, '').replace(',', '.'));
    return isFinite(v) && v > 0 ? v : null;
}

// Número rotulado: "NFS 818325", "RC 898303", "FT22098119", "NF 517".
// Só com rótulo — número solto no nome é data, telefone ou nº de série.
function numeroDoNome(nome) {
    const m = String(nome || '').match(/\b(?:NFS?E?|RCB?|FT|FAT|DANFE)\s*\.?\s*(\d{2,12})\b/i);
    return m ? m[1] : null;
}

// Data no nome: YYYY.MM.DD ou DD.MM.YYYY. Devolve epoch ms (UTC) ou null.
//
// O separador é `.` OU `-`, e os dois podem se misturar no mesmo nome — quem
// arquiva digita à mão. Antes só o ponto era aceito, e 67 dos 4.238 documentos
// (1,6%) ficavam sem data por causa disso: 63 com a data toda em hífen
// ("...-2026-01-07-ERICLEIA..."), 2 com separador misto ("2026.01-19", os dois
// papéis do maço MACPONTA) e 2 em DD-MM-YYYY.
//
// Ficar sem data não é neutro: `distanciaDias` devolve null, e `dentroDaJanela`
// então retorna true incondicionalmente — o veto de 15 dias DESLIGA em silêncio
// justamente para esses arquivos. Era o caso do documento de R$ 1,32 milhão da
// MACPONTA, que assim podia casar por valor com um lançamento de qualquer mês.
//
// Os 163 restantes sem data no nome não têm conserto aqui (não trazem data
// nenhuma: "049.DOC- 23053,79.MARCOS CONSORCIOS CAIXA.pdf"); para eles a data
// continua vindo do OCR (`dtEmissao`) ou fica nula mesmo.
const SEP_DATA = '[.\\-]';
function dataDoNome(nome) {
    const n = String(nome || '');
    let m = n.match(new RegExp(`(?<!\\d)(20\\d{2})${SEP_DATA}(\\d{2})${SEP_DATA}(\\d{2})(?!\\d)`));
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = n.match(new RegExp(`(?<!\\d)(\\d{2})${SEP_DATA}(\\d{2})${SEP_DATA}(20\\d{2})(?!\\d)`));
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return null;
}

// Data da SUBPASTA-DIA ("2026.01.05" no caminho). É criada pelo processo de
// arquivamento, não digitada — o mesmo raciocínio que fez `mesDoDocumento` (na
// rota) preferir a pasta para decidir o MÊS, em §15.
function dataDaPasta(rel) {
    const r = String(rel || '');
    let m = r.match(/(?:^|[/\\])(20\d{2})\.(\d{2})\.(\d{2})(?:[/\\]|$)/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = r.match(/(?:^|[/\\])(\d{2})\.(\d{2})\.(20\d{2})(?:[/\\]|$)/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return null;
}

// A partir de quantos dias de discordância a pasta corrige o nome. Ver a medição
// abaixo: acima de 90 dias tudo é erro de ano; abaixo de 30, tudo é diferença
// legítima entre a data do documento e o dia do pagamento. 60 fica no vale vazio
// entre as duas populações, longe de ambas.
const DIAS_DISCORDANCIA_GROSSA = 60;

/**
 * A data do documento, resolvendo nome × pasta.
 *
 * §15 corrigiu o MÊS para vir da pasta (`mesDoDocumento`, na rota), mas a DATA
 * usada pelo pareamento continuou saindo só do nome — então o veto de janela
 * rodava contra uma data que a própria rota já sabia estar errada. Este é o outro
 * lado daquela correção.
 *
 * A precedência NÃO é a mesma de `mesDoDocumento`, e a medição é que diz por quê.
 * Dos 4.238 documentos de jan–jun/2026, todos têm data na pasta e 4.064 no nome;
 * os 794 em que discordam se separam em duas populações que não se tocam:
 *
 *   0-2 dias    616   diferença LEGÍTIMA: a pasta é o dia do pagamento, o nome é
 *                     a data do documento. Aqui o nome é a informação melhor.
 *   3-30 dias    81   idem, prazo de boleto
 *   31-60 dias   13
 *   61-90 dias    7
 *   91+ dias     77   ERRO DE DIGITAÇÃO: todos com o ANO trocado (nome "2025.01.05"
 *                     na pasta "2026.01.05"), dia e mês idênticos. Não é documento
 *                     antigo — é o dedo escorregando no ano na virada.
 *
 * Por isso: o nome manda (preserva os 616 legítimos), a pasta entra como RESERVA
 * quando o nome não traz data (174 documentos, que hoje ficam sem data e portanto
 * sem veto de janela) e como CORRETOR quando a discordância é grossa (os 77 do
 * ano trocado). Trocar a precedência inteira pioraria 700 casos para consertar 77.
 */
function dataDoDocumento(nome, rel) {
    const dn = dataDoNome(nome);
    const dp = dataDaPasta(rel);
    if (dn == null) return dp;
    if (dp == null) return dn;
    return Math.abs(dn - dp) / DIA_MS > DIAS_DISCORDANCIA_GROSSA ? dp : dn;
}

// Tokens que identificam o fornecedor, vindos de um texto livre (nome de arquivo
// ou campo da planilha). Descarta rótulo, forma jurídica e pedaço puramente numérico.
function tokens(texto) {
    const out = new Set();
    for (const t of normCmp(String(texto || '').replace(/\.pdf$/i, '')).split(/[^A-Z0-9]+/)) {
        if (t.length < MIN_LETRAS_TOKEN) continue;
        if (!/[A-Z]/.test(t)) continue;       // "202601" não é nome
        if (/^\d+$/.test(t)) continue;
        if (STOP.has(t)) continue;
        out.add(t);
    }
    return out;
}

const compartilhaToken = (a, b) => {
    for (const t of a) if (b.has(t)) return true;
    return false;
};

// ── Identidade de ARQUIVAMENTO: a pasta-dia e o prefixo "NNN" ───────────────
// Quem arquiva numera os pagamentos do dia (001, 002, …) e grava TODOS os papéis
// daquele pagamento com o mesmo prefixo, na mesma pasta-dia:
//
//   031.DOC- 1320000,00 ... MACPONTA PEDIDO 11352045- PROPOSTA ... + PV.pdf
//   031.DOC- 1320000,00 ... MACPONTA.pdf           <- a nota escaneada
//   031.CPV.pdf                                    <- o comprovante (fora do escopo)
//
// Os dois primeiros são o MESMO pagamento visto por dois papéis. O pareamento
// consome um documento por lançamento (e deve continuar assim: um lançamento tem
// um par), mas o que sobra não é órfão — é o resto do maço. `parear` usa esta
// chave, no fim, para reconhecê-los sem tocar em como o par é escolhido.
const prefixoDoNome = nome => {
    const m = String(nome || '').match(/^\s*(\d+)\s*\./);
    return m ? String(Number(m[1])) : null;   // "031" e "31" são o mesmo maço
};

// A pasta-dia é o diretório que contém o arquivo — o `rel` traz o caminho inteiro.
const pastaDoCaminho = rel => {
    const s = String(rel || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i < 0 ? '' : s.slice(0, i);
};

/**
 * Descreve um documento da pasta a partir do nome do arquivo.
 * @param {string} nome  nome do PDF, como está no disco
 * @param {string} [rel] caminho relativo, só para exibição
 */
function documentoDoArquivo(nome, rel) {
    const caminho = rel || nome;
    const pref = prefixoDoNome(nome);
    return {
        arquivo: nome,
        caminho,
        valor: valorDoNome(nome),
        numero: numeroDoNome(nome),
        numeroDig: soDigitos(numeroDoNome(nome)),
        // Nome com a pasta como reserva e como corretor — ver `dataDoDocumento`.
        data: dataDoDocumento(nome, caminho),
        tokens: tokens(nome),
        // Chave do maço: só existe quando há prefixo. Sem ela o documento nunca é
        // agrupado como irmão — é o comportamento seguro.
        maco: pref == null ? null : `${pastaDoCaminho(caminho)}|${pref}`,
    };
}

// ── Enriquecimento pelo OCR ─────────────────────────────────────────────────
// O nome do arquivo é digitado à mão por quem arquiva, e erra: "ARPESEG" por
// ARPSEG, "SKILLUB" por SKILLHUB, "T. M. J." por T.J.M., "ACITEL" pela razão
// social inteira. O scheduler JÁ extraiu do miolo do PDF o emitente, o número e o
// valor, e gravou em nfs.RELATORIOS_CONFERENCIA — evidência que estava ali e o
// pareamento ignorava.
//
// O nome do arquivo tem PRECEDÊNCIA: o OCR só preenche o campo que o nome não
// trouxe, e acrescenta os tokens do emitente aos que já existem. Assim nenhum par
// que o motor já fazia se perde por causa de um OCR ruim — medido: dos 1.934 pares
// do baseline, nenhum sumiu por conflito; os 15 que mudaram trocaram documento
// errado por documento certo.
//
// Emitente "LARSIL" é descartado: em recibo, consórcio e boleto de administradora
// o emitente lido é o PAGADOR (nós), e casaria com qualquer lançamento nosso.
const ehEmitenteProprio = t => /LARSIL/i.test(String(t || ''));

/**
 * Devolve uma cópia do documento com os campos que o OCR souber preencher.
 * @param {object} doc  saída de documentoDoArquivo
 * @param {object} ocr  { numero, emitente, valor, dtEmissao } — pode ser null
 */
function enriquecerComOcr(doc, ocr) {
    if (!ocr) return doc;
    const d = { ...doc };

    // O EXTRATOR é a fonte primária do número (03/09/2026, §19). Antes o nome tinha
    // precedência e o número do OCR só entrava se o nome não trouxesse nenhum.
    //
    // O nome do arquivo é digitado à mão a partir do papel, e erra: nos 523
    // documentos em que as duas fontes discordam, a inversão troca 50 pares de
    // documento e 32 deles ficam MAIS fortes contra 4 mais fracos. O caso limpo é o
    // BIOS NETWORKS, uma série de faturas de valor igual (R$ 75, R$ 95, R$ 125) em
    // que só o número distingue uma da outra: o nome traz `FT 245923` para a nota
    // 245924, `FT 245650` para a 252287 — e o motor casava a fatura errada, com
    // valor e fornecedor certos. Com o extrator na frente, cada uma cai na sua.
    //
    // O número do nome NÃO é descartado: vira `numeroAlt`, que `numeroBate` testa
    // igual. Assim nenhum par sustentado pelo nome se perde por conflito.
    const nNome = d.numeroDig;
    if (ocr.numero) {
        const n = soDigitos(ocr.numero);
        if (n.length >= MIN_DIGITOS_NUM) {
            d.numeroDig = n;
            d.numero = n;
            if (nNome && nNome !== n) d.numeroAlt = nNome;
        } else if (nNome) {
            d.numeroAlt = d.numeroAlt || null;
        }
    }

    // VALOR e EMITENTE: o extrator também vem antes, pelo mesmo motivo — são lidos
    // do documento, não digitados. O valor do nome fica como `valorAlt` porque as
    // duas leituras divergem LEGITIMAMENTE numa parcela: o nome traz o valor PAGO
    // (copiado do comprovante) e o extrator o valor da NOTA. Descartar um dos dois
    // custa 7 pares; manter os dois preserva a cobertura.
    if (ocr.valor != null && ocr.valor > 0) {
        if (d.valor != null && d.valor !== ocr.valor) d.valorAlt = d.valor;
        d.valor = ocr.valor;
    }

    // RETENÇÃO NA FONTE: numa NFS-e com imposto retido o papel tem dois valores, e
    // a planilha lança o BRUTO enquanto o extrator costuma ler o LÍQUIDO (é ele que
    // o boleto cobra). Foi o que fez a CORREA TRUCK HOUSE NF 377 aparecer como
    // divergência de R$ 184,50 — o ISSRF retido.
    //
    // `retencaoDoParser` (comparar-notas.js) só devolve isto quando a aritmética
    // FECHA no próprio papel (bruto − retenções = líquido), então aqui o bruto é um
    // número conferido, não uma leitura solta: pode assumir o valor de casamento.
    // O líquido não se perde — vira `valorAlt`, e `valorBate` testa os dois, para
    // o par continuar valendo quando a planilha lançar o valor pago.
    if (ocr.retencao && ocr.retencao.bruto > 0) {
        const { bruto, liquido } = ocr.retencao;
        if (d.valor != null && d.valor !== bruto) d.valorAlt = d.valor;
        d.valor = bruto;
        d.valorLiquido = liquido;
        d.valorRetido = ocr.retencao.retido;
    }

    // A DATA é a exceção: continua vindo do nome/pasta. Ela não descreve o
    // documento, posiciona-o no mês certo para a busca (§15/§16) — `dtEmissao` do
    // OCR é a data de emissão da nota, que é outra coisa.
    if (d.data == null && ocr.dtEmissao != null) d.data = ocr.dtEmissao;

    // A emissão LIDA DA NOTA, em campo próprio. Não entra em `d.data` (que é a data
    // de ARQUIVAMENTO e posiciona o documento no mês) nem em sinal de casamento
    // nenhum: serve só para CONFERIR o par depois de feito.
    //
    // MEDIDO em 15/09/2026 (`_medir/_data-como-sinal.js`), jan–jun, 2.108 pares: a
    // emissão do documento e a da planilha coincidem em 70,7% dos pares de força 3 e
    // em 3,3% dos de força 1 — razão de 20×. Ela separa par bom de par duvidoso
    // melhor que qualquer outro campo disponível.
    //
    // NÃO vira 4º sinal: isso foi medido em `_medir/_data-quarto-sinal.js` e
    // REPROVADO (−4 pares bons, +2 duvidosos). Somar força a quem TEM o campo
    // penaliza o documento cuja emissão não foi lida, e a ausência de dado virava
    // desvantagem competitiva — o par de força 3 perdia para o de força 2.
    if (ocr.dtEmissao != null) d.dtEmissaoDoc = ocr.dtEmissao;

    if (ocr.emitente && !ehEmitenteProprio(ocr.emitente))
        d.tokens = new Set([...d.tokens, ...tokens(ocr.emitente)]);
    if (ocr.tipo) d.tipo = String(ocr.tipo);
    // Só exibição (CFOP/Itens/valor da nota/código da receita) — não influencia
    // casamento nenhum, é carregado para a tela mostrar ao clicar na nota.
    if (ocr.detalhe) d.detalhe = ocr.detalhe;
    return d;
}

/**
 * Descreve um lançamento da planilha.
 * @param {{nf, entidade, fantasia, valor, dtLancamento, dtEmissao}} l
 */
function lancamentoDaPlanilha(l) {
    return {
        nf: l.nf,
        entidade: l.entidade,
        cnpj: l.cnpj || '',
        // O `Math.abs` NÃO é para tratar estorno — é o que faz o comparador
        // funcionar. Medido em 08/09/2026: 3.034 dos 3.057 lançamentos de
        // jan–jun/2026 (99,2%) são NEGATIVOS. É a convenção de sinal da planilha,
        // em que despesa a pagar é lançada com sinal negativo; o documento traz o
        // valor absoluto. Os 23 positivos são todos lançamento de conta bancária
        // (`CC.LAR.SAN.PR.8875.CORRENTE`), não fornecedor.
        // Tirar o abs daqui zeraria o pareamento inteiro.
        valor: Math.abs(Number(l.valor) || 0),
        nfDig: soDigitos(l.nf),
        // FANTASIA entra junto: a planilha lança pela razão social e o arquivista
        // escreve o nome fantasia ("CAMPNEUS" por "CAMPOS PNEUS").
        tokens: new Set([...tokens(l.entidade), ...tokens(l.fantasia)]),
        dtLancamento: l.dtLancamento || null,
        dtEmissao: l.dtEmissao || null,
    };
}

// ── Os três sinais ──────────────────────────────────────────────────────────
// `valorAlt` é o valor do NOME do arquivo quando o extrator leu outro: o nome traz
// o valor PAGO e o extrator o da NOTA, que numa parcela diferem legitimamente.
// Os dois valem como evidência — ver `enriquecerComOcr`.
const valorBate = (l, d) =>
    l.valor > 0 && (
        (d.valor != null && Math.abs(l.valor - d.valor) < TOL_VALOR) ||
        (d.valorAlt != null && Math.abs(l.valor - d.valorAlt) < TOL_VALOR));

const numeroBate = (l, d) => {
    if (l.nfDig.length < MIN_DIGITOS_NUM) return false;
    // `numeroAlt` é o número que o OCR leu quando difere do que está no nome —
    // o nome às vezes traz o "nosso número" do boleto em vez da NF.
    for (const cand of [d.numeroDig, d.numeroAlt]) {
        if (!cand || cand.length < MIN_DIGITOS_NUM) continue;
        // Compara também sem zero à esquerda: "0517" no papel × "517" na planilha.
        if (l.nfDig === cand || l.nfDig === String(Number(cand))) return true;
    }
    return false;
};

const entidadeBate = (l, d) => compartilhaToken(l.tokens, d.tokens);

// Distância em dias entre o documento e o lançamento; usa a data mais próxima
// entre lançamento e emissão (o PDF é arquivado quando chega, a planilha lança no
// pagamento — os dois quase nunca coincidem).
function distanciaDias(l, d) {
    if (d.data == null) return null;
    const alvos = [l.dtLancamento, l.dtEmissao].filter(x => x != null);
    if (!alvos.length) return null;
    return Math.min(...alvos.map(t => Math.abs(t - d.data) / DIA_MS));
}

// A EMISSÃO como conferência do par JÁ FEITO — nunca como sinal de casamento.
//
// Compara a emissão que a planilha registra (`dtEmissao` do lançamento) com a que o
// extrator leu da nota (`dtEmissaoDoc`, posto por `enriquecerComOcr`). Devolve:
//   true  → as duas existem e divergem  → par SUSPEITO
//   false → as duas existem e coincidem → par confirmado por um campo que não casou
//   null  → falta uma delas             → o sinal se cala
//
// Tolerância de 1 dia: as duas datas vêm de fontes diferentes (planilha digitada ×
// leitura do papel) e fuso/arredondamento não podem virar divergência.
//
// MEDIDO em 15/09/2026 (`_medir/_data-como-sinal.js`), jan–jun/2026, 2.108 pares:
//   força 3 → 70,7% coincidem     força 2 → 56,6%     força 1 → 3,3%
// Dos 171 pares fracos (força 1), 122 têm as duas emissões e 118 DIVERGEM — a
// evidência independente de que o par por valor sozinho é, quase sempre, colisão.
const TOLERANCIA_EMISSAO_MS = DIA_MS;
function emissaoDiverge(l, d) {
    const eL = l.dtEmissao, eD = d.dtEmissaoDoc;
    if (eL == null || eD == null) return null;
    return Math.abs(eL - eD) >= TOLERANCIA_EMISSAO_MS;
}

// Sem data em algum dos lados o veto não se aplica: ausência de evidência não é
// evidência de erro, e barrar aí só perderia par bom.
//
// `entidadeDispensa` afrouxa o veto quando o par também tem a ENTIDADE batendo —
// aí são dois sinais, não um, e a data deixa de ser a única defesa. Vale só para o
// documento vindo de pasta VIZINHA (ver `conferirPeriodo`): medido em 08/09/2026,
// jan–jun/2026,
//
//   variante                              pares  2º campo  piora  MACPONTA
//   atual (veto de 15d em toda parte)      2.072    91,5%     —      não acha
//   relaxar em TODA passada                2.106    91,7%     6      acha
//   relaxar só nas vizinhas                2.104    91,7%     0      acha   <- aplicada
//
// Relaxar também no mês corrente trocava 6 pares por piores, e a auditoria no disco
// mostrou o porquê: nesses casos o documento de força 3 (número idêntico) está na
// pasta +1 e o de força 2 no mês corrente (LOCALIZA `FAT 315637` em 04/2026 ×
// `FAT 307515` em 03/2026).
//
// ATUALIZAÇÃO 18/09/2026: aquele "fechar cedo com o documento pior" era o defeito
// da SEQUÊNCIA de passadas, não da dispensa — e foi consertado em `conferirPeriodo`,
// que agora roda mês e vizinhança juntos ordenados por força. A dispensa continua
// restrita à origem vizinha por outro motivo, que permanece válido: no próprio mês a
// data é evidência real (a pasta e o lançamento são do mesmo período), enquanto na
// vizinhança a distância é estrutural. O caso LOCALIZA hoje resolve sozinho — o
// documento de força 3 da pasta +1 ganha do de força 2 do mês pela ordenação.
function dentroDaJanela(l, d, entidadeDispensa) {
    if (entidadeDispensa && entidadeBate(l, d)) return true;
    const dist = distanciaDias(l, d);
    return dist == null || dist <= JANELA_DIAS;
}

/**
 * A regra medida: casa por (número E entidade), por (número E valor), ou por valor
 * sozinho com veto de data. Devolve null se não casa, ou o motivo do casamento.
 *
 * O caminho (número E valor) entrou em 03/09/2026 (§14.3), depois que a auditoria
 * manual da pasta de março achou 27 lançamentos (jan–jun/2026) com número E valor
 * idênticos ao documento, declarados "sem documento" porque o nome do arquivo traz
 * outro fornecedor:
 *
 *   KUHNEN E CHAVES NF 12040 R$ 1.721,40 × 017.DOC- 1721,40 ... TORNEARIA . NF 12040
 *   V M CARNEIRO    NF 1639  R$ 2.331,20 × 033.DOC- 2331,20 ... VERIDYANA. NFS 1639
 *   C & F COMERCIO  NF 11027 R$   234,90 × 003.DOC- 234,90 ... CEF . NF 11027
 *
 * Sem esta via o par não se encaixa em (número E entidade) — a entidade não bate —
 * e cai no caminho por valor, onde o veto de 15 dias o mata (o papel costuma estar
 * na pasta do mês seguinte). Ou seja: o sinal que FALTA invalidava os dois que
 * concordam. É o mesmo modo de falha de §13 (piso de dígitos) por outro caminho.
 *
 * A coluna FANTASIA da planilha NÃO resolve esses casos, e isso foi medido: ela já
 * entra em `lancamentoDaPlanilha`, está preenchida em 98,5% dos lançamentos, e
 * mesmo assim nos 27 casos resolve ZERO. O nome no arquivo não é a razão social nem
 * o nome fantasia — é o sócio, o estabelecimento ou quem emitiu o boleto
 * ("FR GUINCHO" na planilha × "VERIDYANA MARGRAF" no papel).
 *
 *   variante                  pares  cobertura  2º campo
 *   (nº E ent) OU valor       2.031    66,4%     91,3%
 *   + (nº E valor)            2.058    67,3%     91,5%   <- aplicada
 *
 * 27 ganhos, 0 perdas, 1 troca (e a troca é melhora: GM MANUTENÇÃO NF 28 sai de um
 * recibo do SIDNEY para `031.DOC- ... MUNDI SECURITIZADORA. NFS 28`). Além dos 27
 * novos, a via converte 57 pares que vinham do caminho fraco em pares de dois
 * sinais. Estável em 4 sementes de embaralhamento.
 *
 * O veto de janela NÃO se aplica a esta via, e é o ponto: ele existe para o par
 * sustentado só por valor. Com o número junto, a data deixa de ser a única defesa.
 */
function casa(l, d, entidadeDispensaJanela) {
    if (numeroBate(l, d) && entidadeBate(l, d))
        return valorBate(l, d) ? 'numero+entidade+valor' : 'numero+entidade';
    if (numeroBate(l, d) && valorBate(l, d))
        return 'numero+valor';
    if (valorBate(l, d) && dentroDaJanela(l, d, entidadeDispensaJanela))
        return entidadeBate(l, d) ? 'valor+entidade' : 'valor';
    return null;
}

// Quantos dos três sinais sustentam o par. 1 = apoiado num campo só (frágil).
const forcaDoPar = (l, d) =>
    (valorBate(l, d) ? 1 : 0) + (numeroBate(l, d) ? 1 : 0) + (entidadeBate(l, d) ? 1 : 0);

/**
 * Casa os lançamentos de um período com os documentos daquele período.
 *
 * Cada documento é consumido por no máximo um lançamento. A ordem de preferência é
 * por FORÇA do par, não pela ordem da planilha: sem isso o resultado dependeria de
 * como o Delsoft exportou as linhas (o defeito 5 da auditoria). Com a ordenação por
 * força, embaralhar a entrada não muda o total — verificado com 3 sementes.
 *
 * @param {Array} lancamentos  saída de lancamentoDaPlanilha
 * @param {Array} documentos   saída de documentoDoArquivo
 * @param {boolean|function} entidadeDispensaJanela  `true` dispensa para TODOS; uma
 *        função `(documento) => boolean` dispensa POR DOCUMENTO. A forma por documento
 *        existe porque mês e vizinhança passaram a correr numa passada só (ver
 *        `conferirPeriodo`) e a dispensa é propriedade da PASTA de onde o papel veio,
 *        não da passada: no mês a data é evidência, na vizinhança é ruído estrutural.
 */
function parear(lancamentos, documentos, entidadeDispensaJanela) {
    const dispensa = typeof entidadeDispensaJanela === 'function'
        ? entidadeDispensaJanela : () => !!entidadeDispensaJanela;
    const candidatos = [];
    for (let i = 0; i < lancamentos.length; i++) {
        for (let j = 0; j < documentos.length; j++) {
            const via = casa(lancamentos[i], documentos[j], dispensa(documentos[j]));
            if (via) candidatos.push({ i, j, via, forca: forcaDoPar(lancamentos[i], documentos[j]) });
        }
    }
    // Mais forte primeiro; empate resolvido pela menor distância de data, para o par
    // com data plausível ganhar do par que só não foi vetado por não ter data.
    candidatos.sort((a, b) => {
        if (b.forca !== a.forca) return b.forca - a.forca;
        const da = distanciaDias(lancamentos[a.i], documentos[a.j]);
        const db = distanciaDias(lancamentos[b.i], documentos[b.j]);
        const na = da == null ? Infinity : da, nb = db == null ? Infinity : db;
        if (na !== nb) return na - nb;
        // Força E data empatadas: o documento DA PRÓPRIA PASTA ganha. Quando mês e
        // vizinhança correm juntos, sem isto um papel de outro mês tomaria o lugar de
        // um do mês por puro desempate de nome — e o par do mês é o mais provável,
        // porque a planilha lança no mês em que a pasta foi montada.
        const va = documentos[a.j].deslocamento ? 1 : 0;
        const vb = documentos[b.j].deslocamento ? 1 : 0;
        if (va !== vb) return va - vb;
        // Desempate final pelo CONTEÚDO, não pelo índice: índice muda quando a planilha
        // ou a pasta chega em outra ordem, e aí o total passa a depender dessa ordem
        // (medido: ±1 par entre sementes). Nome do arquivo é único dentro do mês, e
        // NF+entidade identifica o lançamento, então o critério é estável e total.
        const la = lancamentos[a.i], lb = lancamentos[b.i];
        if (la !== lb) {
            const ka = `${la.nf}|${la.entidade}`, kb = `${lb.nf}|${lb.entidade}`;
            if (ka !== kb) return ka < kb ? -1 : 1;
        }
        const fa = documentos[a.j].arquivo, fb = documentos[b.j].arquivo;
        return fa === fb ? 0 : (fa < fb ? -1 : 1);
    });

    const lancUsado = new Array(lancamentos.length).fill(false);
    const docUsado = new Array(documentos.length).fill(false);
    const pares = [];
    const parPorLanc = new Map();   // índice do lançamento → par, para achar o maço depois
    for (const c of candidatos) {
        if (lancUsado[c.i] || docUsado[c.j]) continue;
        lancUsado[c.i] = true;
        docUsado[c.j] = true;
        const par = {
            lancamento: lancamentos[c.i],
            documento: documentos[c.j],
            via: c.via,
            forca: c.forca,
            distanciaDias: distanciaDias(lancamentos[c.i], documentos[c.j]),
            // Conferência independente do par, pela EMISSÃO (ver `enriquecerComOcr`).
            // Não participou do casamento: é evidência de fora, calculada depois.
            //   true  → as duas emissões existem e DIVERGEM (par suspeito)
            //   false → as duas existem e batem (par confirmado por 4º campo)
            //   null  → falta a emissão de um dos lados; o sinal se cala
            emissaoDiverge: emissaoDiverge(lancamentos[c.i], documentos[c.j]),
        };
        pares.push(par);
        parPorLanc.set(c.i, par);
    }

    // ── Empate: outro documento disputava este lançamento com a MESMA força ──
    // O desempate que decidiu (data, depois nome do arquivo) é estável e
    // determinístico, e a medição de 08/09/2026 não achou critério melhor —
    // preferir o documento "não acessório" REPROVOU, porque "+ AUT" quer dizer
    // "nota MAIS autorização anexa", não "só a autorização": dos 61 casos com
    // alternativa, o par existente estava certo e a alternativa era colisão de
    // valor redondo. Então a escolha fica como está e o empate só é MARCADO —
    // é o ponto em que o olho humano decide melhor que a regra.
    //
    // Só conta como empate o candidato que disputava o MESMO lançamento e ficou
    // de fora; documento já usado por outro lançamento não é empate, é ocupação.
    const empatesPorLanc = new Map();
    for (const c of candidatos) {
        const par = parPorLanc.get(c.i);
        if (!par || documentos[c.j] === par.documento) continue;
        if (c.forca !== par.forca) continue;
        const lista = empatesPorLanc.get(c.i) || [];
        lista.push(documentos[c.j]);
        empatesPorLanc.set(c.i, lista);
    }
    for (const [i, docs] of empatesPorLanc) {
        const par = parPorLanc.get(i);
        par.empatado = true;
        // `valor`/`valorAlt` vão junto porque quem consome precisa SOMAR os candidatos:
        // quando a soma fecha o lançamento, os arquivos são as parcelas de um carnê e
        // não papéis concorrentes (ver `ehCarne` em comparar-notas.js). `valorAlt` é o
        // valor do NOME do arquivo — numa parcela, o valor PAGO; `valor` é o total da
        // nota lido pelo extrator. Sem os dois a soma não fecha.
        par.candidatosEmpatados = docs.map(d => ({
            arquivo: d.arquivo, caminho: d.caminho, valor: d.valor, valorAlt: d.valorAlt,
        }));
    }

    // ── Irmãos: o resto do maço, que não é documento órfão ──────────────────
    // Um documento não consumido que divide (pasta-dia, prefixo) com o documento
    // de um par pertence àquele pagamento — é o pedido, a proposta ou a
    // autorização arquivados junto da nota. Contá-lo como "documento sem
    // lançamento" superestima o que falta conciliar.
    //
    // O prefixo SOZINHO não basta, e isso foi medido: em 04/2026 o maço 059 juntava
    // quatro apólices BRADESCO de valores diferentes (R$ 780,43 / 1.363,63 / 570,17
    // / 684,63) — pagamentos distintos que só dividem o número do dia. Exigir também
    // o MESMO VALOR é o que separa "dois papéis do mesmo pagamento" de "dois
    // pagamentos vizinhos na pasta": o PV da MACPONTA traz o mesmo 1.320.000,00 da
    // nota, a apólice de R$ 570 não tem nada a ver com a de R$ 780.
    //
    // Documento sem valor legível no nome não é agrupado — sem o segundo sinal, a
    // coincidência de prefixo é fraca demais.
    //
    // Pós-processamento puro: nenhum par muda, nenhum documento passa a casar.
    const macoDoPar = new Map();
    for (const p of pares) if (p.documento.maco) macoDoPar.set(p.documento.maco, p);
    const irmaoDe = new Array(documentos.length).fill(null);
    for (let j = 0; j < documentos.length; j++) {
        if (docUsado[j]) continue;
        const d = documentos[j];
        if (!d.maco || d.valor == null) continue;
        const par = macoDoPar.get(d.maco);
        if (!par) continue;
        // Mesmo valor que o documento do par (ou que o lançamento, quando o par se
        // apoia no valor da nota e o irmão traz o valor pago).
        const alvo = par.documento.valor;
        const bateDoc = alvo != null && Math.abs(alvo - d.valor) < TOL_VALOR;
        const bateLanc = Math.abs(par.lancamento.valor - d.valor) < TOL_VALOR;
        if (!bateDoc && !bateLanc) continue;
        irmaoDe[j] = par;
        (par.irmaos || (par.irmaos = [])).push({ arquivo: d.arquivo, caminho: d.caminho });
    }

    const orfaos = docUsado.reduce((n, u, j) => n + (u || irmaoDe[j] ? 0 : 1), 0);
    return {
        pares,
        // "Fraco" = sustentado por um sinal só. É o que merece conferência humana:
        // medido, 25,4% dos pares só-por-valor tinham entidade e número discordando.
        fracos: pares.filter(p => p.forca === 1).length,
        empatados: pares.filter(p => p.empatado).length,
        lancamentosSemDocumento: lancUsado.reduce((n, u) => n + (u ? 0 : 1), 0),
        // Só o que não é par NEM irmão de par: o documento realmente sem dono.
        documentosSemLancamento: orfaos,
        // O bruto continua disponível — é a contagem que os cards usavam antes, e
        // a diferença entre os dois é exatamente o que o arquivamento agrupa.
        documentosSemLancamentoBruto: docUsado.reduce((n, u) => n + (u ? 0 : 1), 0),
        irmaosAgrupados: irmaoDe.reduce((n, p) => n + (p ? 1 : 0), 0),
    };
}

// Vizinhança de pastas consultada depois do mês corrente, em ordem.
//
// Medido em 02/09/2026 (jan–jun/2026), cobertura de lançamentos com documento:
//
//   só mesmo mês      1.139 pares   36,7%
//   [-1]              1.206         38,9%
//   [-1,+1]           1.899         61,2%   <- o salto está aqui
//   [-1,+1,+2]        1.932         62,3%   <- adotado
//   [-2,-1,+1,+2]     1.936         62,4%
//   [-3..-1,+1,+2]    1.939         62,5%
//
// O vizinho que importa é **+1**, não −1: o documento é arquivado quando CHEGA, e a
// planilha lança no pagamento, então a pasta do mês seguinte é que guarda o papel do
// mês corrente (122 pares em 01/2026 vindos de +1 contra 0 de −1). É a mesma simetria
// que PROGRESSO §12 descreveu ("a pasta de Abril guarda os documentos de Março").
//
// Até onde ampliar foi remedido em 03/09/2026, depois que a auditoria de 03/2026
// (_medir/auditar-marco.js) achou 4 documentos da MAQNELSON arquivados em JUNHO
// para lançamento de março — +3, fora da janela de então:
//
//   janela              pares  cobertura  2º campo
//   [-1,+1,+2]          2.014    65,9%     91,3%
//   [-1,+1..+3]         2.026    66,3%     91,3%   <- aplicada
//   [-1,+1..+4]         2.030    66,4%     91,1%
//   [-1,+1..+5]         2.034    66,5%     91,0%
//
// +3 rende 12 pares com a confirmação por 2º campo INTACTA. De +4 em diante cada
// offset rende ~4 pares e custa precisão (−0,18pp cada), que é cobertura comprada
// com par errado — o critério de §10 rejeita. Ampliar para trás (−2) rende 15 mas
// já custa 0,1pp: o papel é arquivado DEPOIS do lançamento, não antes.
const VIZINHANCA = [-1, 1, 2, 3];

/**
 * Confere um período inteiro: casa primeiro no próprio mês, depois nas pastas
 * vizinhas, e devolve os dois grupos separados.
 *
 * A separação é obrigatória, não cosmética. Cada mês roda sua própria conferência, e
 * um documento de Fevereiro pode ser o par de um lançamento de Janeiro E de um de
 * Fevereiro — medido: 115 documentos em 6 meses seriam reivindicados por dois meses.
 * Por isso o par vizinho só **retira o lançamento de "sem documento"**; ele não conta
 * como documento coberto da pasta. É a mesma decisão de PROGRESSO §12, e é o que
 * mantém a identidade do lado pasta fechando.
 *
 * @param {Array}  lancamentos     do mês consultado
 * @param {object} documentosPorMes  "MM.AAAA" → array de documentoDoArquivo
 * @param {string} periodo          "MM.AAAA" do mês consultado
 */
function conferirPeriodo(lancamentos, documentosPorMes, periodo) {
    // ── UMA passada só, mês e vizinhança juntos ──────────────────────────────
    // Até 18/09/2026 esta função rodava DUAS passadas em sequência: o mês fechava
    // os pares, e a vizinhança só recebia quem sobrava. `parear` ordena por força
    // DENTRO de uma passada, mas ninguém ordenava ENTRE elas — então um lançamento
    // que fecharia força 3 (`numero+entidade+valor`) numa pasta vizinha ficava com
    // a força 1 por valor do próprio mês, e o papel certo virava órfão.
    //
    // O defeito apareceu duas vezes por caminhos independentes (o par BOM CLIMA que
    // caiu de f3 para f1, e a medição de passada única de §17.3). Cotejo do motor de
    // HEAD contra este, mesmos dados e mesmo processo, jan–jun/2026:
    //
    //                              antes   depois
    //   pares                      2.151   2.154    +3
    //   força 3                    1.487   1.618  +131
    //   força 1                      161     132   −29
    //   conferem pelo fornecedor    76,9%   78,2%
    //   PERDAS                         —       0
    //
    // 164 pares trocaram de documento: 142 sobem de força, 0 descem. O −99 de força 2
    // é promoção, não perda. A fila de conferência cai de 161 para 132.
    //
    // A passada única de §17.3 tinha REPROVADO porque afrouxava a janela para todos.
    // Aqui a dispensa acompanha a ORIGEM do documento — é o que `parear` recebe como
    // função em vez de booleano.
    const todos = [];
    for (const d of (documentosPorMes[periodo] || []))
        todos.push(d);                       // do mês: sem cópia, o cotejo de órfãos é por caminho
    for (const off of VIZINHANCA) {
        const alvo = deslocarPeriodo(periodo, off);
        for (const d of (documentosPorMes[alvo] || []))
            todos.push({ ...d, periodoDocumento: alvo, deslocamento: off });
    }

    // Nas pastas vizinhas o veto de data cede quando a entidade bate: a distância
    // entre a pasta e o lançamento é ESTRUTURAL — o papel é arquivado quando chega e
    // a planilha lança no pagamento —, então a data diz pouco e valor + entidade já
    // são dois sinais. No próprio mês a data continua valendo. Ver `dentroDaJanela`.
    const r = parear(lancamentos, todos, d => !!d.deslocamento);

    const noMesPares = [], emVizinhas = [];
    for (const p of r.pares) {
        if (p.documento.deslocamento) emVizinhas.push({
            ...p,
            periodoDocumento: p.documento.periodoDocumento,
            deslocamento: p.documento.deslocamento,
        });
        else noMesPares.push(p);
    }
    const noMes = { pares: noMesPares };
    const casadosTodos = new Set(r.pares.map(p => p.lancamento));
    const semDocumento = lancamentos.filter(l => !casadosTodos.has(l));

    // ── Órfãos do mês ───────────────────────────────────────────────────────
    // Órfão é o documento DESTA pasta que não virou par nem irmão de par. O caso
    // MACPONTA cai aqui: o lançamento é de fevereiro e o maço está na pasta de
    // janeiro, então quem conta os órfãos de janeiro tem de enxergar o par de
    // fevereiro para não marcar o maço como sem dono.
    //
    // O cotejo é pelo CAMINHO, não pela identidade do objeto: o documento vizinho
    // entra na passada como cópia (`{...d}`), e o caminho identifica o arquivo
    // dentro da pasta.
    const doMes = documentosPorMes[periodo] || [];
    const reivindicados = new Set();
    for (const p of [...noMes.pares, ...emVizinhas]) {
        reivindicados.add(p.documento.caminho);
        for (const irm of (p.irmaos || [])) reivindicados.add(irm.caminho);
    }
    const orfaosDoMes = doMes.filter(d => !reivindicados.has(d.caminho)).length;
    // Bruto = sem o desconto dos irmãos, para a tela poder mostrar a diferença.
    const soPares = new Set([...noMes.pares, ...emVizinhas].map(p => p.documento.caminho));
    const orfaosBruto = doMes.filter(d => !soPares.has(d.caminho)).length;

    return {
        pares: noMes.pares,                  // documento da pasta DESTE mês
        paresVizinhos: emVizinhas,           // documento arquivado em pasta vizinha
        fracos: noMes.pares.filter(p => p.forca === 1).length
              + emVizinhas.filter(p => p.forca === 1).length,
        // Pares em que outro documento disputava o mesmo lançamento com força igual.
        // Com a passada única o empate passou a ser disputado também ENTRE pastas:
        // um papel do mês e um da vizinhança com a mesma força concorrem de verdade,
        // e o desempate por origem (ver `parear`) dá o mês como vencedor.
        empatados: noMes.pares.filter(p => p.empatado).length
                 + emVizinhas.filter(p => p.empatado).length,
        // "Sem documento" já considera as vizinhas — é o número que interessa a quem
        // confere: o papel existe, só está arquivado noutro mês.
        lancamentosSemDocumento: semDocumento.length,
        // A LISTA, não só a contagem: a pergunta que o painel responde é "quais
        // lançamentos não têm papel", e para agir é preciso saber quais são.
        semDocumento,
        // Só do mês: documento de pasta vizinha não é "desta pasta" e não entra aqui.
        // Já é líquido de irmãos — o resto do maço não é documento sem dono.
        documentosSemLancamento: orfaosDoMes,
        documentosSemLancamentoBruto: orfaosBruto,
        irmaosAgrupados: orfaosBruto - orfaosDoMes,
        vizinhanca: VIZINHANCA,
    };
}

// "03.2026" + 1 → "04.2026". Date normaliza a virada de ano sozinho.
function deslocarPeriodo(periodo, n) {
    const [m, a] = String(periodo).split('.').map(Number);
    const d = new Date(Date.UTC(a, m - 1 + n, 1));
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

module.exports = {
    parear,
    conferirPeriodo,
    deslocarPeriodo,
    documentoDoArquivo,
    enriquecerComOcr,
    lancamentoDaPlanilha,
    // exportados para teste e medição
    valorDoNome, numeroDoNome, dataDoNome, tokens, prefixoDoNome, pastaDoCaminho,
    valorBate, numeroBate, entidadeBate, casa, distanciaDias,
    JANELA_DIAS, VIZINHANCA,
};
