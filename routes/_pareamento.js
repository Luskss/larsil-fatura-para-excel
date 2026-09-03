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
function valorDoNome(nome) {
    const n = String(nome || '');
    const m = n.match(/\.DOC-?\s*(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2})/i)
           || n.match(/\.DOC-?\s*(?:R\$\s*)?(\d+,\d{2})/i)
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
function dataDoNome(nome) {
    const n = String(nome || '');
    let m = n.match(/(?<!\d)(20\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = n.match(/(?<!\d)(\d{2})\.(\d{2})\.(20\d{2})(?!\d)/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return null;
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

/**
 * Descreve um documento da pasta a partir do nome do arquivo.
 * @param {string} nome  nome do PDF, como está no disco
 * @param {string} [rel] caminho relativo, só para exibição
 */
function documentoDoArquivo(nome, rel) {
    return {
        arquivo: nome,
        caminho: rel || nome,
        valor: valorDoNome(nome),
        numero: numeroDoNome(nome),
        numeroDig: soDigitos(numeroDoNome(nome)),
        data: dataDoNome(nome),
        tokens: tokens(nome),
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

    // A DATA é a exceção: continua vindo do nome/pasta. Ela não descreve o
    // documento, posiciona-o no mês certo para a busca (§15/§16) — `dtEmissao` do
    // OCR é a data de emissão da nota, que é outra coisa.
    if (d.data == null && ocr.dtEmissao != null) d.data = ocr.dtEmissao;

    if (ocr.emitente && !ehEmitenteProprio(ocr.emitente))
        d.tokens = new Set([...d.tokens, ...tokens(ocr.emitente)]);
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

// Sem data em algum dos lados o veto não se aplica: ausência de evidência não é
// evidência de erro, e barrar aí só perderia par bom.
function dentroDaJanela(l, d) {
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
function casa(l, d) {
    if (numeroBate(l, d) && entidadeBate(l, d))
        return valorBate(l, d) ? 'numero+entidade+valor' : 'numero+entidade';
    if (numeroBate(l, d) && valorBate(l, d))
        return 'numero+valor';
    if (valorBate(l, d) && dentroDaJanela(l, d))
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
 */
function parear(lancamentos, documentos) {
    const candidatos = [];
    for (let i = 0; i < lancamentos.length; i++) {
        for (let j = 0; j < documentos.length; j++) {
            const via = casa(lancamentos[i], documentos[j]);
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
    for (const c of candidatos) {
        if (lancUsado[c.i] || docUsado[c.j]) continue;
        lancUsado[c.i] = true;
        docUsado[c.j] = true;
        pares.push({
            lancamento: lancamentos[c.i],
            documento: documentos[c.j],
            via: c.via,
            forca: c.forca,
            distanciaDias: distanciaDias(lancamentos[c.i], documentos[c.j]),
        });
    }

    return {
        pares,
        // "Fraco" = sustentado por um sinal só. É o que merece conferência humana:
        // medido, 25,4% dos pares só-por-valor tinham entidade e número discordando.
        fracos: pares.filter(p => p.forca === 1).length,
        lancamentosSemDocumento: lancUsado.reduce((n, u) => n + (u ? 0 : 1), 0),
        documentosSemLancamento: docUsado.reduce((n, u) => n + (u ? 0 : 1), 0),
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
    const noMes = parear(lancamentos, documentosPorMes[periodo] || []);

    const casados = new Set(noMes.pares.map(p => p.lancamento));
    const pendentes = lancamentos.filter(l => !casados.has(l));

    // Todas as pastas vizinhas entram numa ÚNICA passada, não uma por vez.
    // Rodar pasta a pasta faz a ordem dos offsets decidir o casamento: um documento
    // de +1 é consumido por um lançamento que teria par melhor em +2, e o total passa
    // a variar com a ordem de entrada (medido: ±1 par entre sementes diferentes).
    // Com uma passada só, quem ordena é a força do par, como no mês corrente.
    const docsVizinhos = [];
    for (const off of VIZINHANCA) {
        const alvo = deslocarPeriodo(periodo, off);
        for (const d of (documentosPorMes[alvo] || []))
            docsVizinhos.push({ ...d, periodoDocumento: alvo, deslocamento: off });
    }
    const rViz = parear(pendentes, docsVizinhos);
    const emVizinhas = rViz.pares.map(p => ({
        ...p,
        periodoDocumento: p.documento.periodoDocumento,
        deslocamento: p.documento.deslocamento,
    }));
    const casadosViz = new Set(emVizinhas.map(p => p.lancamento));
    const semDocumento = pendentes.filter(l => !casadosViz.has(l));

    return {
        pares: noMes.pares,                  // documento da pasta DESTE mês
        paresVizinhos: emVizinhas,           // documento arquivado em pasta vizinha
        fracos: noMes.pares.filter(p => p.forca === 1).length
              + emVizinhas.filter(p => p.forca === 1).length,
        // "Sem documento" já considera as vizinhas — é o número que interessa a quem
        // confere: o papel existe, só está arquivado noutro mês.
        lancamentosSemDocumento: semDocumento.length,
        // A LISTA, não só a contagem: a pergunta que o painel responde é "quais
        // lançamentos não têm papel", e para agir é preciso saber quais são.
        semDocumento,
        // Só do mês: documento de pasta vizinha não é "desta pasta" e não entra aqui.
        documentosSemLancamento: noMes.documentosSemLancamento,
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
    valorDoNome, numeroDoNome, dataDoNome, tokens,
    valorBate, numeroBate, entidadeBate, casa, distanciaDias,
    JANELA_DIAS, VIZINHANCA,
};
