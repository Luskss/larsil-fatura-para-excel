<?php
/**
 * api/openai-parse.php
 * Recebe o texto extraído de um PDF (já feito no navegador via pdf.js) e
 * pede ao modelo da OpenAI para identificar transações de fatura de cartão
 * de qualquer banco (Itaú, Bradesco, Santander, Nubank, Caixa, BB, Inter,
 * C6, Sicoob, Sicredi, etc.).
 *
 * Entrada (POST JSON):
 *   {
 *     "filename": "fatura_xxx.pdf",
 *     "text":     "linha 1\nlinha 2\n..."   // texto cru do PDF
 *   }
 *
 * Saída (JSON):
 *   {
 *     "success": true,
 *     "periodLabel": "MM-AAAA",
 *     "sheetsMap": {
 *        "NOME - final 1234": [
 *           ["Data","Descrição","Parcela","Valor (R$)"],
 *           ["── DESPESAS ──","","",""],
 *           ["12/04","SUPERMERCADO X","", 123.45],
 *           ...
 *        ]
 *     }
 *   }
 *
 * A chave `OPENAI_API_KEY` é lida do arquivo .env via config.php — NUNCA
 * é exposta ao navegador.
 */

declare(strict_types=1);

session_start();

// ── HEADERS DE SEGURANÇA ────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

// Só aceita POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.']);
    exit;
}

// Exige sessão autenticada (mesmo padrão usado nos demais endpoints)
if (empty($_SESSION['cf_loggedIn'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Não autenticado.']);
    exit;
}

require_once __DIR__ . '/../config.php';

$apiKey = $_ENV['OPENAI_API_KEY'] ?? '';
if ($apiKey === '') {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Chave OPENAI_API_KEY não configurada no .env.']);
    exit;
}

// ── ENTRADA ─────────────────────────────────────────────────────────────
$body = file_get_contents('php://input');
$data = json_decode($body, true);

$filename = trim((string)($data['filename'] ?? ''));
$text     = (string)($data['text'] ?? '');

if ($text === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Texto do PDF não enviado.']);
    exit;
}

// Limite de segurança (evita custo descontrolado): 250 KB ~ 60-80k tokens
$MAX_CHARS = 250_000;
if (strlen($text) > $MAX_CHARS) {
    $text = substr($text, 0, $MAX_CHARS);
}

// ── PROMPT ──────────────────────────────────────────────────────────────
$systemPrompt = <<<PROMPT
Você é um analisador de faturas de cartão de crédito brasileiras. Recebe o
texto cru (extraído por OCR/PDF) de uma fatura de QUALQUER banco (Itaú,
Bradesco, Santander, Nubank, Caixa, Banco do Brasil, Inter, C6, Sicoob,
Sicredi, BTG, XP, Original, Will, Mercado Pago, PicPay, etc.) e devolve
EXCLUSIVAMENTE um JSON válido com as transações extraídas.

REGRAS:
1. Identifique cada CARTÃO presente na fatura (titular + 4 últimos dígitos).
   - Rótulo do cartão: "NOME SOBRENOME - final 1234".
   - Se a fatura tiver vários cartões/portadores, separe cada um em sua chave.
   - Se não houver identificação clara, use "Fatura".
2. Para cada cartão, agrupe as transações em até 3 SEÇÕES, nesta ordem:
      "PAGAMENTO E DEMAIS CRÉDITOS"
      "DESPESAS"
      "PARCELAMENTOS"
   Pule seções vazias.
3. Cada transação tem: Data (DD/MM), Descrição (curta, sem códigos lixo),
   Parcela (formato "NN/NN" se houver, senão ""), Valor (número decimal
   com ponto, sinal NEGATIVO para créditos/pagamentos/estornos).
4. Detecte o período da fatura no formato "MM-AAAA" (mês de vencimento ou
   referência). Se não for possível, devolva "".
5. NÃO invente transações. Ignore: limites, anuidades, taxas resumo,
   cabeçalhos, totais, "saldo anterior", "valor total da fatura".
6. Devolva APENAS o JSON no formato:
{
  "periodLabel": "MM-AAAA" ou "",
  "cards": [
    {
      "label": "NOME - final 1234",
      "sections": {
        "PAGAMENTO E DEMAIS CRÉDITOS": [
          {"data":"DD/MM","descricao":"...","parcela":"","valor":-123.45}
        ],
        "DESPESAS": [
          {"data":"DD/MM","descricao":"...","parcela":"02/10","valor":99.90}
        ],
        "PARCELAMENTOS": []
      }
    }
  ]
}
Sem texto fora do JSON. Sem markdown. Sem comentários.
PROMPT;

$userPrompt = "Arquivo: {$filename}\n\nTexto da fatura:\n----------\n{$text}\n----------";

// ── CHAMADA À OPENAI ────────────────────────────────────────────────────
$payload = [
    'model'           => 'gpt-4o-mini',
    'response_format' => ['type' => 'json_object'],
    'temperature'     => 0,
    'messages'        => [
        ['role' => 'system', 'content' => $systemPrompt],
        ['role' => 'user',   'content' => $userPrompt],
    ],
];

$ch = curl_init('https://api.openai.com/v1/chat/completions');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $apiKey,
    ],
    CURLOPT_TIMEOUT        => 120,
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['success' => false, 'message' => 'Falha ao contatar OpenAI: ' . $curlErr]);
    exit;
}

