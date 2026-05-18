<?php
/**
 * api/openai-nota-fiscal.php
 * Recebe o texto extraído de um PDF de Nota Fiscal (NF-e / NFS-e / NF) e
 * pede ao GPT para identificar os dados estruturados da nota.
 *
 * Entrada (POST JSON):
 *   { "filename": "nf_001.pdf", "text": "..." }
 *
 * Saída (JSON):
 *   {
 *     "success": true,
 *     "notas": [
 *       {
 *         "numero":      "000123",
 *         "serie":       "001",
 *         "dataEmissao": "DD/MM/AAAA",
 *         "chaveAcesso": "...",
 *         "emitente": { "razaoSocial": "...", "cnpj": "..." },
 *         "destinatario": { "razaoSocial": "...", "cnpj": "..." },
 *         "itens": [
 *           { "descricao":"...", "ncm":"...", "cfop":"...", "unidade":"UN",
 *             "quantidade":1.0, "valorUnitario":25.50, "valorTotal":25.50 }
 *         ],
 *         "impostos": { "icms":0,"iss":0,"pis":0,"cofins":0,"ipi":0 },
 *         "totalProdutos": 25.50,
 *         "totalNF":       25.50
 *       }
 *     ]
 *   }
 */

declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('log_errors', '1');
@ini_set('error_log', 'php://stderr');
error_reporting(E_ALL);
@ini_set('memory_limit', '512M');
@ini_set('max_execution_time', '600');
@set_time_limit(600);
ignore_user_abort(true);

ob_start();

function elog(string $msg): void {
    error_log('[openai-nf] ' . $msg);
}

function sendJson(array $payload, int $status = 200): void
{
    while (ob_get_level() > 0) ob_end_clean();
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo ($json !== false) ? $json : '{"success":false,"message":"Falha ao serializar JSON."}';
    exit;
}

set_exception_handler(static function (Throwable $e): void {
    while (ob_get_level() > 0) ob_end_clean();
    elog('EXCEPTION: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'message' => 'Erro interno.', 'detail' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
});

register_shutdown_function(static function (): void {
    $err = error_get_last();
    $isFatal = $err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true);
    if ($isFatal) {
        while (ob_get_level() > 0) ob_end_clean();
        if (!headers_sent()) header('Content-Type: application/json; charset=utf-8');
        elog('FATAL: ' . $err['message']);
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Erro fatal: ' . $err['message']], JSON_UNESCAPED_UNICODE);
        return;
    }
    $out = '';
    while (ob_get_level() > 0) $out = ob_get_clean() . $out;
    if ($out !== '') echo $out;
    elseif (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
        elog('EMPTY_BODY');
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Servidor não gerou resposta.'], JSON_UNESCAPED_UNICODE);
    }
});

session_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendJson(['success' => false, 'message' => 'Método não permitido.'], 405);
}

if (empty($_SESSION['cf_loggedIn'])) {
    sendJson(['success' => false, 'message' => 'Não autenticado.'], 401);
}

require_once __DIR__ . '/../config.php';

$apiKey = trim((string)($_ENV['OPENAI_API_KEY'] ?? ''));
if ($apiKey === '') {
    sendJson(['success' => false, 'message' => 'OPENAI_API_KEY não configurada no .env.'], 500);
}

$body     = json_decode(file_get_contents('php://input'), true);
$filename = trim((string)($body['filename'] ?? ''));
$text     = (string)($body['text'] ?? '');
$images   = is_array($body['images'] ?? null) ? $body['images'] : [];

if ($text === '' && empty($images)) {
    sendJson(['success' => false, 'message' => 'Texto do PDF não enviado.'], 400);
}

elog('REQ_START filename=' . basename($filename) . ' text_len=' . strlen($text) . ' images=' . count($images));

$MAX_CHARS = 120_000;
if (strlen($text) > $MAX_CHARS) {
    $text = substr($text, 0, $MAX_CHARS);
}

// Sanitiza imagens: aceita apenas data URIs JPEG/PNG, limita a 6 imagens, limita tamanho de cada (~5MB base64)
$validImages = [];
foreach ($images as $img) {
    if (!is_string($img)) continue;
    if (!preg_match('#^data:image/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$#', $img)) continue;
    if (strlen($img) > 7_000_000) continue; // ~5MB binary
    $validImages[] = $img;
    if (count($validImages) >= 6) break;
}
$images = $validImages;

