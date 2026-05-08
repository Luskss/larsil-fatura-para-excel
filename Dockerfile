FROM php:8.3-apache

# ── Dependências do sistema ──────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gnupg2 \
        apt-transport-https \
        ca-certificates \
        unixodbc-dev \
        libgss3 \
        wget \
    && rm -rf /var/lib/apt/lists/*

# ── Microsoft ODBC Driver 18 para SQL Server ─────────────────────────────────
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
        > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

# ── Extensões PHP para SQL Server ────────────────────────────────────────────
RUN pecl install sqlsrv pdo_sqlsrv \
    && docker-php-ext-enable sqlsrv pdo_sqlsrv

# ── Módulos Apache (força prefork; mod_php não é thread-safe) ────────────────
# Remove qualquer .load/.conf de MPM para evitar "More than one MPM loaded"
RUN rm -f /etc/apache2/mods-enabled/mpm_event.* \
            /etc/apache2/mods-enabled/mpm_worker.* \
            /etc/apache2/mods-enabled/mpm_prefork.* \
    && a2enmod mpm_prefork \
    && a2enmod rewrite headers expires deflate \
    && echo "==== MPM modules em mods-enabled ====" \
    && ls -la /etc/apache2/mods-enabled/ | grep -i mpm || true \
    && echo "==== LoadModule mpm em /etc/apache2 ====" \
    && grep -RIn "LoadModule mpm" /etc/apache2/ || true \
    && echo "==== Validacao de configuracao Apache ====" \
    && apache2ctl -t -D DUMP_MODULES 2>&1 | grep -i mpm || true

# ── Permite .htaccess em toda a raiz ─────────────────────────────────────────
RUN sed -i 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf

# ── Código da aplicação ───────────────────────────────────────────────────────
WORKDIR /var/www/html
COPY . .

# Remove arquivos sensíveis que não devem estar na imagem
RUN rm -f .env

EXPOSE 80

# Ajusta a porta e re-limpa MPMs no runtime (defensivo contra volume mounts/cache).
CMD ["sh", "-c", "\
    echo '==== mods-enabled antes do cleanup runtime ====' && ls /etc/apache2/mods-enabled/ | grep -i mpm || true; \
    rm -f /etc/apache2/mods-enabled/mpm_event.* /etc/apache2/mods-enabled/mpm_worker.*; \
    if [ ! -e /etc/apache2/mods-enabled/mpm_prefork.load ]; then a2enmod mpm_prefork; fi; \
    echo '==== mods-enabled depois do cleanup runtime ====' && ls /etc/apache2/mods-enabled/ | grep -i mpm || true; \
    sed -i \"s/Listen 80/Listen ${PORT:-80}/\" /etc/apache2/ports.conf; \
    echo '==== apache2ctl -t ====' && apache2ctl -t 2>&1 || true; \
    exec apache2-foreground \
"]
