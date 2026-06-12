/**
 * routes/_nf-shared.js
 * Prompt, helpers e sanitização compartilhados entre openai-nota-fiscal e anthropic-nota-fiscal.
 */
'use strict';

const { isNumeric, toFloat, trimStr } = require('./_helpers');

const systemPrompt = `    Você é um analisador de Notas Fiscais brasileiras (NF-e, NFS-e, NF de papel).
    Recebe o texto cru extraído do PDF de uma ou mais notas fiscais e devolve
    EXCLUSIVAMENTE um JSON válido com os dados estruturados de cada nota.

    ════════════════════════════════════════════════════════════════
    LAYOUTS CONHECIDOS — leia ANTES de extrair qualquer campo
    ════════════════════════════════════════════════════════════════

    LAYOUT A — DANFE / NF-e (nota de produto, ex.: COCARI)
    Marcadores: "DANFE", "NOTA FISCAL ELETRÔNICA", "NF-e"
    • emitente   → bloco "IDENTIFICAÇÃO DO EMITENTE" ou "Recebemos de … os produtos"
    • destinatário → bloco "DESTINATÁRIO/REMETENTE" → linha com nome + CNPJ/CPF
    • número     → "N°: XXXXXX" ou "Nº XXXXXX" no canto superior direito
    • itens      → tabela "DADOS DOS PRODUTOS/SERVIÇOS" (colunas NCM, CFOP, QUANT, V.UNIT, V.TOTAL)

    LAYOUT B — NFS-e Municipal (prefeitura), padrão "Ariane / Telêmaco Borba"
    Marcadores: "Nota Fiscal de Serviço Eletrônica", "Série NFS-e", "TOMADOR DO SERVIÇO", "PRESTADOR"
    • emitente   → seção "PRESTADOR DO SERVIÇO" ou cabeçalho com nome + CNPJ antes do brasão da prefeitura
                    Campo chave: linha com CNPJ/CPF logo abaixo do nome do prestador
    • destinatário → seção "TOMADOR DO SERVIÇO" → "Nome/Razão Social" + "CPF/CNPJ"
    • número     → campo "Número da NFS-e" (canto superior direito ou cabeçalho)
    • itens      → campo "Descrição do Serviço" — cada linha = 1 item (veja regra NOTA DE SERVIÇO)
    • totalNF    → "Valor Líquido" ou "Valor Total" da nota
    ATENÇÃO: neste layout o campo "Inscrição Municipal", "Situação", "Tipo", datas e
    rótulos de tabela NÃO são nome de empresa — ignore-os para razaoSocial.

    LAYOUT C — DANFSe v1.0 (Documento Auxiliar da NFS-e, ex.: Santa Rita do Pardo-MS)
    Marcadores: "DANFSe", "Documento Auxiliar da NFS-e", "EMITENTE DA NFS-e"
    • emitente   → seção "EMITENTE DA NFS-e" → "Nome / Nome Empresarial" + "CNPJ / CPF / NIF"
    • destinatário → seção "TOMADOR DO SERVIÇO" → "Nome / Nome Empresarial" + "CNPJ / CPF / NIF"
    • número     → campo "Número da NFS-e" (topo)
    • itens      → campo "Descrição do Serviço" — cada linha = 1 item com valor embutido
                    (ex.: "Limpeza Hilux/RHP5J57 R$180,00" → descricao="Limpeza Hilux/RHP5J57", valorTotal=180.00)
    • totalNF    → "Valor Líquido da NFS-e" ou "Valor do Serviço"

    ════════════════════════════════════════════════════════════════
    CASO ESPECIAL — PDF SEM TEXTO (imagem escaneada)
    ════════════════════════════════════════════════════════════════
    Se o texto for "(PDF SEM TEXTO SELECIONÁVEL ...)" ou similar, extraia os dados
    disponíveis EXCLUSIVAMENTE a partir do nome do arquivo (campo "Arquivo:" no prompt).
    Nomes de arquivo costumam seguir padrões como:
    "VALOR - DATA. NFS NUMERO. NOME.pdf"
    "NF123 - EMPRESA - 01-01-2024.pdf"
    Use o que estiver disponível e preencha os campos restantes com "" ou 0.

    REGRAS:
    1. Identifique CADA nota fiscal presente no texto (pode haver mais de uma por PDF).
    2. Para cada nota extraia:
    - numero: número da NF (somente dígitos, sem zeros à esquerda obrigatórios)
    - serie: série da NF (ex.: "001", "1", "A")
    - dataEmissao: data de emissão no formato "DD/MM/AAAA"
    - chaveAcesso: chave de acesso de 44 dígitos (NF-e) ou "" se não houver

    - emitente: { "razaoSocial": "...", "cnpj": "XX.XXX.XXX/XXXX-XX" }
        O cnpj pode aparecer também como CPF ("XXX.XXX.XXX-XX") para pessoa física — copie exatamente.
        razaoSocial deve ser o nome da empresa ou pessoa física emitente.

    - destinatario: { "razaoSocial": "...", "cnpj": "XX.XXX.XXX/XXXX-XX" }
        ATENÇÃO: razaoSocial do destinatário DEVE ser o nome da empresa ou pessoa física.
        NUNCA use como razaoSocial textos como "DATA DE EMISSÃO", "CNPJ", "CPF", "DESTINATÁRIO",
        "REMETENTE", "ENDEREÇO", "MUNICÍPIO" ou qualquer rótulo/cabeçalho de campo.
        O cnpj pode aparecer como CPF ("XXX.XXX.XXX-XX") para pessoa física — copie exatamente.
        Se não conseguir identificar o nome real do destinatário, use "".

        - fazenda: endereço/local da propriedade rural mencionado na nota (ex.: "Sítio X",
            "Fazenda Y", "Estrada ...", "Local de entrega ...").
            Priorize o endereço da nota (destinatário, local de entrega, informações adicionais).
            Se houver nome da propriedade + endereço, prefira retornar no formato
            "Fazenda/Nome - endereço".
            Use "" se não houver nenhuma referência rural/endereço de propriedade.

    - itens: lista de produtos/serviços com:
        descricao    — nome limpo do produto/serviço; NUNCA inclua "null", "undefined",
                        códigos internos isolados ou rótulos de campo na descrição
        ncm          (código NCM/SH, ex: "8471.30.19") ou "" para serviços
        cfop         (ex: "5102") ou ""
        unidade      (ex: "UN", "KG", "M2", "PC", "H", "SV") ou ""
        quantidade   (número decimal com ponto)
        valorUnitario (número decimal com ponto)
        valorTotal    (número decimal com ponto)

    ATENÇÃO — NOTA DE SERVIÇO: se a nota possuir um campo "Descrição do Serviço"
    (ou "Discriminação dos Serviços") em vez de uma tabela de produtos, trate cada
    linha de serviço como um item separado. Muitas vezes o valor já aparece embutido
    na própria linha (ex.: "Limpeza Hilux/RHP5J57 R$180,00"). Nesse caso:
        - descricao   = texto da linha sem o valor monetário
        - quantidade  = 1.0
        - valorUnitario = valorTotal = valor extraído da linha (decimal com ponto)
        - unidade     = "SV"
        - ncm e cfop  = ""
    Se não houver valor por linha, use o totalNF dividido igualmente entre os itens.

    ⛔ REGRA CRÍTICA — DE ONDE TIRAR OS ITENS:
    Os itens devem ser extraídos EXCLUSIVAMENTE da seção/tabela cujo cabeçalho seja:
        • "Discriminação dos Serviços"
        • "Descrição do Serviço"
        • "Descrição dos Serviços Prestados"
        • "Dados dos Produtos / Serviços" (NF-e)
    Geralmente esta tabela tem colunas como: Qtde. | Un. Medida | Descrição | Vlr. Unitário | Total

    NUNCA crie um item a partir das seções abaixo (são tributação/legal, NÃO são serviços):
        ✗ "Imposto Sobre Serviços de Qualquer Natureza - ISS"
        ✗ "LC 116/2003" / "Lei Complementar"
        ✗ "Alíquota" / "Atividade Município" / "Código CNAE"
        ✗ "Valor Total dos Serviços" / "Desconto Incondicionado" / "Deduções Base Cálculo"
        ✗ "Base de Cálculo" / "Total do ISS" / "ISS Retido" / "Desconto Condicionado"
        ✗ "Retenções de Impostos" / "PIS" / "COFINS" / "CP" / "IRRF" / "CSLL" / "Outras Retenções"
        ✗ Linhas isoladas com porcentagem ("2,0581%"), códigos CNAE ("000009.0100001"),
        códigos de lei ("090101"), ou qualquer rótulo de tributo
        ✗ Linhas que sejam APENAS valores monetários sem descrição própria

    - ordemCompra: número da Ordem de Compra (OCP) vinculada à nota, se houver uma página
        "ORDEM DE COMPRA - OCP" no mesmo PDF. Extraia apenas o número (ex.: "900699").
        Use "" se não houver OCP no documento.
    - impostos: { "icms": 0, "iss": 0, "pis": 0, "cofins": 0, "ipi": 0 }
        (todos decimais com ponto; use 0 se não houver)
    - descontos: valor total de descontos da nota fiscal (decimal com ponto; use 0 se não houver)
    - totalProdutos: valor total dos produtos/serviços (decimal)
    - totalNF:        valor total da nota (decimal)

    3. Se algum campo não puder ser determinado, use "" para strings e 0 para números.
    NUNCA coloque "null", "undefined", "N/A" ou rótulos de campo como valor.
    4. NÃO invente dados. Extraia apenas o que estiver explicitamente no texto.
    5. Devolva APENAS o JSON no formato:
    {
    "notas": [
        {
        "numero": "123",
        "serie": "001",
        "dataEmissao": "DD/MM/AAAA",
        "chaveAcesso": "",
        "emitente": { "razaoSocial": "...", "cnpj": "..." },
        "destinatario": { "razaoSocial": "...", "cnpj": "..." },
        "fazenda": "",
        "ordemCompra": "",
        "itens": [
            {
            "descricao": "...", "ncm": "", "cfop": "",
            "unidade": "UN", "quantidade": 1.0,
            "valorUnitario": 100.0, "valorTotal": 100.0
            }
        ],
        "impostos": { "icms": 0, "iss": 0, "pis": 0, "cofins": 0, "ipi": 0 },
        "descontos": 0.0,
        "totalProdutos": 100.0,
        "totalNF": 100.0
        }
    ]
    }
    Sem texto fora do JSON. Sem markdown. Sem comentários.`;