if ($httpCode < 200 || $httpCode >= 300) {
    http_response_code(502);
    echo json_encode([
        'success' => false,
        'message' => 'OpenAI retornou HTTP ' . $httpCode,
        'detail'  => substr($response, 0, 500),
    ]);
    exit;
}

$decoded = json_decode($response, true);
$content = $decoded['choices'][0]['message']['content'] ?? '';
if ($content === '') {
    http_response_code(502);
    echo json_encode(['success' => false, 'message' => 'Resposta vazia da OpenAI.']);
    exit;
}

$parsed = json_decode($content, true);
if (!is_array($parsed)) {
    http_response_code(502);
    echo json_encode([
        'success' => false,
        'message' => 'Resposta da OpenAI não é JSON válido.',
        'detail'  => substr($content, 0, 500),
    ]);
    exit;
}

// ── CONVERSÃO PARA O FORMATO sheetsMap DO CONVERSOR ─────────────────────
$HEADER = ['Data', 'Descrição', 'Parcela', 'Valor (R$)'];
$sheetsMap = [];

$cards = $parsed['cards'] ?? [];
if (!is_array($cards) || count($cards) === 0) {
    $sheetsMap['Fatura'] = [$HEADER];
} else {
    foreach ($cards as $card) {
        $label = trim((string)($card['label'] ?? '')) ?: 'Fatura';
        $sheet = [$HEADER];

        $sectionsOrder = ['PAGAMENTO E DEMAIS CRÉDITOS', 'DESPESAS', 'PARCELAMENTOS'];
        $sectionsObj   = $card['sections'] ?? [];

        foreach ($sectionsOrder as $secName) {
            $rows = $sectionsObj[$secName] ?? [];
            if (!is_array($rows) || count($rows) === 0) continue;

            $sheet[] = ["── {$secName} ──", '', '', ''];
            foreach ($rows as $tx) {
                if (!is_array($tx)) continue;
                $data      = trim((string)($tx['data']      ?? ''));
                $descricao = trim((string)($tx['descricao'] ?? ''));
                $parcela   = trim((string)($tx['parcela']   ?? ''));
                $valor     = $tx['valor'] ?? null;

                if ($descricao === '' || !is_numeric($valor)) continue;
                $sheet[] = [$data, $descricao, $parcela, (float)$valor];
            }
        }

        // Garante unicidade do rótulo
        $finalLabel = $label;
        $n = 2;
        while (isset($sheetsMap[$finalLabel])) {
            $finalLabel = $label . " ({$n})";
            $n++;
        }
        $sheetsMap[$finalLabel] = $sheet;
    }
}

echo json_encode([
    'success'     => true,
    'periodLabel' => (string)($parsed['periodLabel'] ?? ''),
    'sheetsMap'   => $sheetsMap,
], JSON_UNESCAPED_UNICODE);
