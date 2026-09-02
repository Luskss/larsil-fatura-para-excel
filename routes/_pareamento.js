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

// Mínimo de dígitos para um número servir de chave. Abaixo disso ("1", "12") ele
// casaria com quase tudo.
const MIN_DIGITOS_NUM = 3;

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
    if (!d.numeroDig && ocr.numero) {
        const n = soDigitos(ocr.numero);
        if (n.length >= MIN_DIGITOS_NUM) { d.numeroDig = n; d.numero = n; }
    }
    // Segundo número: o nome às vezes traz o "nosso número" do boleto em vez da
    // NF, e aí o número do OCR é o que casa com a planilha.
    if (ocr.numero) {
        const n = soDigitos(ocr.numero);
        if (n.length >= MIN_DIGITOS_NUM && n !== d.numeroDig) d.numeroAlt = n;
    }
    if (d.valor == null && ocr.valor != null && ocr.valor > 0) d.valor = ocr.valor;
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
const valorBate = (l, d) =>
    d.valor != null && l.valor > 0 && Math.abs(l.valor - d.valor) < TOL_VALOR;

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
 * A regra medida: casa por (número E entidade), ou por valor com veto de data.
 * Devolve null se não casa, ou o motivo do casamento.
 */
function casa(l, d) {
    if (numeroBate(l, d) && entidadeBate(l, d))
        return valorBate(l, d) ? 'numero+entidade+valor' : 'numero+entidade';
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
// Depois de +2 o retorno morre (62,3% → 62,5% custando duas leituras de pasta a mais),
// então a janela para em +2.
const VIZINHANCA = [-1, 1, 2];

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
