<?php
/**
 * api/openai-nota-fiscal-resumo.php
 * Resumo simples de Nota Fiscal por IA. Extrai apenas:
 *   - numero, dataEmissao
 *   - emitente { razaoSocial, cnpj }
 *   - destinatario { razaoSocial, cnpj, endereco }
 *   - itens [{ descricao }]
 *   - totalNF
 *
 * Entrada (POST JSON): { "filename": "...", "text": "...", "images": [...] }
 * Saída: { success: true, notas: [...] }
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

function relog(string $msg): void { error_log('[openai-nf-resumo] ' . $msg); }

function rsendJson(array $payload, int $status = 200): void {
    while (ob_get_level() > 0) ob_end_clean();
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo ($json !== false) ? $json : '{"success":false,"message":"Falha ao serializar JSON."}';
    exit;
}

set_exception_handler(static function (Throwable $e): void {
    while (ob_get_level() > 0) ob_end_clean();
    relog('EXCEPTION: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
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
        relog('FATAL: ' . $err['message']);
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Erro fatal: ' . $err['message']], JSON_UNESCAPED_UNICODE);
    }
});

if (session_status() === PHP_SESSION_NONE) session_start();

if (empty($_SESSION['cf_loggedIn'])) {
    rsendJson(['success' => false, 'message' => 'Não autenticado.'], 401);
}

require_once __DIR__ . '/../config.php';

$apiKey = trim((string)($_ENV['OPENAI_API_KEY'] ?? ''));
if ($apiKey === '') {
    rsendJson(['success' => false, 'message' => 'OPENAI_API_KEY não configurada no .env.'], 500);
}

$body     = json_decode(file_get_contents('php://input'), true);
$filename = trim((string)($body['filename'] ?? ''));
$text     = (string)($body['text'] ?? '');
$images   = is_array($body['images'] ?? null) ? $body['images'] : [];

if ($text === '' && empty($images)) {
    rsendJson(['success' => false, 'message' => 'Texto do PDF não enviado.'], 400);
}

relog('REQ_START filename=' . basename($filename) . ' text_len=' . strlen($text) . ' images=' . count($images));

$MAX_CHARS = 120_000;
if (strlen($text) > $MAX_CHARS) $text = substr($text, 0, $MAX_CHARS);

$validImages = [];
foreach ($images as $img) {
    if (!is_string($img)) continue;
    if (!preg_match('#^data:image/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$#', $img)) continue;
    if (strlen($img) > 7_000_000) continue;
    $validImages[] = $img;
    if (count($validImages) >= 6) break;
}
$images = $validImages;

$systemPrompt = <<<PROMPT
Você é um analisador de Notas Fiscais brasileiras (NF-e, NFS-e, NF de papel).
Sua tarefa é gerar um RESUMO SIMPLES de cada nota presente no texto, extraindo
APENAS os campos abaixo. Devolva EXCLUSIVAMENTE um JSON válido.

Campos a extrair, por nota:
  - numero        : número da NF (somente dígitos, sem zeros à esquerda obrigatórios)
  - dataEmissao   : data de emissão no formato "DD/MM/AAAA"
  - emitente:
      razaoSocial : nome da empresa/pessoa emitente
      cnpj        : "XX.XXX.XXX/XXXX-XX" ou "XXX.XXX.XXX-XX" (CPF)
  - destinatario:
      razaoSocial : nome da empresa/pessoa destinatária
      cnpj        : "XX.XXX.XXX/XXXX-XX" ou "XXX.XXX.XXX-XX" (CPF)
      endereco    : endereço completo do destinatário em uma única string
                    (logradouro, número, bairro, município, UF, CEP — o que estiver disponível)
  - itens         : lista contendo APENAS o campo descricao de cada produto/serviço
                    Ex.: [{ "descricao": "..." }, { "descricao": "..." }]
  - totalNF       : valor total da nota como número decimal (ponto como separador)

REGRAS:
1. Identifique TODAS as notas presentes (pode haver mais de uma por PDF).
2. NÃO inclua nenhum outro campo (sem itens detalhados, sem impostos, sem fazenda etc.).
3. Se algum campo não puder ser determinado, use "" para strings e 0 para números.
4. NUNCA invente. Use apenas o que estiver explicitamente no texto/imagem.
5. NUNCA use rótulos ("CNPJ", "DESTINATÁRIO", "DATA DE EMISSÃO") como valor.
6. Devolva APENAS este JSON, sem markdown ou comentários:

{
  "notas": [
    {
      "numero": "123",
      "dataEmissao": "DD/MM/AAAA",
      "emitente":     { "razaoSocial": "...", "cnpj": "..." },
      "destinatario": { "razaoSocial": "...", "cnpj": "...", "endereco": "..." },
      "itens": [ { "descricao": "..." } ],
      "totalNF": 100.0
    }
  ]
}
PROMPT;

$userPrompt = "Arquivo: {$filename}\n\nTexto da nota fiscal:\n----------\n{$text}\n----------";

$useVision = !empty($images);
$userContent = $useVision
    ? array_merge(
        [['type' => 'text', 'text' => $userPrompt . "\n\nIMPORTANTE: o texto acima está vazio porque o PDF é uma imagem escaneada. Extraia os dados das imagens anexas."]],
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
    'max_tokens'      => 8000,
    'messages'        => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user',   'content' => $userContent],
    ],
];

$payloadJson = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
if ($payloadJson === false) {
    rsendJson(['success' => false, 'message' => 'Falha ao gerar JSON para OpenAI.', 'detail' => json_last_error_msg()], 500);
}

if (!function_exists('curl_init')) {
    rsendJson(['success' => false, 'message' => 'Extensão cURL não habilitada no PHP.'], 500);
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

relog('OPENAI_RESP http=' . $httpCode . ' bytes=' . ($response === false ? 'FALSE' : strlen((string)$response)) . ' curl_err=' . $curlErr);

if ($response === false) {
    rsendJson(['success' => false, 'message' => 'Falha ao contatar OpenAI: ' . $curlErr], 502);
}
if ($httpCode < 200 || $httpCode >= 300) {
    $errDecoded = json_decode($response, true);
    $errMessage = $errDecoded['error']['message'] ?? null;
    rsendJson([
        'success' => false,
        'message' => 'OpenAI HTTP ' . $httpCode,
        'detail'  => $errMessage ?: substr($response, 0, 500),
    ], 502);
}

$decoded = json_decode($response, true);
$content = $decoded['choices'][0]['message']['content'] ?? '';
$parsed  = json_decode($content, true);

if (!is_array($parsed)) {
    rsendJson(['success' => false, 'message' => 'JSON inválido da OpenAI.', 'detail' => substr($content, 0, 500)], 502);
}

$notas = $parsed['notas'] ?? [];

function rclean($v): string {
    $s = trim((string)$v);
    $s = preg_replace('/(?:^|\s*[-–]\s*)(?:null|undefined|n\/a)\s*$/i', '', $s);
    return trim($s);
}

$notasOut = [];
foreach ($notas as $nota) {
    if (!is_array($nota)) continue;

    $itensOut = [];
    foreach ($nota['itens'] ?? [] as $item) {
        if (!is_array($item)) continue;
        $desc = rclean($item['descricao'] ?? '');
        if ($desc === '') continue;
        $itensOut[] = ['descricao' => $desc];
    }

    $emiCnpj = rclean($nota['emitente']['cnpj'] ?? '');
    if ($emiCnpj !== '' && !preg_match('/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/', $emiCnpj)) {
        $emiCnpj = '';
    }
    $destCnpj = rclean($nota['destinatario']['cnpj'] ?? '');
    if ($destCnpj !== '' && !preg_match('/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/', $destCnpj)) {
        $destCnpj = '';
    }

    $notasOut[] = [
        'numero'      => rclean($nota['numero']      ?? ''),
        'dataEmissao' => rclean($nota['dataEmissao'] ?? ''),
        'emitente'    => [
            'razaoSocial' => rclean($nota['emitente']['razaoSocial'] ?? ''),
            'cnpj'        => $emiCnpj,
        ],
        'destinatario' => [
            'razaoSocial' => rclean($nota['destinatario']['razaoSocial'] ?? ''),
            'cnpj'        => $destCnpj,
            'endereco'    => rclean($nota['destinatario']['endereco'] ?? ''),
        ],
        'itens'   => $itensOut,
        'totalNF' => is_numeric($nota['totalNF'] ?? null) ? (float)$nota['totalNF'] : 0,
    ];
}

rsendJson(['success' => true, 'notas' => $notasOut]);
