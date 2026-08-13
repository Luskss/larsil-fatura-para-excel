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
const { PERM_POR_ARQUIVO, permTela, IAM_ADMIN_URL } = require('./iam');
const { iamRefresh, revalidarPagina, requirePermissao, tem } = require('./routes/_iam-session');

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

// ── IAM: mantém o acesso da sessão fresco em toda chamada de API ─────────
// Reconsulta a IAM a cada 5 min: permissão revogada ou conta desativada pela TI
// derruba a sessão aqui, sem esperar o JWT expirar.
app.use('/api', (req, res, next) => Promise.resolve(iamRefresh(req, res, next)).catch(next));

// ── ROTAS DA API (mesmas URLs dos arquivos .php) ─────────────────────────
const authRoute = require('./routes/auth');
const meRoute = require('./routes/me');
const fotoRoute = require('./routes/foto');
const onboardingRoute = require('./routes/onboarding');
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
const alertasFalsosRoute = require('./routes/alertas-falsos');
const vinculosNotasRoute = require('./routes/vinculos-notas');

// Captura rejeições de rotas async para não travar a requisição no Express 4.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Atalhos para as permissões de tela (cada endpoint pertence a uma tela só).
const soExtrato     = requirePermissao(permTela('/extrato'));
const soConversor   = requirePermissao(permTela('/conversor'));
const soNotaFiscal  = requirePermissao(permTela('/nota-fiscal'));
const soConferencia = requirePermissao(permTela('/conferencia-notas'));
const soConfig      = requirePermissao(permTela('/configuracoes'));

// Públicas / de sessão
app.all('/api/auth.php', wrap(authRoute));
app.all('/api/logout.php', wrap(logoutRoute));
app.get('/api/me', wrap(meRoute));
app.get('/api/foto', wrap(fotoRoute)); // foto do próprio usuário (nome vem da sessão)
app.all('/api/onboarding', wrap(onboardingRoute));
app.all('/api/usuarios.php', wrap(usuariosRoute)); // 410 → gestão é na IAM

// Conversões (uma permissão por tela)
app.all('/api/openai-parse.php', soConversor, wrap(aiParseRoute));
app.all('/api/openai-extrato.php', soExtrato, wrap(aiExtratoRoute));
app.all('/api/openai-nota-fiscal.php', soNotaFiscal, wrap(aiNotaFiscalRoute));
app.all('/api/openai-nota-fiscal-resumo.php', soNotaFiscal, wrap(aiNotaFiscalResumoRoute));

// Conferência de notas
app.all('/api/comparar-notas', soConferencia, wrap(compararNotasRoute));
app.all('/api/alertas-falsos', soConferencia, wrap(alertasFalsosRoute));
app.all('/api/vinculos-notas', soConferencia, wrap(vinculosNotasRoute));
app.all('/api/classify-unidentified', soConferencia, wrap(classifyUnidentifiedRoute));
app.all('/api/classify-fallback', soConferencia, wrap(classifyFallbackRoute));
app.all('/api/pdf-file', soConferencia, wrap(pdfFileRoute));
app.all('/api/pdf-viewer', soConferencia, wrap(pdfViewerRoute));
app.all('/api/relatorio', soConferencia, wrap(relatorioRoute));
app.post('/api/ocr', soConferencia, wrap(ocrRoute));

// Configurações / administração do monitoramento
app.all('/api/horarios.php', soConfig, wrap(horariosRoute));
app.all('/api/monitor-config', soConfig, wrap(monitorConfigRoute));
app.all('/api/planilha-central', soConfig, wrap(planilhaCentralRoute));
app.all('/api/scan-status', soConfig, wrap(scanStatusRoute));
app.all('/api/config', soConfig, wrap(configRoute));
app.all('/api/empresas-contas', soConfig, wrap(empresasContasRoute));
app.post('/api/force-scan', soConfig, wrap(forceScanRoute));
app.post('/api/force-scan-ai', soConfig, wrap(forceScanAiRoute));
app.post('/api/scan-empresas', soConfig, wrap(scanEmpresasRoute));

// Sem tela dona: basta estar autenticado (a própria rota chama requireAuth).
app.post('/api/claude-parse', wrap(claudeParseRoute));

// ── ESTÁTICOS (apenas o que é público; não expõe .env, código ou node_modules) ─
// Só a tela de login é pública. Todas as outras exigem sessão IAM + a permissão
// `fatura.tela:<rota>` daquela página — o gate real é aqui, no servidor; o guard
// do front só melhora a experiência (esconder link, mensagem clara).
const PAGINA_PUBLICA = 'index.html';

app.use('/img',  express.static(path.join(__dirname, 'img')));
app.use('/dist', express.static(path.join(__dirname, 'dist')));
app.get('/theme.js', (req, res) => res.sendFile(path.join(__dirname, 'theme.js')));
app.get('/transitions.js', (req, res) => res.sendFile(path.join(__dirname, 'transitions.js')));
app.get('/session-guard.js', (req, res) => res.sendFile(path.join(__dirname, 'session-guard.js')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, PAGINA_PUBLICA)));

// Gestão de usuários agora é no console da TI (IAM) — nunca mais neste sistema.
app.get('/gestao-usuarios.html', (req, res) => res.redirect(302, IAM_ADMIN_URL));

app.get('/:page', wrap(async (req, res, next) => {
  const page = req.params.page;

  if (page === PAGINA_PUBLICA) return res.sendFile(path.join(__dirname, page));

  const permissao = PERM_POR_ARQUIVO[page];
  if (!permissao) return next(); // não é página do sistema → 404

  if (!req.session || !req.session.cf_loggedIn) {
    return res.redirect(302, '/index.html');
  }
  // Revalida na IAM antes de entregar a página (permissão revogada / conta
  // desativada barram já aqui, não só na próxima chamada de API).
  if (!(await revalidarPagina(req, res))) return;
  if (req.session.cf_onboarding_pendente) {
    return res.redirect(302, '/index.html?primeiro_acesso=1');
  }
  if (!tem(req, permissao)) {
    // Sem permissão para ESTA tela: volta ao menu com o aviso, em vez de 403 cru.
    // Se nem o menu ela pode ver, cai no login (evita redirect em loop).
    const destino = tem(req, permTela('/')) ? '/home.html' : '/index.html';
    return res.redirect(302, destino + '?sem_permissao=' + encodeURIComponent(page));
  }
  return res.sendFile(path.join(__dirname, page));
}));

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
