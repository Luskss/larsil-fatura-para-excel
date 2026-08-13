# Integração com a IAM Larsil

Este sistema (código **`FATURA`** na IAM) não tem mais login próprio. Identidade,
senha, papéis, permissões e escopo vêm da **Auth API da IAM** (`iam_larsil`),
como manda o `INTEGRACAO.md` dela. A tabela `nfs.CONV_USUARIOS` foi aposentada.

## Como ligar

1. Configure o `.env` (veja `.env-example`):

   ```
   IAM_URL=https://painelgestor.up.railway.app   # local: http://localhost:4000
   IAM_REGISTRY_KEY=<chave que a TI gerou para FATURA>
   APP_URL=https://<url-publica-deste-sistema>
   SESSION_SECRET=<segredo longo e aleatório>
   ```

   A TI cadastra a chave no `.env` da IAM: `REGISTRY_KEYS={"FATURA":"<chave>"}`.
   Se ela entregar a **chave mestra** (`REGISTRY_KEY`, que serve para qualquer
   sistema), a IAM exige o código no corpo — por isso o manifesto manda
   `sistema: "FATURA"`. O nome de exibição no console é `fatura-excel`.

2. Registre o sistema e as telas na IAM (idempotente, rode a cada deploy que
   mudar telas):

   ```bash
   npm run iam:sync          # envia o manifesto
   npm run iam:sync -- --ver # só confere o que já está lá
   ```

3. No console `<IAM_URL>/admin` → **Usuários & Acessos**, a TI libera
   `fatura.acesso` e as telas por pessoa. Sem SQL.

## Permissões

O manifesto vive em [iam.js](iam.js) (`TELAS`) — é a fonte da verdade do
`iam:sync`, do gate de páginas e do menu do front. Mudou tela? Edite a lista e
rode o sync.

| Permissão | Libera |
|---|---|
| `fatura.acesso` | Entrar no sistema (sem ela, o login é recusado) |
| `fatura.tela:/` | `home.html` — menu principal |
| `fatura.tela:/extrato` | `extrato.html` + `/api/openai-extrato.php` |
| `fatura.tela:/conversor` | `conversor.html` + `/api/openai-parse.php` |
| `fatura.tela:/nota-fiscal` | `nota-fiscal.html` + `/api/openai-nota-fiscal*.php` |
| `fatura.tela:/conferencia-notas` | `conferencia-notas.html` + comparar/vínculos/alertas/classify/relatório/pdf/ocr |
| `fatura.tela:/configuracoes` | `configuracoes.html` + config/monitor/horários/planilha/scan/empresas |

## Como funciona por dentro

```
browser ──cookie de sessão──> este backend ──Bearer JWT──> IAM
```

- **Login** (`POST /api/auth.php`): proxy de `POST /api/auth/login` da IAM. O JWT
  fica na **sessão do servidor** — nunca chega ao browser. Trata os três casos do
  contrato: `401` credencial errada, `403 INATIVO` (conta desativada) e
  `senha_provisoria` (força o 1º acesso).
- **Revalidação** ([routes/_iam-session.js](routes/_iam-session.js)): a cada
  5 min (`IAM_RESOLVE_TTL_MS`) o backend chama `GET /api/auth/resolve`. Permissão
  revogada ou conta desativada no console derrubam a sessão sem esperar o token
  expirar — tanto em chamadas de API quanto ao abrir uma página.
- **Gate de páginas** ([server.js](server.js)): só `index.html` é pública. Cada
  outra página exige sessão + a permissão da sua tela. Sem permissão → volta ao
  menu com aviso.
- **Gate de API**: `requirePermissao(...)` no registro de cada rota. Endpoint sem
  tela dona exige apenas sessão válida.
- **Front** ([session-guard.js](session-guard.js)): conveniência, não segurança —
  esconde links sem permissão, mostra o aviso e derruba a tela se a sessão morrer
  no meio do uso. Expõe `window.CF` (`usuario`, `permissoes`, `telas`, `tem()`).
- **IAM fora do ar**: sessões já abertas seguem com o acesso em cache (a
  identidade já foi provada); logins novos falham com `503` e mensagem clara.

## Foto de perfil na tela de login

A IAM não guarda foto: ela resolve por nome (`GET /api/foto/<nome>` — upload do
usuário no PCP, com o Unico People de fallback). Aqui isso vira:

- **`GET /api/foto`** ([routes/foto.js](routes/foto.js)): proxy autenticado. O
  nome sai da **sessão**, nunca da query — uma rota pública por nome seria um
  enumerador de fotos de colaborador. Serve a imagem pela nossa origem
  (`Cache-Control: private`, `nosniff`, só raster), 404 quando não há foto.
- **Cache no browser** ([session-guard.js](session-guard.js)): depois do
  `/api/me`, se a pessoa marcou **Lembrar-me**, a foto é guardada em
  `localStorage.cf_foto` (data URL) junto de `cf_user`/`cf_nome`.
- **Login** ([index.html](index.html)): a tela é pública, então ela não consulta
  nada — mostra o que está em cache, no estilo tela de bloqueio do Windows.
  Sem foto → iniciais; usuário digitado diferente do lembrado → ícone neutro;
  "Trocar usuário" apaga `cf_user`/`cf_nome`/`cf_foto`.

A foto atualiza a cada login (o guard rebusca na IAM ao abrir a próxima página).
Casamento é por **nome**: se o `NOME` na IAM estiver diferente do cadastro do
PCP, cai no fallback ou não acha foto — ver `UNICO-PEOPLE-FOTOS.md` §7.

## Gestão de usuários

Não existe mais aqui. `GET /gestao-usuarios.html` redireciona para
`<IAM_URL>/admin` e `/api/usuarios.php` responde `410`. O arquivo
`gestao-usuarios.html` ficou no repositório, mas não é servido — pode ser
apagado com segurança.

## Escopo (quando for filtrar dados)

Ainda não é usado por nenhuma consulta deste sistema. Quando for: leia os
escopos **do token** via `escopos(req)` de `routes/_iam-session.js` — nunca da
query ou do corpo — e aplique o helper único da seção 3 do `INTEGRACAO.md` em
todas as consultas, sem reinventar por tela.

## Checklist do INTEGRACAO.md §6

- [x] Não criar tabela de login/usuário própria
- [x] Login chama `POST /api/auth/login`
- [x] Backend valida a sessão/token em toda rota
- [x] Permissão checada por `permissoes.includes("fatura.…")`
- [ ] Escopo aplicado — pendente: nenhuma consulta filtra por escopo ainda
- [x] Sistema + telas auto-registrados via `POST /api/registry/sync`
- [x] Trata `senha_provisoria` (onboarding) e o `403 INATIVO`