// ── PROMPT ──────────────────────────────────────────────────────────────
$systemPrompt = <<<PROMPT
Você é um analisador de Notas Fiscais brasileiras (NF-e, NFS-e, NF de papel).
Recebe o texto cru extraído do PDF de uma ou mais notas fiscais e devolve
EXCLUSIVAMENTE um JSON válido com os dados estruturados de cada nota.

════════════════════════════════════════════════════════════════
LAYOUTS CONHECIDOS — leia ANTES de extrair qualquer campo
════════════════════════════════════════════════════════════════

LAYOUT A — DANFE / NF-e (nota de produto, ex.: COCARI)
  Marcadores: "DANFE", "NOTA FISCAL ELETRÔNICA", "NF-e"
  • emitente  → bloco "IDENTIFICAÇÃO DO EMITENTE" ou "Recebemos de … os produtos"
  • destinatário → bloco "DESTINATÁRIO/REMETENTE" → linha com nome + CNPJ/CPF
  • número    → "N°: XXXXXX" ou "Nº XXXXXX" no canto superior direito
  • itens     → tabela "DADOS DOS PRODUTOS/SERVIÇOS" (colunas NCM, CFOP, QUANT, V.UNIT, V.TOTAL)

LAYOUT B — NFS-e Municipal (prefeitura), padrão "Ariane / Telêmaco Borba"
  Marcadores: "Nota Fiscal de Serviço Eletrônica", "Série NFS-e", "TOMADOR DO SERVIÇO", "PRESTADOR"
  • emitente  → seção "PRESTADOR DO SERVIÇO" ou cabeçalho com nome + CNPJ antes do brasão da prefeitura
                Campo chave: linha com CNPJ/CPF logo abaixo do nome do prestador
  • destinatário → seção "TOMADOR DO SERVIÇO" → "Nome/Razão Social" + "CPF/CNPJ"
  • número    → campo "Número da NFS-e" (canto superior direito ou cabeçalho)
  • itens     → campo "Descrição do Serviço" — cada linha = 1 item (veja regra NOTA DE SERVIÇO)
  • totalNF   → "Valor Líquido" ou "Valor Total" da nota
  ATENÇÃO: neste layout o campo "Inscrição Municipal", "Situação", "Tipo", datas e
  rótulos de tabela NÃO são nome de empresa — ignore-os para razaoSocial.

LAYOUT C — DANFSe v1.0 (Documento Auxiliar da NFS-e, ex.: Santa Rita do Pardo-MS)
  Marcadores: "DANFSe", "Documento Auxiliar da NFS-e", "EMITENTE DA NFS-e"
  • emitente  → seção "EMITENTE DA NFS-e" → "Nome / Nome Empresarial" + "CNPJ / CPF / NIF"
  • destinatário → seção "TOMADOR DO SERVIÇO" → "Nome / Nome Empresarial" + "CNPJ / CPF / NIF"
  • número    → campo "Número da NFS-e" (topo)
  • itens     → campo "Descrição do Serviço" — cada linha = 1 item com valor embutido
                (ex.: "Limpeza Hilux/RHP5J57 R$180,00" → descricao="Limpeza Hilux/RHP5J57", valorTotal=180.00)
  • totalNF   → "Valor Líquido da NFS-e" ou "Valor do Serviço"

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
       (ex.: "R$ 150,00 R$ 0,00 R$ 0,00" — isso é tabela de impostos, não item)

   Exemplo do que extrair vs ignorar:
     ┌─ Discriminação dos Serviços ────────────────────────────────────┐
     │ Qtde. Un.Medida Descrição        Vlr. Unitário  Total           │  ← USE ISTO
     │ 1,00  UN        DIARIA HOTEL     150,00         R$ 150,00       │  ← 1 ITEM
     ├─ Imposto Sobre Serviços (ISS) ──────────────────────────────────┤
     │ LC 116/2003: 090101                                             │  ← IGNORE
     │ Hospedagem em hotéis... 2,0581% 000009.0100001                  │  ← IGNORE
     │ Valor Total dos Serviços  Total do ISS  R$ 150,00  R$ 3,09     │  ← IGNORE
     └─────────────────────────────────────────────────────────────────┘
   Resultado correto: itens = [{ descricao:"DIARIA HOTEL", quantidade:1, valorUnitario:150, valorTotal:150, unidade:"UN" }]
   (1 único item, NÃO 6 itens.)

   - impostos: { "icms": 0, "iss": 0, "pis": 0, "cofins": 0, "ipi": 0 }
     (todos decimais com ponto; use 0 se não houver)
   - totalProdutos: valor total dos produtos/serviços (decimal)
   - totalNF:       valor total da nota (decimal)

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
      "itens": [
        {
          "descricao": "...", "ncm": "", "cfop": "",
          "unidade": "UN", "quantidade": 1.0,
          "valorUnitario": 100.0, "valorTotal": 100.0
        }
      ],
      "impostos": { "icms": 0, "iss": 0, "pis": 0, "cofins": 0, "ipi": 0 },
      "totalProdutos": 100.0,
      "totalNF": 100.0
    }
  ]
}
Sem texto fora do JSON. Sem markdown. Sem comentários.
PROMPT;

