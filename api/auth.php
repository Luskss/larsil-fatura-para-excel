<?php
/**
 * api/auth.php
 * Endpoint de autenticação — consulta dbo.CONVERSOR_USUARIOS no SQL Server.
 *
 * Espera POST JSON: { "username": "...", "password": "..." }
 * Retorna JSON:     { "success": true/false, "message": "...", "username": "..." }
 *
 * A senha deve estar armazenada na coluna SENHA como hash bcrypt (password_hash).
 * Se a sua tabela armazena senha em texto plano, veja o comentário na seção de verificação.
 */

declare(strict_types=1);

session_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// Só aceita POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.']);
    exit;
}

require_once __DIR__ . '/../config.php';

// Lê o corpo JSON
$body = file_get_contents('php://input');
$data = json_decode($body, true);

$username = trim($data['username'] ?? '');
$password = $data['password'] ?? '';

// Validação básica de entrada
if ($username === '' || $password === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Usuário e senha são obrigatórios.']);
    exit;
}

// Limita o tamanho para evitar abusos
if (strlen($username) > 100 || strlen($password) > 256) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Dados inválidos.']);
    exit;
}

try {
    $pdo = getConnection();

    // Busca o usuário pela coluna LOGIN
    $stmt = $pdo->prepare(
        'SELECT LOGIN, SENHA, NOME
         FROM dbo.CONVERSOR_USUARIOS
         WHERE LOGIN = ?'
    );
    $stmt->execute([$username]);
    $row = $stmt->fetch();

    if (!$row) {
        // Usuário não encontrado — resposta genérica (não revela qual campo errou)
        respondUnauthorized();
    }

    // ── Verificação de senha (texto plano) ──────────────────────────────
    $senhaValida = hash_equals($row['SENHA'], $password);
    // ────────────────────────────────────────────────────────────────────

    if (!$senhaValida) {
        respondUnauthorized();
    }

    // Login bem-sucedido — inicia sessão PHP server-side
    session_regenerate_id(true);
    $_SESSION['cf_loggedIn'] = true;
    $_SESSION['cf_username'] = $row['LOGIN'];

    echo json_encode([
        'success'  => true,
        'message'  => 'Login realizado com sucesso.',
        'username' => $row['NOME'] ?? $row['LOGIN'],
    ]);

} catch (PDOException $e) {
    error_log('[conversor-fatura] DB error: ' . $e->getMessage());
    http_response_code(500);
    // Retorna detalhes do erro para facilitar o diagnóstico (remova em produção)
    echo json_encode(['success' => false, 'message' => 'Erro de conexão: ' . $e->getMessage()]);
}

// ── helper ────────────────────────────────────────────────────────────────
function respondUnauthorized(): never
{
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Usuário ou senha incorretos.']);
    exit;
}
