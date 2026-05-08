# 🔒 Proteções de Segurança — Conversor de Fatura

## Visão Geral
Este documento descreve as proteções implementadas contra os principais ataques web.

---

## 1. SQL Injection
**Status:** ✅ Protegido

### Implementação:
- **Prepared Statements**: Todos os arquivos de API usam `PDO->prepare()` com placeholders `?`
- Exemplo (auth.php):
  ```php
  $stmt = $pdo->prepare(
      'SELECT LOGIN, SENHA, NOME
       FROM dbo.CONVERSOR_USUARIOS
       WHERE LOGIN = ?'
  );
  $stmt->execute([$username]); // Username não é concatenado, é parameterizado
  ```

### Arquivo relevante:
- [api/auth.php](api/auth.php) - Prepared statements no SELECT
- [api/usuarios.php](api/usuarios.php) - Prepared statements em todos os CRUD
- [config.php](config.php) - Configuração PDO segura

---

## 2. Cross-Site Scripting (XSS)
**Status:** ✅ Protegido

### Implementação:
1. **Content Security Policy (CSP)** em [index.html](index.html):
   ```html
   <meta http-equiv="Content-Security-Policy" 
         content="default-src 'self'; script-src 'self' https://fonts.googleapis.com; ..." />
   ```

2. **Headers HTTP de segurança** nos arquivos API:
   ```php
   header('X-Content-Type-Options: nosniff');    // Previne MIME sniffing
   header('X-XSS-Protection: 1; mode=block');     // XSS proteção no navegador
   ```

3. **Sanitização de output** (função em [security.php](security.php)):
   ```php
   function sanitizeForJSON(string $input): string {
       return htmlspecialchars($input, ENT_QUOTES | ENT_HTML5, 'UTF-8');
   }
   ```

### Arquivos relevantes:
- [api/auth.php](api/auth.php) - Headers XSS
- [api/usuarios.php](api/usuarios.php) - Headers XSS  
- [api/logout.php](api/logout.php) - Headers XSS
- [security.php](security.php) - Funções de sanitização

---

## 3. Brute Force Attack
**Status:** ✅ Protegido

### Implementação:
- **Rate Limiting** em [api/auth.php](api/auth.php):
  - Máximo 5 tentativas de login a cada 15 minutos (900 segundos)
  - Rastreamento em `$_SESSION['login_attempts']`
  - Resposta HTTP 429 (Too Many Requests) quando limite excedido

```php
$loginAttempts = $_SESSION['login_attempts'] ?? 0;
$lastAttempt = $_SESSION['last_login_attempt'] ?? 0;
if ($loginAttempts > 5 && (time() - $lastAttempt < 900)) {
    http_response_code(429);
    echo json_encode(['success' => false, 'message' => 'Muitas tentativas...']);
    exit;
}
```

### Função reutilizável:
- [security.php](security.php) - `checkRateLimit()` para aplicar em outros endpoints

---

## 4. CSRF (Cross-Site Request Forgery)
**Status:** ✅ Parcialmente Protegido

### Implementação:
- **SameSite Cookie**: Configurado via PHP session
- **Verificação de Origin**: Função `validateRequestOrigin()` em [security.php](security.php)
- **POST-only endpoints**: Todos os endpoints de mutação exigem POST/DELETE/PATCH

### Próximos passos (produção):
- Implementar CSRF tokens explícitos
- Validar `Origin` header em todos os POST

---

## 5. Validação de Entrada
**Status:** ✅ Protegido

### Implementação em [api/usuarios.php](api/usuarios.php):

**Comprimento máximo:**
```php
if (strlen($login) > 100 || strlen($nome) > 200 || strlen($senha) > 256) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Dados inválidos']);
    exit;
}
```

**Formato de login (alfanumérico, underscore, hífen):**
```php
if (!preg_match('/^[a-zA-Z0-9_-]+$/', $login)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Login contém caracteres inválidos']);
    exit;
}
```

### Funções reutilizáveis em [security.php](security.php):
- `isValidLogin()` - Valida formato de login
- `isValidName()` - Valida nome com suporte a acentos
- `isStrongPassword()` - Valida força da senha (8+ chars, maiúscula, minúscula, número)

---

## 6. Resposta de Erro Segura
**Status:** ✅ Protegido

### Implementação:
- **Mensagens genéricas** para login (não revela se usuário/senha está errado)
  ```php
  echo json_encode(['success' => false, 'message' => 'Usuário ou senha incorretos.']);
  ```

- **Logs seguros** para auditoria (função em [security.php](security.php)):
  ```php
  function logSecurityEvent(string $event, string $details = '', string $level = 'INFO'): void {
      // Registra em security.log com timestamp, IP, usuário
  }
  ```

---

## 7. Gestão Segura de Sessão
**Status:** ✅ Protegido

### Implementação em [api/logout.php](api/logout.php):
```php
// Regenera ID de sessão após login bem-sucedido (auth.php)
session_regenerate_id(true);

// Destruição completa na saída (logout.php)
$_SESSION = [];
setcookie(session_name(), '', time() - 42000, ...); // Expira cookie
session_destroy();
```

### Proteção de Cookie:
```php
// Implícito via php.ini recomendado:
session.cookie_httponly = On      // Não acessível via JavaScript
session.cookie_secure = On         // Apenas HTTPS (em produção)
session.cookie_samesite = Strict   // Proteção CSRF
```

---

## 8. Headers de Segurança HTTP
**Status:** ✅ Protegido

### Implementados em todos os endpoints:
```php
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');           // Previne MIME sniffing
header('X-Frame-Options: DENY');                     // Previne clickjacking
header('X-XSS-Protection: 1; mode=block');          // XSS proteção navegador
header('Strict-Transport-Security: max-age=31536000; includeSubDomains'); // HTTPS
header('Content-Security-Policy: default-src \'self\'; ...');  // CSP
header('Referrer-Policy: strict-origin-when-cross-origin');    // Privacidade
header('Permissions-Policy: camera=(), microphone=(), geolocation=()'); // Permissões
```

---

## Checklist de Segurança para Produção

- [ ] **HTTPS obrigatório** - Usar certificado SSL/TLS válido
- [ ] **Senhas hasheadas** - Trocar comparação em texto plano por `password_hash()` / `password_verify()`
- [ ] **Variáveis de ambiente** - Usar `.ENV` não versionado (já configurado com .gitignore)
- [ ] **Logs de segurança** - Ativar `security.log` com permissões restritas
- [ ] **Rate limiting avançado** - Usar Redis ou similar em vez de `$_SESSION`
- [ ] **WAF** - Implementar Web Application Firewall (AWS WAF, Cloudflare, etc)
- [ ] **Backup regular** - Banco de dados + logs de auditoria
- [ ] **Monitoramento** - Alertas para tentativas de ataque
- [ ] **Testes de penetração** - Validação por terceiros antes de deploy

---

## Arquivos de Referência

| Arquivo | Propósito |
|---------|-----------|
| [security.php](security.php) | Biblioteca centralizada de funções de segurança |
| [api/auth.php](api/auth.php) | Autenticação com prepared statements + rate limiting |
| [api/usuarios.php](api/usuarios.php) | CRUD com validação rigorosa |
| [api/logout.php](api/logout.php) | Destruição segura de sessão |
| [config.php](config.php) | Configuração PDO segura |
| [.env-example](.env-example) | Template de variáveis de ambiente |
| [.gitignore](.gitignore) | Exclui credenciais do Git |

---

## Contato
Para dúvidas sobre segurança, consulte a documentação do projeto.
