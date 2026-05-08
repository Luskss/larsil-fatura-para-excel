<?php
/**
 * api/usuarios.php
 * Gestão de usuários: listar, criar, excluir, trocar senha.
 *
 * GET    /api/usuarios.php          → lista todos os usuários
 * POST   /api/usuarios.php          → cria usuário  { "login": "...", "nome": "...", "senha": "..." }
 * DELETE /api/usuarios.php          → remove usuário { "login": "..." }
 * PATCH  /api/usuarios.php          → troca senha    { "login": "...", "nova_senha": "..." }
 */

declare(strict_types=1);

// ── HEADERS DE SEGURANÇA ────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('X-XSS-Protection: 1; mode=block');
header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
header('Content-Security-Policy: default-src \'none\'; script-src \'self\'; style-src \'self\' fonts.googleapis.com');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');

// Bloqueia acesso sem sessão autenticada
session_start();
if (empty($_SESSION['cf_loggedIn'])) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Não autenticado.']);
    exit;
}

require_once __DIR__ . '/../config.php';

$method = $_SERVER['REQUEST_METHOD'];

try {
    $pdo = getConnection();

    /* ── GET: listar ────────────────────────────────────────────────────── */
    if ($method === 'GET') {
        $stmt = $pdo->query('SELECT LOGIN, NOME FROM dbo.CONVERSOR_USUARIOS ORDER BY NOME');
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['success' => true, 'usuarios' => $rows]);
        exit;
    }

    /* ── Lê corpo JSON para POST / DELETE / PATCH ───────────────────────── */
    $body = json_decode(file_get_contents('php://input'), true) ?? [];

    /* ── POST: criar ────────────────────────────────────────────────────── */
    if ($method === 'POST') {
        $login = trim($body['login'] ?? '');
        $nome  = trim($body['nome']  ?? '');
        $senha = $body['senha'] ?? '';

        // Validação rigorosa de entrada
        if ($login === '' || $nome === '' || $senha === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Login, nome e senha são obrigatórios.']);
            exit;
        }
        if (strlen($login) > 100 || strlen($nome) > 200 || strlen($senha) > 256) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Dados muito longos.']);
            exit;
        }

        // Verifica se login já existe
        $chk = $pdo->prepare('SELECT 1 FROM dbo.CONVERSOR_USUARIOS WHERE LOGIN = ?');
        $chk->execute([$login]);
        if ($chk->fetch()) {
            http_response_code(409);
            echo json_encode(['success' => false, 'message' => 'Login já cadastrado.']);
            exit;
        }

        $stmt = $pdo->prepare(
            'INSERT INTO dbo.CONVERSOR_USUARIOS (LOGIN, NOME, SENHA) VALUES (?, ?, ?)'
        );
        $stmt->execute([$login, $nome, $senha]);

        echo json_encode(['success' => true, 'message' => 'Usuário criado com sucesso.']);
        exit;
    }

    /* ── DELETE: excluir ────────────────────────────────────────────────── */
    if ($method === 'DELETE') {
        $login = trim($body['login'] ?? '');

        if ($login === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Login é obrigatório.']);
            exit;
        }

        // Impede auto-exclusão
        if ($login === ($_SESSION['cf_username'] ?? '')) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => 'Você não pode excluir seu próprio usuário.']);
            exit;
        }

        $stmt = $pdo->prepare('DELETE FROM dbo.CONVERSOR_USUARIOS WHERE LOGIN = ?');
        $stmt->execute([$login]);

        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Usuário não encontrado.']);
            exit;
        }

        echo json_encode(['success' => true, 'message' => 'Usuário excluído.']);
        exit;
    }

    /* ── PATCH: trocar senha ─────────────────────────────────────────────── */
    if ($method === 'PATCH') {
        $login      = trim($body['login']      ?? '');
        $nova_senha = $body['nova_senha'] ?? '';

        if ($login === '' || $nova_senha === '') {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Login e nova senha são obrigatórios.']);
            exit;
        }
        if (strlen($nova_senha) > 256) {
            http_response_code(400);
            echo json_encode(['success' => false, 'message' => 'Senha muito longa.']);
            exit;
        }

        $stmt = $pdo->prepare('UPDATE dbo.CONVERSOR_USUARIOS SET SENHA = ? WHERE LOGIN = ?');
        $stmt->execute([$nova_senha, $login]);

        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(['success' => false, 'message' => 'Usuário não encontrado.']);
            exit;
        }

        echo json_encode(['success' => true, 'message' => 'Senha atualizada.']);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Método não permitido.']);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Erro no servidor.']);
}
