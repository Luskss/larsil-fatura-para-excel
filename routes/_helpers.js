/**
 * routes/_helpers.js
 * Utilitários compartilhados pelas rotas, replicando comportamentos do PHP
 * (is_numeric, trim/cast, headers de segurança, chamada à OpenAI via curl).
 */
'use strict';

/** Equivalente a is_numeric() do PHP para valores vindos de JSON. */
function isNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return false;
    return !Number.isNaN(Number(s));
  }
  return false;
}

/** Equivalente a (float)$v — retorna número (0 quando não numérico). */
function toFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Equivalente a trim((string)$v). */
function trimStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Headers de segurança usados pelos endpoints OpenAI. */
function setApiSecurityHeaders(res) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/** Headers de segurança completos (auth / usuarios). */
function setFullSecurityHeaders(res) {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com");
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

/**
 * Chama a API de chat completions da OpenAI.
 * Espelha a chamada cURL dos arquivos PHP (timeout 280s).
 * Retorna { ok, httpCode, body (texto cru), error }.
 */
async function callOpenAI(apiKey, payload) {
  const payloadJson = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 280000);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: payloadJson,
      signal: controller.signal,
    });
    const text = await resp.text();
    return { ok: true, httpCode: resp.status, body: text, error: '' };
  } catch (e) {
    return { ok: false, httpCode: 0, body: '', error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chama a API de Messages da Anthropic (Claude).
 * payload deve ser no formato Anthropic: { model, max_tokens, system, messages }.
 * Retorna { ok, httpCode, body (texto cru), error }.
 */
async function callAnthropic(apiKey, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 280000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await resp.text();
    return { ok: true, httpCode: resp.status, body: text, error: '' };
  } catch (e) {
    return { ok: false, httpCode: 0, body: '', error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lê o provider de IA ativo do settings.json.
 * Retorna 'anthropic' ou 'openai'.
 */
function getActiveAiProvider() {
  try {
    const fs   = require('fs');
    const path = require('path');
    const cfg  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings.json'), 'utf8'));
    return cfg.aiProvider === 'openai' ? 'openai' : 'anthropic';
  } catch {
    return 'anthropic';
  }
}

/** Exige sessão autenticada; envia 401 e retorna false se não houver. */
function requireAuth(req, res) {
  if (!req.session || !req.session.cf_loggedIn) {
    res.status(401).json({ success: false, message: 'Não autenticado.' });
    return false;
  }
  return true;
}

module.exports = {
  isNumeric,
  toFloat,
  trimStr,
  setApiSecurityHeaders,
  setFullSecurityHeaders,
  callOpenAI,
  callAnthropic,
  getActiveAiProvider,
  requireAuth,
};
