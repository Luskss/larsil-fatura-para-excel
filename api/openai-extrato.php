<?php

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
    error_log('[openai-extrato] ' . $msg);
}

function emitJson(array $payload, int $status): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($json === false) {
        echo '{"success":false,"message":"Falha ao serializar resposta de erro."}';
        return;
    }
    echo $json;
}

elog('REQ_START method=' . ($_SERVER['REQUEST_METHOD'] ?? '?')
    . ' content_length=' . ($_SERVER['CONTENT_LENGTH'] ?? '?')
    . ' ip=' . ($_SERVER['REMOTE_ADDR'] ?? '?'));

set_exception_handler(static function (Throwable $e): void {
    while (ob_get_level() > 0) ob_end_clean();
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    elog('EXCEPTION: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    echo json_encode([
        'success' => false,
        'message' => 'Erro interno ao processar extrato.',
        'detail'  => $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
});

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

register_shutdown_function(static function (): void {
    $err = error_get_last();
    $isFatal = $err !== null && in_array(
        $err['type'],
        [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR],
        true
    );
    if ($isFatal) {
        while (ob_get_level() > 0) ob_end_clean();
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
        }
        elog('FATAL: ' . $err['message'] . ' @ ' . ($err['file'] ?? '?') . ':' . ($err['line'] ?? '?'));
        emitJson([
            'success' => false,
            'message' => 'Erro fatal no servidor: ' . $err['message'],
        ], 500);
        return;
    }
    // Garante envio do que estiver no buffer; se vazio, devolve JSON de erro.
    $out = '';
    while (ob_get_level() > 0) {
        $out = ob_get_clean() . $out;
    }
    if ($out !== '') {
        echo $out;
    } elseif (!headers_sent()) {
        header('Content-Type: application/json; charset=utf-8');
        elog('EMPTY_BODY: nenhuma resposta gerada (possível timeout/exit silencioso).');
        emitJson([
            'success' => false,
            'message' => 'O servidor não gerou resposta. Verifique tempo limite do PHP/cURL e a chave OpenAI.',
        ], 500);
    }
});

function sendJson(array $payload, int $status = 200): void
{
    while (ob_get_level() > 0) ob_end_clean();
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    if ($json === false) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo '{"success":false,"message":"Falha ao serializar JSON."}';
        exit;
    }
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo $json;
    exit;
}

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
    sendJson(['success' => false, 'message' => 'OPENAI_API_KEY não configurada.'], 500);
}

$body = json_decode(file_get_contents('php://input'), true);
$filename  = trim((string)($body['filename'] ?? ''));
$text      = (string)($body['text'] ?? '');
$images    = $body['images'] ?? null; // array de base64 JPEG (fallback Vision)
$hasImages = is_array($images) && count($images) > 0;

if ($text === '' && !$hasImages) {
    sendJson(['success' => false, 'message' => 'Texto vazio.'], 400);
}

// Limite seguro para caber no contexto do gpt-4o-mini (~128k tokens).
// 1 token ≈ 3-4 chars em PT-BR, então ~120k chars é conservador.
$MAX_CHARS = 120_000;
$wasTruncated = false;
if (!$hasImages && strlen($text) > $MAX_CHARS) {
    $text = substr($text, 0, $MAX_CHARS);
    $wasTruncated = true;
}

$systemPrompt = <<<PROMPT
Você é um analisador de EXTRATOS BANCÁRIOS brasileiros (conta corrente,
poupança, conta digital). Recebe o texto cru extraído do PDF de QUALQUER
banco (Santander, Itaú, Bradesco, Caixa, Banco do Brasil, Inter, Nubank,
C6, Sicoob, Sicredi, BTG, XP, Original, Will, Mercado Pago, etc.) e
devolve EXCLUSIVAMENTE um JSON válido com TODAS as movimentações.

ATENÇÃO CRÍTICA — EXTRAIA TODAS AS LINHAS, SEM EXCEÇÃO:
- Não pule transações. Não resuma.
- Cada linha de movimentação vira UM objeto, mesmo que o banco repita
  a mesma descrição várias vezes no mesmo dia.
- A descrição costuma ocupar 2 linhas (ex.: "PIX RECEBIDO" + nome do
  pagador na linha de baixo). Junte as duas em uma única descrição
  separada por " - " (ex.: "PIX RECEBIDO - Sandro Inocencio Vieira").
- Quando a coluna Data estiver VAZIA, herde a data da linha anterior.
- Valor de movimento com "-" no final (ex.: "1.222,06-") é DÉBITO →
  número NEGATIVO. Sem "-" é CRÉDITO → POSITIVO.
- SALDO: preencha o campo "saldo" SOMENTE quando o valor estiver
  EXPLICITAMENTE escrito naquela linha do extrato (coluna Saldo).
  NUNCA calcule, NUNCA estime, NUNCA repita o saldo da linha anterior.
  Se a coluna Saldo daquela linha estiver vazia → use null.
- Ignore: cabeçalhos, rodapés, totais, "saldo anterior", "saldo do dia",
  textos legais, paginação.

