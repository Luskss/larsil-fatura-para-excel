<?php
/**
 * Configurações de conexão — lidas do arquivo .env na raiz do projeto.
 */

function loadEnv(string $path): void
{
    if (!file_exists($path)) return;
    // Remove BOM UTF-8/UTF-16 se existir e faz parse como ini
    $content = file_get_contents($path);
    // Remove BOM UTF-8
    $content = ltrim($content, "\xEF\xBB\xBF");
    // Converte UTF-16 LE para UTF-8 se necessário
    if (substr($content, 0, 2) === "\xFF\xFE" || substr($content, 0, 2) === "\xFE\xFF") {
        $content = mb_convert_encoding($content, 'UTF-8', 'UTF-16');
        $content = ltrim($content, "\xEF\xBB\xBF");
    }
    foreach (explode("\n", str_replace("\r\n", "\n", $content)) as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        if (!str_contains($line, '=')) continue;
        [$k, $v] = array_map('trim', explode('=', $line, 2));
        if (!isset($_ENV[$k])) $_ENV[$k] = $v;
    }
}

loadEnv(__DIR__ . '/.ENV');
loadEnv(__DIR__ . '/.env');

/**
 * Em ambientes como Railway, Heroku, Docker etc. as variáveis vêm do
 * sistema. PHP só preenche $_ENV se variables_order incluir "E", o que
 * nem sempre é o caso — então fazemos fallback explícito para getenv()
 * e $_SERVER para todas as chaves esperadas pela aplicação.
 */
foreach ([
    'DB_SERVER', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD',
    'DB_ENCRYPT', 'DB_TRUST_SERVER_CERTIFICATE',
    'OPENAI_API_KEY',
] as $__envKey) {
    if (!empty($_ENV[$__envKey])) continue;
    $val = getenv($__envKey);
    if ($val === false || $val === '') {
        $val = $_SERVER[$__envKey] ?? '';
    }
    if ($val !== '' && $val !== false) $_ENV[$__envKey] = $val;
}
unset($__envKey, $val);

define('DB_SERVER',   $_ENV['DB_SERVER']   ?? '');
define('DB_NAME',     $_ENV['DB_DATABASE'] ?? '');
define('DB_USER',     $_ENV['DB_USERNAME'] ?? '');
define('DB_PASSWORD', $_ENV['DB_PASSWORD'] ?? '');
define('DB_ENCRYPT',  $_ENV['DB_ENCRYPT']  ?? 'yes');
define('DB_TRUST_CERT', $_ENV['DB_TRUST_SERVER_CERTIFICATE'] ?? 'no');

/**
 * Retorna uma conexão PDO com o SQL Server (Azure SQL).
 */
function getConnection(): PDO
{
    $encrypt   = strtolower(DB_ENCRYPT)    === 'yes' ? 'true' : 'false';
    $trustCert = strtolower(DB_TRUST_CERT) === 'yes' ? 'true' : 'false';

    $dsn = 'sqlsrv:server=tcp:' . DB_SERVER . ',1433;database=' . DB_NAME;

    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    return new PDO($dsn, DB_USER, DB_PASSWORD, $options);
}
