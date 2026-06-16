# Aplicação Node/Express (server.js). Substitui o antigo stack PHP/Apache:
# o backend foi migrado para Node e os arquivos api/*.php não existem mais.
FROM node:20-slim

WORKDIR /app

# Instala apenas dependências de produção. mssql usa o driver Tedious (JS puro),
# então não é necessário ODBC/msodbcsql. Aproveita o cache de camadas copiando
# primeiro os manifests.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Código da aplicação (dist/style.css e dist/theme.js já vêm versionados).
COPY . .

# O servidor OCR Python (PaddleOCR) não está nesta imagem. Sem isto, o
# server.js tentaria spawnar `python` e o erro de spawn derrubaria o boot.
# OCR fica indisponível (rota /api/ocr responde 503); o restante funciona.
ENV OCR_DISABLED=1
ENV NODE_ENV=production

# Railway injeta a porta via $PORT; server.js já usa process.env.PORT (fallback 3000).
EXPOSE 3000

CMD ["node", "server.js"]
