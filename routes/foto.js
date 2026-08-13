/**
 * routes/foto.js  → GET /api/foto
 * Foto de perfil de quem está logado, buscada na IAM.
 *
 * A IAM não guarda foto: ela expõe `GET /api/foto/<nome>` (INTEGRACAO.md §5.3),
 * que resolve upload do usuário → Unico People. Aqui só fazemos o proxy.
 *
 * Por que proxy e não `<img src="{IAM}/api/foto/...">` direto:
 *   - o NOME vem da SESSÃO, nunca da query — sem isso a rota viraria um
 *     enumerador de fotos de colaborador por nome, aberto a qualquer um;
 *   - a imagem sai da nossa origem, então o CSP das páginas continua `img-src 'self'`.
 *
 * Foto é PII: `Cache-Control: private`, nunca `public`.
 */
'use strict';

const { IAM_URL } = require('../iam');

/** Só raster — SVG servido same-origin roda script (XSS armazenado). */
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Teto de tamanho; a foto real tem poucas centenas de KB. */
const MAX_BYTES = 8 * 1024 * 1024;

module.exports = async function fotoRoute(req, res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', 'inline; filename="foto"');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (!req.session || !req.session.cf_loggedIn) {
    return res.status(401).json({ success: false, message: 'Não autenticado.' });
  }

  const nome = String(req.session.cf_nome || '').trim();
  if (!nome) return res.status(404).end();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // A IAM responde 302 (Blob do Azure ou resolvedor do PCP) — o fetch segue.
    const up = await fetch(`${IAM_URL}/api/foto/${encodeURIComponent(nome)}`, {
      headers: { Accept: 'image/*' },
      signal: controller.signal,
    });
    if (!up.ok) return res.status(404).end(); // sem foto → o front mostra as iniciais

    const tipo = String(up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!MIME_OK.has(tipo)) return res.status(404).end();

    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length < 100 || buf.length > MAX_BYTES) return res.status(404).end();

    res.set('Content-Type', tipo);
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (e) {
    // IAM fora do ar ou timeout: sem foto é degradação aceitável, não erro de tela.
    return res.status(404).end();
  } finally {
    clearTimeout(timer);
  }
};