$userPrompt = "Arquivo: {$filename}\n\nTexto da nota fiscal:\n----------\n{$text}\n----------";

// Se houver imagens (PDF escaneado), usa modelo Vision e content multimodal
$useVision = !empty($images);
$userContent = $useVision
    ? array_merge(
        [['type' => 'text', 'text' => $userPrompt . "\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia TODOS os dados das imagens anexas (ignore o nome do arquivo se a imagem tiver os valores)."]],
        array_map(function($img) {
            return ['type' => 'image_url', 'image_url' => ['url' => $img, 'detail' => 'high']];
        }, $images)
      )
    : $userPrompt;

$payload = [
    'model'           => $useVision ? 'gpt-4o' : 'gpt-4o-mini',
    'response_format' => ['type' => 'json_object'],
    'temperature'     => 0,
    'top_p'           => 0.1,
    'max_tokens'      => 16000,
    'messages'        => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user',   'content' => $userContent],
    ],
];

$payloadJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
if ($payloadJson === false) {
    sendJson(['success' => false, 'message' => 'Falha ao gerar JSON para OpenAI.', 'detail' => json_last_error_msg()], 500);
}

if (!function_exists('curl_init')) {
    sendJson(['success' => false, 'message' => 'Extensão cURL não habilitada no PHP.'], 500);
}

$ch = curl_init('https://api.openai.com/v1/chat/completions');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payloadJson,
    CURLOPT_HTTP_VERSION   => CURL_HTTP_VERSION_1_1,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $apiKey,
        'Expect:',
        'Transfer-Encoding:',
    ],
    CURLOPT_CONNECTTIMEOUT => 30,
    CURLOPT_TIMEOUT        => 280,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

elog('OPENAI_RESP http=' . $httpCode . ' bytes=' . ($response === false ? 'FALSE' : strlen((string)$response)) . ' curl_err=' . $curlErr);

if ($response === false) {
    sendJson(['success' => false, 'message' => 'Falha ao contatar OpenAI: ' . $curlErr], 502);
}

if ($httpCode < 200 || $httpCode >= 300) {
    $errDecoded = json_decode($response, true);
    $errMessage = $errDecoded['error']['message'] ?? null;
    sendJson([
        'success' => false,
        'message' => 'OpenAI HTTP ' . $httpCode,
        'detail'  => $errMessage ?: substr($response, 0, 500),
    ], 502);
}

$decoded = json_decode($response, true);
$content = $decoded['choices'][0]['message']['content'] ?? '';
$parsed  = json_decode($content, true);

if (!is_array($parsed)) {
    sendJson(['success' => false, 'message' => 'JSON inválido da OpenAI.', 'detail' => substr($content, 0, 500)], 502);
}

$notas = $parsed['notas'] ?? [];

// ── HELPERS DE SANEAMENTO ────────────────────────────────────────────────
$FIELD_LABELS = [
    'data de emissão','data emissão','cnpj','cpf','destinatário','remetente',
    'endereço','municipio','município','uf','ie','inscricao','inscrição',
    'fone','telefone','fax','email','cep','complemento','bairro','logradouro',
    'nome','razão social','razao social',
];

function nf_clean_str($v): string {
    $s = trim((string)$v);
    // remove literais "null"/"undefined"/"N/A" isolados (case-insensitive)
    $s = preg_replace('/(?:^|\s*[-–]\s*)(?:null|undefined|n\/a)\s*$/i', '', $s);
    return trim($s);
}

