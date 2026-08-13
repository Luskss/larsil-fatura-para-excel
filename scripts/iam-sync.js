#!/usr/bin/env node
/**
 * scripts/iam-sync.js
 * Auto-registro deste sistema na IAM Larsil (POST /api/registry/sync).
 *
 * Declara o sistema FATURA e suas telas/permissões: elas aparecem sozinhas no
 * console /admin da TI, prontas para liberar por pessoa — sem ninguém rodar SQL.
 *
 *   npm run iam:sync          → envia o manifesto (modo "sync")
 *   npm run iam:sync -- --ver → só mostra o que já está registrado
 *
 * Precisa de duas envs:
 *   IAM_URL              base da IAM (ex.: https://painelgestor.up.railway.app)
 *   IAM_REGISTRY_KEY     a chave que a TI gerou para o sistema FATURA
 *                        (no .env da IAM: REGISTRY_KEYS={"FATURA":"<chave>"})
 *
 * Rode a cada deploy em que as telas mudarem — é idempotente.
 */
'use strict';

require('../config'); // carrega o .env
const { IAM_URL, SISTEMA, manifesto, iamFetch } = require('../iam');

const CHAVE = process.env.IAM_REGISTRY_KEY || '';
const soVer = process.argv.includes('--ver');

/**
 * Marca a saída como erro sem matar o processo na hora: `process.exit()` com o
 * socket do fetch ainda fechando estoura o assert do libuv no Windows
 * ("!(handle->flags & UV_HANDLE_CLOSING)"). Assim o Node encerra sozinho, limpo.
 */
const falhar = () => { process.exitCode = 1; };

async function main() {
  if (!CHAVE) {
    console.error('✗ Falta IAM_REGISTRY_KEY no .env. Peça a chave do sistema ' + SISTEMA + ' à TI');
    console.error('  (no .env da IAM ela cadastra REGISTRY_KEYS={"' + SISTEMA + '":"<chave>"}).');
    falhar();
    return;
  }

  console.log(`IAM: ${IAM_URL}  |  sistema: ${SISTEMA}`);

  if (soVer) {
    const r = await iamFetch('/api/registry/me', { headers: { 'X-Registry-Key': CHAVE } });
    if (r.erroRede) { console.error('✗ IAM inacessível:', r.erroRede); return falhar(); }
    if (!r.ok) { console.error(`✗ ${r.status}:`, (r.data && r.data.erro) || r.data); return falhar(); }
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  const corpo = manifesto();
  console.log(`Enviando ${corpo.permissoes.length} permissões (modo ${corpo.modo})…`);

  const r = await iamFetch('/api/registry/sync', {
    method: 'POST',
    body: corpo,
    headers: { 'X-Registry-Key': CHAVE },
    timeoutMs: 30000,
  });

  if (r.erroRede) { console.error('✗ IAM inacessível:', r.erroRede); return falhar(); }
  if (!r.ok) {
    console.error(`✗ ${r.status}:`, (r.data && (r.data.erro || r.data.detalhe)) || r.data);
    return falhar();
  }

  const d = r.data || {};
  console.log(`✓ ${d.sistema}: ${d.criadas} criadas, ${d.atualizadas} atualizadas, ` +
              `${d.removidas} removidas — ${d.permissoes_totais} permissões no total.`);
  console.log(`Agora a TI libera tela a tela em ${IAM_URL}/admin → Usuários & Acessos.`);
}

main().catch((e) => { console.error('✗ Falha inesperada:', e.message); falhar(); });
