<?php
// ARQUIVO TEMPORÁRIO DE DIAGNÓSTICO — apague após resolver o problema

error_reporting(E_ALL);
ini_set('display_errors', '1');

echo "<pre>";

// 1. Verifica extensões
echo "=== Extensões PHP ===\n";
echo "pdo_sqlsrv carregada: " . (extension_loaded('pdo_sqlsrv') ? "SIM ✓" : "NÃO ✗") . "\n";
echo "sqlsrv carregada:     " . (extension_loaded('sqlsrv')     ? "SIM ✓" : "NÃO ✗") . "\n\n";

// 2. Lê o .ENV
echo "=== Variáveis do .ENV ===\n";
$envPath = __DIR__ . '/.ENV';
if (!file_exists($envPath)) {
    echo "ERRO: arquivo .ENV não encontrado em $envPath\n";
} else {
    $env = [];
    $content = file_get_contents($envPath);
    // Remove BOM UTF-8
    $content = ltrim($content, "\xEF\xBB\xBF");
    // Converte UTF-16 para UTF-8 se necessário
    if (substr($content, 0, 2) === "\xFF\xFE" || substr($content, 0, 2) === "\xFE\xFF") {
        $content = mb_convert_encoding($content, 'UTF-8', 'UTF-16');
        $content = ltrim($content, "\xEF\xBB\xBF");
    }
    foreach (explode("\n", str_replace("\r\n", "\n", $content)) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) continue;
        [$k, $v] = array_map('trim', explode('=', $line, 2));
        $env[$k] = $v;
    }
    echo "DB_SERVER:   " . ($env['DB_SERVER']   ?? '(não definido)') . "\n";
    echo "DB_DATABASE: " . ($env['DB_DATABASE'] ?? '(não definido)') . "\n";
    echo "DB_USERNAME: " . ($env['DB_USERNAME'] ?? '(não definido)') . "\n";
    echo "DB_PASSWORD: " . str_repeat('*', strlen($env['DB_PASSWORD'] ?? '')) . "\n";
    echo "DB_ENCRYPT:  " . ($env['DB_ENCRYPT']  ?? '(não definido)') . "\n\n";
}

// 3. Tenta conectar
if (!extension_loaded('pdo_sqlsrv')) {
    echo "PARADO: extensão pdo_sqlsrv não está carregada. Não é possível testar a conexão.\n";
    echo "\nVerifique no php.ini se existe e está descomentada a linha:\n";
    echo "  extension=php_pdo_sqlsrv_XX_ts_x64.dll\n";
    echo "\nPHP carregado: " . phpversion() . "\n";
    echo "php.ini usado: " . php_ini_loaded_file() . "\n";
} else {
    echo "=== Teste de Conexão ===\n";
    $server   = $env['DB_SERVER']   ?? '';
    $database = $env['DB_DATABASE'] ?? '';
    $user     = $env['DB_USERNAME'] ?? '';
    $password = $env['DB_PASSWORD'] ?? '';

    $dsn = "sqlsrv:server=tcp:$server,1433;database=$database";

    try {
        $pdo = new PDO($dsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        echo "CONEXÃO OK ✓\n\n";

        // 4. Testa a tabela
        echo "=== Teste da Tabela ===\n";
        $stmt = $pdo->query("SELECT TOP 1 LOGIN, NOME FROM dbo.CONVERSOR_USUARIOS");
        $row  = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            echo "Tabela acessível ✓\n";
            echo "Primeiro registro: LOGIN=" . $row['LOGIN'] . " | NOME=" . $row['NOME'] . "\n";
        } else {
            echo "Tabela vazia ou sem registros.\n";
        }
    } catch (PDOException $e) {
        echo "ERRO DE CONEXÃO ✗\n";
        echo $e->getMessage() . "\n";
    }
}

echo "</pre>";
