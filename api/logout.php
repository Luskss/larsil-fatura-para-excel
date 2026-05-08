<?php
declare(strict_types=1);

session_start();

// ── HEADERS DE SEGURANÇA ────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

// Sessão autenticada
if (empty($_SESSION['cf_loggedIn'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Não autenticado.']);
    exit;
}

// Destroi completamente a sessão
$_SESSION = [];
if (ini_get('session.use_cookies') && !headers_sent()) {
    $params = session_get_cookie_params();
    setcookie(
        session_name(),
        '',
        time() - 42000,
        $params['path'],
        $params['domain'],
        $params['secure'],
        $params['httponly']
    );
}
session_destroy();

echo json_encode(['success' => true, 'message' => 'Logout realizado com sucesso.']);