FORMATO DE SAÍDA (apenas JSON, sem markdown, sem comentários):
{
  "bankLabel":   "Nome do Banco - mês/ano",   // ou "" se desconhecido
  "periodLabel": "MM-AAAA",                   // ou ""
  "rows": [
    {
      "data":      "DD/MM",
      "descricao": "PIX RECEBIDO - Fulano",
      "documento": "314869",                  // ou "" / "-"
      "movimento": -1222.06,                  // negativo se débito
      "saldo":     7314.51                    // null se a linha não traz saldo
    }
  ]
}
PROMPT;

$userPrompt = "Arquivo: {$filename}\n\nExtrato:\n----------\n{$text}\n----------";

// Constrói o conteúdo do usuário: texto puro ou imagens (Vision)
if ($hasImages) {
    // PDF-imagem: envia até 6 páginas como JPEG base64 para o modelo Vision
    $userContent = [
        ['type' => 'text', 'text' => "Arquivo: {$filename}\n\nExtrato (lido via imagem):"],
    ];
    foreach (array_slice($images, 0, 6) as $b64) {
        $b64 = preg_replace('/\s+/', '', (string)$b64); // remove eventuais quebras
        $userContent[] = [
            'type'      => 'image_url',
            'image_url' => ['url' => 'data:image/jpeg;base64,' . $b64, 'detail' => 'high'],
        ];
    }
    elog('VISION_REQ pages=' . min(count($images), 6) . ' file=' . $filename);
} else {
    $userContent = $userPrompt;
}

$payload = [
    'model'           => 'gpt-4o-mini',
    'response_format' => ['type' => 'json_object'],
    'temperature'     => 0,
    'top_p'           => 0.1,
    'max_tokens'      => 16384,
    'messages'        => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user',   'content' => $userContent],
    ],
];

$payloadJson = json_encode(
    $payload,
    JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
);
if ($payloadJson === false) {
    sendJson([
        'success' => false,
        'message' => 'Falha ao gerar JSON para OpenAI.',
        'detail'  => json_last_error_msg(),
    ], 500);
}

elog('OPENAI_REQ bytes=' . strlen($payloadJson) . ' head=' . substr($payloadJson, 0, 160) . ' tail=' . substr($payloadJson, -120));

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
    CURLOPT_CONNECTTIMEOUT  => 30,
    CURLOPT_TIMEOUT        => 280,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);
elog('OPENAI_RESP http=' . $httpCode . ' bytes=' . ($response === false ? 'FALSE' : strlen((string)$response)) . ' err=' . $curlErr . ' body=' . substr((string)$response, 0, 400));

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

$decoded      = json_decode($response, true);
$finishReason = $decoded['choices'][0]['finish_reason'] ?? 'stop';
$content      = $decoded['choices'][0]['message']['content'] ?? '';
$parsed       = json_decode($content, true);
$wasTruncatedByTokens = false;

if (!is_array($parsed) && $finishReason === 'length') {
    // OpenAI atingiu o limite de tokens e cortou o JSON no meio.
    // Tenta salvar as transações já geradas fechando o JSON no último objeto completo.
    elog('TOKEN_LIMIT_TRUNCATION: tentando reparar JSON cortado');
    $lastBrace = strrpos($content, '}');
    if ($lastBrace !== false) {
        $repaired = substr($content, 0, $lastBrace + 1) . ']}'; // fecha rows[] e objeto raiz
        $repaired = preg_replace('/,\s*\]/', ']', $repaired);    // remove vírgula pendente
        $parsedRepaired = json_decode($repaired, true);
        if (is_array($parsedRepaired)) {
            $parsed = $parsedRepaired;
            $wasTruncatedByTokens = true;
            elog('TOKEN_LIMIT_REPAIR_OK rows=' . count($parsed['rows'] ?? []));
        }
    }
}

if (!is_array($parsed)) {
    sendJson(['success' => false, 'message' => 'JSON inválido da OpenAI.', 'detail' => substr($content, 0, 500)], 502);
}

// Monta matriz para exportar
$HEADER = ['Data', 'Descrição', 'Nº Documento', 'Movimento (R$)', 'Saldo (R$)'];
$rows   = [$HEADER];

foreach ($parsed['rows'] ?? [] as $r) {
    if (!is_array($r)) continue;
    $data  = trim((string)($r['data']      ?? ''));
    $desc  = trim((string)($r['descricao'] ?? ''));
    $doc   = trim((string)($r['documento'] ?? ''));
    $mov   = $r['movimento'] ?? null;
    $sld   = $r['saldo']     ?? null;

    if ($desc === '' || !is_numeric($mov)) continue;

    $rows[] = [
        $data,
        $desc,
        $doc,
        (float)$mov,
        is_numeric($sld) ? (float)$sld : '',
    ];
}

$result = [
    'success'     => true,
    'periodLabel' => (string)($parsed['periodLabel'] ?? ''),
    'bankLabel'   => (string)($parsed['bankLabel']   ?? ''),
    'rows'        => $rows,
];
if ($wasTruncatedByTokens) {
    $result['warning'] = 'Extrato muito longo: a IA atingiu o limite de tokens e algumas transações do final podem estar ausentes.';
}
sendJson($result);
