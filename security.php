<?php
/**
 * security.php
 * Funções de segurança reutilizáveis para proteção contra ataques
 * - SQL Injection (via prepared statements)
 * - XSS (via sanitização)
 * - CSRF (via validação de origem)
 * - Brute force (via rate limiting)
 */

declare(strict_types=1);

/**
 * Sanitiza string para output em JSON (previne XSS)
 */
function sanitizeForJSON(string $input): string
{
    return htmlspecialchars($input, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

/**
 * Valida que a origem da requisição é confiável
 */
function validateRequestOrigin(): bool
{
    $allowedOrigins = [
        'http://localhost',
        'http://localhost:80',
        'http://localhost:8080',
        'http://127.0.0.1',
        // Adicione domínios de produção conforme necessário
        // 'https://seu-dominio.com.br',
    ];

    $origin = $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '';
    
    foreach ($allowedOrigins as $allowed) {
        if (strpos($origin, $allowed) === 0) {
            return true;
        }
    }
    
    return false;
}

/**
 * Valida formato de email
 */
function isValidEmail(string $email): bool
{
    return filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

/**
 * Verifica taxa de requisições (rate limiting básico)
 * Retorna true se dentro do limite, false se excedido
 */
function checkRateLimit(string $key, int $maxAttempts = 5, int $timeWindow = 900): bool
{
    if (!isset($_SESSION['rate_limits'])) {
        $_SESSION['rate_limits'] = [];
    }

    $now = time();
    $record = $_SESSION['rate_limits'][$key] ?? ['count' => 0, 'reset' => $now + $timeWindow];

    // Reseta se passou o tempo
    if ($now > $record['reset']) {
        $_SESSION['rate_limits'][$key] = ['count' => 1, 'reset' => $now + $timeWindow];
        return true;
    }

    // Incrementa contador
    $record['count']++;
    $_SESSION['rate_limits'][$key] = $record;

    return $record['count'] <= $maxAttempts;
}

/**
 * Valida login (apenas alfanuméricos, underscore, hífen)
 */
function isValidLogin(string $login): bool
{
    return preg_match('/^[a-zA-Z0-9_-]{3,100}$/', $login) === 1;
}

/**
 * Valida nome (permite espaços, letras acentuadas)
 */
function isValidName(string $name): bool
{
    // Permite letras, números, espaços, pontos, hífens
    return preg_match('/^[a-zA-Z0-9\s\.\-áéíóúâêôãõçÁÉÍÓÚÂÊÔÃÕÇ]{3,200}$/', $name) === 1;
}

/**
 * Valida força da senha (mínimo 8 caracteres, maiúscula, minúscula, número)
 */
function isStrongPassword(string $password): bool
{
    return (
        strlen($password) >= 8 &&
        preg_match('/[A-Z]/', $password) &&      // Maiúscula
        preg_match('/[a-z]/', $password) &&      // Minúscula
        preg_match('/[0-9]/', $password)         // Número
    );
}

/**
 * Log seguro de eventos de segurança
 */
function logSecurityEvent(string $event, string $details = '', string $level = 'INFO'): void
{
    $timestamp = date('Y-m-d H:i:s');
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'UNKNOWN';
    $user = $_SESSION['cf_username'] ?? 'ANONYMOUS';
    $message = "[$timestamp] [$level] User=$user | IP=$ip | Event=$event | Details=$details";
    
    error_log($message, 3, __DIR__ . '/security.log');
}

/**
 * Destruição segura de sessão
 */
function destroySessionSecurely(): void
{
    $_SESSION = [];
    
    if (ini_get('session.use_cookies') && !headers_sent()) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'],
            $params['domain'],
            $params['secure'] ?? false,
            $params['httponly'] ?? true
        );
    }
    
    session_destroy();
}

/**
 * Define headers de segurança padrão (já incluídos nos arquivos, mas disponível reutilizável)
 */
function setSecurityHeaders(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('X-XSS-Protection: 1; mode=block');
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
}