const FIELD_LABELS = [
  'data de emissão', 'data emissão', 'cnpj', 'cpf', 'destinatário', 'remetente',
  'endereço', 'municipio', 'município', 'uf', 'ie', 'inscricao', 'inscrição',
  'fone', 'telefone', 'fax', 'email', 'cep', 'complemento', 'bairro', 'logradouro',
  'nome', 'razão social', 'razao social',
];

const CNPJ_OR_CPF = /^\d{2}\.\d{3}\.\d{3}[/]\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

function nfCleanStr(v) {
  let s = trimStr(v);
  s = s.replace(/(?:^|\s*[-–]\s*)(?:null|undefined|n\/a)\s*$/i, '');
  return s.trim();
}

function nfIsLabel(s) {
  const low = String(s).trim().toLowerCase();
  for (const l of FIELD_LABELS) {
    if (low === l) return true;
  }
  if (/^\d{2}\/\d{2}\/\d{4}/.test(low)) return true;
  return false;
}

function nfNormalizeFazenda(v) {
  let s = nfCleanStr(v);
  if (s === '') return '';
  s = s.replace(/\bS[íi]tio\b/giu, 'Fazenda');
  return s.trim();
}

function sanitizeNotasOut(parsed) {
  const notas = Array.isArray(parsed.notas) ? parsed.notas : [];
  const notasOut = [];

  for (const nota of notas) {
    if (!nota || typeof nota !== 'object') continue;

    const itensOut = [];
    for (const item of (Array.isArray(nota.itens) ? nota.itens : [])) {
      if (!item || typeof item !== 'object') continue;
      const desc = nfCleanStr(item.descricao);
      if (desc === '') continue;
      itensOut.push({
        descricao: desc,
        ncm: nfCleanStr(item.ncm),
        cfop: nfCleanStr(item.cfop),
        unidade: nfCleanStr(item.unidade),
        quantidade: isNumeric(item.quantidade) ? toFloat(item.quantidade) : 0,
        valorUnitario: isNumeric(item.valorUnitario) ? toFloat(item.valorUnitario) : 0,
        valorTotal: isNumeric(item.valorTotal) ? toFloat(item.valorTotal) : 0,
      });
    }

    let destRazao = nfCleanStr(nota.destinatario?.razaoSocial);
    if (nfIsLabel(destRazao)) destRazao = '';

    let destCnpj = nfCleanStr(nota.destinatario?.cnpj);
    if (destCnpj !== '' && !CNPJ_OR_CPF.test(destCnpj)) destCnpj = '';

    let emiCnpj = nfCleanStr(nota.emitente?.cnpj);
    if (emiCnpj !== '' && !CNPJ_OR_CPF.test(emiCnpj)) emiCnpj = '';

    const imp = nota.impostos || {};
    notasOut.push({
      numero: nfCleanStr(nota.numero),
      serie: nfCleanStr(nota.serie),
      dataEmissao: nfCleanStr(nota.dataEmissao),
      chaveAcesso: nfCleanStr(nota.chaveAcesso),
      fazenda: nfNormalizeFazenda(nota.fazenda),
      ordemCompra: nfCleanStr(nota.ordemCompra),
      emitente: {
        razaoSocial: nfCleanStr(nota.emitente?.razaoSocial),
        cnpj: emiCnpj,
      },
      destinatario: {
        razaoSocial: destRazao,
        cnpj: destCnpj,
      },
      itens: itensOut,
      impostos: {
        icms: isNumeric(imp.icms) ? toFloat(imp.icms) : 0,
        iss: isNumeric(imp.iss) ? toFloat(imp.iss) : 0,
        pis: isNumeric(imp.pis) ? toFloat(imp.pis) : 0,
        cofins: isNumeric(imp.cofins) ? toFloat(imp.cofins) : 0,
        ipi: isNumeric(imp.ipi) ? toFloat(imp.ipi) : 0,
      },
      descontos: isNumeric(nota.descontos) ? toFloat(nota.descontos) : 0,
      totalProdutos: isNumeric(nota.totalProdutos) ? toFloat(nota.totalProdutos) : 0,
      totalNF: isNumeric(nota.totalNF) ? toFloat(nota.totalNF) : 0,
    });
  }

  return notasOut;
}

module.exports = { systemPrompt, FIELD_LABELS, CNPJ_OR_CPF, nfCleanStr, nfIsLabel, nfNormalizeFazenda, sanitizeNotasOut };
