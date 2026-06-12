/**
 * server.js
 * Servidor Node/Express que substitui os endpoints PHP do conversor.
 * Responde nas MESMAS URLs (/api/*.php) para não exigir mudanças no frontend.
 *
 *   npm start     → produção
 *   npm run serve → dev com nodemon
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');

require('./config'); // carrega .env (loadEnv) ao iniciar
const { initScheduler } = require('./scheduler');

const app = express();
app.set('trust proxy', 1); // necessário se atrás de proxy (Railway etc.)

// Corpo JSON grande (texto de PDF / imagens base64 do fallback Vision)
app.use(express.json({ limit: '50mb' }));

// ── SESSÃO (substitui o $_SESSION do PHP) ────────────────────────────────
app.use(session({
  name: 'connect.sid',
  secret: process.env.SESSION_SECRET || 'conversor-fatura-larsil-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // ative (true) somente atrás de HTTPS
  },
}));

// ── ROTAS DA API (mesmas URLs dos arquivos .php) ─────────────────────────
const authRoute = require('./routes/auth');
const logoutRoute = require('./routes/logout');
const usuariosRoute = require('./routes/usuarios');
const aiParseRoute = require('./routes/ai-dispatch-parse');
const aiExtratoRoute = require('./routes/ai-dispatch-extrato');
const aiNotaFiscalRoute = require('./routes/ai-dispatch-nota-fiscal');
const aiNotaFiscalResumoRoute = require('./routes/ai-dispatch-nota-fiscal-resumo');
const horariosRoute = require('./routes/horarios');
const monitorConfigRoute = require('./routes/monitor-config');
const planilhaCentralRoute = require('./routes/planilha-central');
const compararNotasRoute = require('./routes/comparar-notas');
const scanStatusRoute = require('./routes/scan-status');
const classifyUnidentifiedRoute = require('./routes/classify-unidentified');
const classifyFallbackRoute = require('./routes/classify-fallback');
const pdfFileRoute = require('./routes/pdf-file');
const pdfViewerRoute = require('./routes/pdf-viewer');
const ocrRoute      = require('./routes/ocr');
const configRoute   = require('./routes/config');
const relatorioRoute = require('./routes/relatorio');
const claudeParseRoute = require('./routes/claude-parse');
const forceScanRoute = require('./routes/force-scan');
const forceScanAiRoute = require('./routes/force-scan-ai');
const empresasContasRoute = require('./routes/empresas-contas');
const scanEmpresasRoute = require('./routes/scan-empresas');

// Captura rejeições de rotas async para não travar a requisição no Express 4.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.all('/api/auth.php', wrap(authRoute));
app.all('/api/logout.php', wrap(logoutRoute));
app.all('/api/usuarios.php', wrap(usuariosRoute)); // GET/POST/DELETE/PATCH
app.all('/api/openai-parse.php', wrap(aiParseRoute));
app.all('/api/openai-extrato.php', wrap(aiExtratoRoute));
app.all('/api/openai-nota-fiscal.php', wrap(aiNotaFiscalRoute));
app.all('/api/openai-nota-fiscal-resumo.php', wrap(aiNotaFiscalResumoRoute));
app.all('/api/horarios.php', wrap(horariosRoute));
app.all('/api/monitor-config', wrap(monitorConfigRoute));
app.all('/api/planilha-central', wrap(planilhaCentralRoute));
app.all('/api/comparar-notas', wrap(compararNotasRoute));
app.all('/api/scan-status', wrap(scanStatusRoute));
app.all('/api/classify-unidentified', wrap(classifyUnidentifiedRoute));
app.all('/api/classify-fallback', wrap(classifyFallbackRoute));
app.all('/api/pdf-file', wrap(pdfFileRoute));
app.all('/api/pdf-viewer', wrap(pdfViewerRoute));
console.log('[server] rota /api/classify-unidentified registrada');
app.post('/api/ocr', wrap(ocrRoute));
app.all('/api/config', wrap(configRoute));
app.all('/api/relatorio', wrap(relatorioRoute));
app.post('/api/claude-parse', wrap(claudeParseRoute));
app.post('/api/force-scan', wrap(forceScanRoute));
app.post('/api/force-scan-ai', wrap(forceScanAiRoute));
app.all('/api/empresas-contas', wrap(empresasContasRoute));
app.post('/api/scan-empresas', wrap(scanEmpresasRoute));

// ── ESTÁTICOS (apenas o que é público; não expõe .env, código ou node_modules) ─
const PUBLIC_PAGES = new Set([
  'index.html',
  'home.html',
  'extrato.html',
  'conversor.html',
  'nota-fiscal.html',
  'gestao-usuarios.html',
  'configuracoes.html',
  'conferencia-notas.html',
]);

app.use('/img',  express.static(path.join(__dirname, 'img')));
app.use('/dist', express.static(path.join(__dirname, 'dist')));
app.get('/theme.js', (req, res) => res.sendFile(path.join(__dirname, 'theme.js')));
app.get('/transitions.js', (req, res) => res.sendFile(path.join(__dirname, 'transitions.js')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/:page', (req, res, next) => {
  const page = req.params.page;
  if (PUBLIC_PAGES.has(page)) {
    return res.sendFile(path.join(__dirname, page));
  }
  next();
});

// 404 genérico
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Não encontrado.' });
});

// Middleware de erro final (rotas async que rejeitaram)
app.use((err, req, res, next) => {
  console.error('[conversor-fatura] erro não tratado:', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: 'Erro interno no servidor.' });
});

// ── SERVIDOR OCR PYTHON ───────────────────────────────────────────────────
// Inicia ocr_server.py em background. O modelo PaddleOCR carrega em ~5–10 s;
// requisições /api/ocr recebem 503 até ele estar pronto (tratado no front).
function startOCRServer() {
  const py = spawn('python', [path.join(__dirname, 'ocr_server.py')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  py.stdout.on('data', d => process.stdout.write('[ocr] ' + d));
  py.stderr.on('data', d => process.stderr.write('[ocr] ' + d));
  py.on('exit', code => {
    if (code !== 0 && code !== null)
      console.warn(`[ocr] processo Python encerrou (código ${code}) — OCR indisponível.`);
  });
  // Garante que o processo Python morre junto com o Node
  const kill = () => { try { py.kill(); } catch (_) {} };
  process.once('exit', kill);
  process.once('SIGINT', () => { kill(); process.exit(); });
  process.once('SIGTERM', () => { kill(); process.exit(); });
  return py;
}

if (process.env.OCR_DISABLED !== '1') startOCRServer();

// ── INICIALIZAÇÃO ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`[conversor-fatura] servidor Node rodando em http://localhost:${PORT}`);
  // Inicializa o scheduler de monitoramento automático
  await initScheduler();
});

// Endpoints OpenAI podem demorar (até ~280s) — afrouxa timeouts do HTTP server.
server.requestTimeout = 600000;   // 10 min
server.headersTimeout = 620000;
server.keepAliveTimeout = 65000;