function nf_is_label(string $s, array $labels): bool {
    $low = mb_strtolower(trim($s));
    foreach ($labels as $l) {
        if ($low === $l) return true;
    }
    // rejeita também se parecer uma data (DD/MM/AAAA) no início
    if (preg_match('/^\d{2}\/\d{2}\/\d{4}/', $low)) return true;
    return false;
}

function nf_normalize_fazenda($v): string {
    $s = nf_clean_str($v);
    if ($s === '') return '';
    // Normaliza variações de "Sítio/Sitio" para "Fazenda"
    $s = preg_replace('/\bS[íi]tio\b/iu', 'Fazenda', $s);
    return trim($s);
}

$notasOut = [];
foreach ($notas as $nota) {
    if (!is_array($nota)) continue;

    $itensOut = [];
    foreach ($nota['itens'] ?? [] as $item) {
        if (!is_array($item)) continue;
        $desc = nf_clean_str($item['descricao'] ?? '');
        if ($desc === '') continue;
        $itensOut[] = [
            'descricao'    => $desc,
            'ncm'          => nf_clean_str($item['ncm']     ?? ''),
            'cfop'         => nf_clean_str($item['cfop']    ?? ''),
            'unidade'      => nf_clean_str($item['unidade'] ?? ''),
            'quantidade'   => is_numeric($item['quantidade']    ?? null) ? (float)$item['quantidade']    : 0,
            'valorUnitario'=> is_numeric($item['valorUnitario'] ?? null) ? (float)$item['valorUnitario'] : 0,
            'valorTotal'   => is_numeric($item['valorTotal']    ?? null) ? (float)$item['valorTotal']    : 0,
        ];
    }

    $destRazao = nf_clean_str($nota['destinatario']['razaoSocial'] ?? '');
    if (nf_is_label($destRazao, $FIELD_LABELS)) $destRazao = '';

    $destCnpj = nf_clean_str($nota['destinatario']['cnpj'] ?? '');
    // Aceita CNPJ ou CPF; rejeita qualquer outra coisa
    if ($destCnpj !== '' && !preg_match('/^\d{2}\.\d{3}\.\d{3}[\/]\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/', $destCnpj)) {
        $destCnpj = '';
    }

    $emiCnpj = nf_clean_str($nota['emitente']['cnpj'] ?? '');
    if ($emiCnpj !== '' && !preg_match('/^\d{2}\.\d{3}\.\d{3}[\/]\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/', $emiCnpj)) {
        $emiCnpj = '';
    }

    $imp = $nota['impostos'] ?? [];
    $notasOut[] = [
        'numero'       => nf_clean_str($nota['numero']      ?? ''),
        'serie'        => nf_clean_str($nota['serie']       ?? ''),
        'dataEmissao'  => nf_clean_str($nota['dataEmissao'] ?? ''),
        'chaveAcesso'  => nf_clean_str($nota['chaveAcesso'] ?? ''),
        'fazenda'      => nf_normalize_fazenda($nota['fazenda'] ?? ''),
        'emitente'     => [
            'razaoSocial' => nf_clean_str($nota['emitente']['razaoSocial'] ?? ''),
            'cnpj'        => $emiCnpj,
        ],
        'destinatario' => [
            'razaoSocial' => $destRazao,
            'cnpj'        => $destCnpj,
        ],
        'itens'        => $itensOut,
        'impostos'     => [
            'icms'   => is_numeric($imp['icms']   ?? null) ? (float)$imp['icms']   : 0,
            'iss'    => is_numeric($imp['iss']    ?? null) ? (float)$imp['iss']    : 0,
            'pis'    => is_numeric($imp['pis']    ?? null) ? (float)$imp['pis']    : 0,
            'cofins' => is_numeric($imp['cofins'] ?? null) ? (float)$imp['cofins'] : 0,
            'ipi'    => is_numeric($imp['ipi']    ?? null) ? (float)$imp['ipi']    : 0,
        ],
        'totalProdutos'=> is_numeric($nota['totalProdutos'] ?? null) ? (float)$nota['totalProdutos'] : 0,
        'totalNF'      => is_numeric($nota['totalNF']       ?? null) ? (float)$nota['totalNF']       : 0,
    ];
}

sendJson(['success' => true, 'notas' => $notasOut]);
