/**
 * iam.js
 * Cliente da IAM Larsil (Painel ADM) + manifesto deste sistema.
 *
 * Regra de ouro (INTEGRACAO.md): este sistema NÃO tem tabela de login própria.
 * Toda identidade, permissão e escopo vem da Auth API da IAM, por HTTP.
 *
 * O JWT devolvido pela IAM fica guardado na SESSÃO do servidor — nunca no
 * browser. O front conversa só com este backend (cookie de sessão), e o
 * backend reconsulta a IAM (`/api/auth/resolve`) de tempos em tempos para
 * refletir mudança de permissão e conta desativada sem esperar o token expirar.
 */
'use strict';

require('./config'); // garante que o .env já foi carregado

/** Base da IAM. Nunca cravar URL no código — sempre por env. */
const IAM_URL = String(process.env.IAM_URL || 'http://localhost:4000').replace(/\/+$/, '');

/** Código deste sistema na IAM (namespace das permissões: `fatura.*`). */
const SISTEMA = 'FATURA';

/** Permissão mínima para entrar no sistema. */
const PERM_ACESSO = 'fatura.acesso';

/** Console da TI, para onde apontamos a gestão de usuários. */
const IAM_ADMIN_URL = `${IAM_URL}/admin`;

/**
 * Telas do sistema. Cada uma vira uma permissão `fatura.tela:<rota>` na IAM,
 * agrupada por `grupo` no console /admin — é assim que a TI libera tela a tela.
 *
 * `arquivo` é o HTML servido pelo Express; `rota` é o identificador na IAM.
 * Esta lista é a fonte da verdade do `npm run iam:sync` e do gate de páginas.
 */
const TELAS = [
  { arquivo: 'home.html',              rota: '/',                  descricao: 'Menu principal',      grupo: 'Início' },
  { arquivo: 'extrato.html',           rota: '/extrato',           descricao: 'Extrato bancário',    grupo: 'Conversões' },
  { arquivo: 'conversor.html',         rota: '/conversor',         descricao: 'Fatura',              grupo: 'Conversões' },
  { arquivo: 'nota-fiscal.html',       rota: '/nota-fiscal',       descricao: 'Nota fiscal',         grupo: 'Conversões' },
  { arquivo: 'conferencia-notas.html', rota: '/conferencia-notas', descricao: 'Conferência de notas', grupo: 'Conferência' },
  { arquivo: 'configuracoes.html',     rota: '/configuracoes',     descricao: 'Configurações',       grupo: 'Administração' },
];

/** Código da permissão de uma tela. */
const permTela = (rota) => `fatura.tela:${rota}`;

/** arquivo HTML → código da permissão (usado pelo gate do server.js). */
const PERM_POR_ARQUIVO = Object.fromEntries(TELAS.map((t) => [t.arquivo, permTela(t.rota)]));

/**
 * Manifesto enviado no auto-registro (`POST /api/registry/sync`).
 * Toda permissão precisa começar com `fatura.` — a IAM valida o namespace.
 *
 * `sistema` é obrigatório quando a TI entrega a CHAVE MESTRA (`REGISTRY_KEY`),
 * que não diz sozinha qual sistema está registrando. Com chave por sistema
 * (`REGISTRY_KEYS={"FATURA":"…"}`) a IAM ignora este campo e usa o da chave.
 */
function manifesto() {
  return {
    sistema: SISTEMA,
    nome: 'fatura-excel',
    url_base: process.env.APP_URL || null,
    modo: 'sync',
    permissoes: [
      { codigo: PERM_ACESSO, descricao: 'Entrar no sistema' },
      ...TELAS.map((t) => ({ codigo: permTela(t.rota), descricao: t.descricao, grupo: t.grupo })),
    ],
  };
}

/**
 * Chamada HTTP à IAM. Nunca lança por status — devolve { ok, status, data, erroRede }
 * para o chamador decidir a mensagem. `erroRede` indica IAM fora do ar/timeout.
 */
async function iamFetch(caminho, { method = 'GET', token = null, body = null, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${IAM_URL}${caminho}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const texto = await resp.text();
    let data = null;
    try { data = texto ? JSON.parse(texto) : null; } catch { data = { erro: texto }; }
    return { ok: resp.ok, status: resp.status, data, erroRede: null };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Tempo esgotado ao falar com a IAM.' : (e.message || String(e));
    return { ok: false, status: 0, data: null, erroRede: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/auth/login → { token, senha_provisoria, usuario }. */
const iamLogin = (login, senha) =>
  iamFetch('/api/auth/login', { method: 'POST', body: { login, senha } });

/** GET /api/auth/resolve → { usuario_id, papeis, permissoes, escopos, global }. */
const iamResolve = (token) => iamFetch('/api/auth/resolve', { token });

/** POST /api/auth/onboarding → { ok: true } (1º acesso: senha definitiva + contato). */
const iamOnboarding = (token, body) =>
  iamFetch('/api/auth/onboarding', { method: 'POST', token, body });

/** POST /api/auth/solicitar-acesso → registra na auditoria da IAM quem pediu o quê. */
const iamSolicitarAcesso = (token, tela) =>
  iamFetch('/api/auth/solicitar-acesso', { method: 'POST', token, body: { sistema: SISTEMA, tela } });

module.exports = {
  IAM_URL,
  IAM_ADMIN_URL,
  SISTEMA,
  PERM_ACESSO,
  TELAS,
  PERM_POR_ARQUIVO,
  permTela,
  manifesto,
  iamFetch,
  iamLogin,
  iamResolve,
  iamOnboarding,
  iamSolicitarAcesso,
};
