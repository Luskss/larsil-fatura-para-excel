# Progresso — precisão do comparador

Estado do trabalho sobre `routes/comparar-notas.js` e o painel de comparação em
`conferencia-notas.html`. Complementa `ANALISE-COMPARADOR.md` (a auditoria original).

- **Última atualização:** 18/09/2026 (§17 — os quatro dias que faltavam, 14 a 18/09)
- **Situação:** itens 1–9 e 12–14 da auditoria aplicados e medidos. A regra de
  corroboração (6.1) foi **decidida e medida**; 6.2 e 6.3 foram **apurados**. Restam os
  itens de decisão de negócio (10, 11, filiais) e dois pontos novos na seção 6.
- **Pendência mais antiga de pé:** a escolha de valor de §16 (11/09) nunca foi ao banco —
  o ganho de 54% → 71% existe como número, não como dado. Ver §17.9.

> **Estado do motor vivo (08/09/2026): 2.110 pares, 91,5% confirmados por 2º campo.**
> Última mudança em `TIPOS-IGNORADOS-COMPARADOR.md` §20 — o veto de data (`JANELA_DIAS`)
> deixou de valer na passada das **pastas vizinhas** quando a entidade também bate. Ali
> a distância de data é estrutural (o papel é arquivado quando chega, a planilha lança no
> pagamento), então valor + entidade já bastam. O mês corrente segue com os 15 dias:
> relaxar lá troca 6 pares por piores, porque o documento de número idêntico costuma estar
> na pasta +1 e a passada vizinha só recebe quem ficou pendente.
>
> **Armadilha de medição (§20.1):** testar o pareamento sem `enriquecerComOcr` deixa o
> documento **sem data**, e aí o veto de janela não se aplica — o par passa no teste e
> falha na rota. Foi o que me fez concluir errado que o caso da MACPONTA funcionava. Para
> conferir um caso como o painel o vê, use `_medir/_rota.js` (chama o handler real) ou
> `_medir/_variantes.js` (pipeline completo, 6 meses). `_medir/_t5.js` **não** enriquece.

> **⚠ Leia antes de aplicar qualquer coisa deste documento (02/09/2026).**
> O motor descrito aqui (`parcelaLivre`, `corroborado`, `scoreCandidato`, seção 6b,
> 1.198 linhas) **não está em produção** — ele vive em `git show
> HEAD:routes/comparar-notas.js`. A rota viva é a de contagem (693 linhas), que desde
> 02/09/2026 tem um pareamento próprio e bem mais simples em `routes/_pareamento.js`.
> Confirme em qual das duas a mudança entra. Quadro comparativo em
> `TIPOS-IGNORADOS-COMPARADOR.md` §11.
>
> **Medição nova (`TIPOS-IGNORADOS-COMPARADOR.md` §10):** casar por
> **"valor OU (número E entidade)"** domina o casamento por valor nos dois eixos
> (cobertura 33,3% → 36,7% *e* confirmação 74,6% → 77,0%), e 25,4% dos pares feitos
> só por valor têm entidade e número discordando. Exigir data ≤ 15 dias quando o par
> se apoia só no valor corta 27% desses suspeitos. §10.6 confirma, por outro caminho,
> a colisão de número que §10.4 deste documento achou pela chave de acesso.
>
> **Aplicado (§10.8 e §10.9):** a regra acima está no ar, com o card "Conferidos" no
> painel, e a busca em pastas vizinhas `[-1,+1,+2]` também — cobertura de 36,7% para
> 62,3%. Uma correção ao §12 deste documento: o vizinho que pesa é **+1**, não −1
> (136 pares de 04.2026 contra 17 de 02.2026, em março), porque o papel é arquivado
> quando chega e a planilha lança no pagamento.
>
> As regras deste documento que o pareamento novo **ainda não tem**: parcela
> 1 lançamento ↔ N documentos (§14) e CNPJ como veto. Nota: boa parte do efeito de
> §14 já aparece de graça — quase todo par recuperado em +1 é parcela, e o caminho
> "número + entidade" os casa sem precisar do `parcelaLivre`.
- **§10 é a primeira medição contra documento real** (PDF na pasta), não contra baseline —
  inclui o primeiro número de precisão com gabarito e a correção da chave de acesso.

---

## 1. Baseline validado (importante)

Toda comparação "antes × depois" deste documento usa um baseline **reconstruído e
verificado**, não uma estimativa.

`git HEAD` **não** serve como "antes": ele é anterior à correção do item 0 (aba/cabeçalho)
e devolve 0 notas. O estado que a auditoria mediu era HEAD + item 0, que estava só na
working tree, sem commit.

O baseline foi reconstruído aplicando **apenas** o item 0 sobre `git HEAD`:

1. inserir `acharCabecalho(wb)` (varre abas e as 200 primeiras linhas procurando
   `ORIG, NF, ENTIDADE, VL_TOTAL_CAB`, comparando com `norm()`);
2. trocar `wb.Sheets[wb.SheetNames[0]]` / `rows[1]` pela chamada a `acharCabecalho`;
3. `for (let i = 2; ...)` → `for (let i = headerRow + 1; ...)`;
4. lançar erro quando `porPeriodo.size === 0`.

**Validação:** o baseline reproduz os 7 números documentados na auditoria para
Março/2026 — `totalPlanilha 2573`, `encontradas 493`, `divergentes 120`,
`dataDivergente 21`, `naoEncontradas 2381`, `faltandoPlanilha 269`, `tributos 86`.
Todos conferem. É o "antes" correto.

O arquivo está em `routes/_baseline.js`. **Não commitar** — é artefato de medição.
Fica em `routes/` porque precisa resolver `../config` e `./_helpers`; as rotas são
carregadas explicitamente em `server.js`, então ele não vira endpoint.

---

## 2. Como medi (não é contagem, é pareamento)

Contar `encontradas` não diz se o casamento está certo. A medição compara o
**pareamento** documento-da-pasta → nota-da-planilha entre baseline e atual, e
classifica cada documento em: mesmo pareamento / reatribuído / perdido / ganho.

Depois, cada perda é **atribuída a um aperto específico**, relaxando uma variável por
vez (`JANELA_NF_MESES`, `JANELA_VALOR_MESES`, `DF_DISCRIMINANTE`, chave de agrupamento,
duas passadas) e vendo qual traz o documento de volta.

Scripts em `…\AppData\Local\Temp\claude\…\<sessão>\scratchpad\`:
`baseline.js` (gera o baseline), `pareamento.js` (par a par), `atribuir.js` /
`atribuir2.js` (atribui cada perda a uma causa), `porque.js` (imprime emitente ×
entidade e cada condição), `meses.js` / `meses2.js` (vários períodos),
`medir.js` / `ent2.js` / `prefixo.js` (entidades), `ordem.js` (independência de ordem),
`corrob.js` … `corrob5.js` (as variantes de 6.1), `diverg.js` (categoriza divergências),
`dupl.js` (nota nas duas listas). São temporários — se sumirem, a receita do baseline
acima permite regerar tudo.

As variantes são testadas escrevendo uma cópia de `comparar-notas.js` com o bloco
`corroborado` substituído em `routes/_c*_<variante>.js`, rodando, e apagando em seguida —
`routes/` porque o módulo precisa resolver `../config` e `./_helpers`.

---

## 3. Resultado medido — 8 períodos

`B` = baseline, `A` = atual.

Medição de 14/08/2026, já com a regra de corroboração final (6.1) e a correção do
`tipoBate` (9b). Os cards fecham (`totalPlanilha = encontradasPlanilha + naoEncontradas`)
nos 8 períodos.

> ⚠ A coluna **"Na planilha"** desta tabela é **anterior** à exclusão de
> `DESPESAS BANCARIAS` do escopo (§9.1) — em Março, 2.586 aqui contra 2.403 hoje. As
> colunas de pareamento (perdidos/ganhos/reatribuídos) continuam válidas: as notas
> excluídas tinham cobertura zero, então nenhuma delas participava de casamento.

| Período | Na planilha B→A | Encontradas B→A | Divergentes B→A | Mesmo par. | Perdidos | Ganhos | Reatribuídos |
|---|---|---|---|---|---|---|---|
| 01/2026 | 1747 → 1755 | 463 → 462 | 120 → 128 | 457 | 4 | 3 | 2 |
| 02/2026 | 2066 → 2078 | 473 → 476 | 125 → 133 | 468 | 2 | 5 | 3 |
| 03/2026 | 2573 → 2586 | 493 → 491 | 120 → 129 | 489 | 4 | 2 | 0 |
| 04/2026 | 1832 → 1837 | 516 → 503 | 49 → 67 | 503 | 13 | 0 | 0 |
| 05/2026 | 1823 → 1836 | 405 → 398 | 18 → 35 | 395 | 8 | 1 | 2 |
| 06/2026 | 2060 → 2079 | 499 → 488 | 12 → 33 | 484 | 12 | 1 | 3 |
| 11/2025 | 122 → 122 | 27 → 25 | 15 → 14 | 25 | 2 | 0 | 0 |
| 12/2025 | 327 → 329 | 38 → 36 | 14 → 13 | 36 | 2 | 0 | 0 |

**Total: 47 perdas, 12 ganhos, 10 reatribuições** (era 83 / 14 / 8 antes da decisão 6.1).

Leitura: o pareamento é **estável** (quase nada é reatribuído), "Na planilha" sobe pela
correção da chave de agrupamento, e as perdas restantes estão atribuídas uma a uma (§5 e §6.2).

> Ao comparar pareamentos, o identificador tem que incluir o **valor**: depois que o
> `VL_TOTAL_CAB` entrou na chave de agrupamento (item 6), `periodo|nf|entidade` deixou de
> ser único — SANESUL `219736` de 06/2026 são duas notas, R$ 172,16 e R$ 168,63. Com o id
> fraco, uma aparece como "nota nas duas listas"; com o valor, a colisão é zero nos 8 períodos.

**Entidades:** os pares casados entre as 2.283 entidades distintas caíram de **332 para
101** (231 colisões eliminadas), mantendo os casos que precisam casar (ELEKTRO,
SANESUL, EVOLUTIZE, acentuação).

**Independência de ordem:** embaralhando as notas da planilha com 3 sementes, o
pareamento de Março não muda — nem com nem sem a correção de duas passadas. O modo de
falha existe no código, mas não se manifesta nos dados medidos.

---

## 4. Correções desta rodada (além das 12 já descritas na auditoria)

Vieram da inspeção das perdas, não de leitura de código:

1. **Total de parcelas declarado virou preferência, não veto.** Eu tinha feito o N
   declarado pelo parser restringir a busca. Na NFS 1862 da ESSOR o campo diz "4" e a
   nota é de **7** parcelas (R$ 7.515,96 ÷ 7 = R$ 1.073,71, o valor exato do boleto) —
   o casamento certo era descartado. Agora testa o N declarado primeiro e depois os demais.
2. **Raiz do CNPJ (8 dígitos) como evidência positiva.** A planilha lança pela matriz e
   o documento vem da filial: COOPERCITRUS `45236791/0001-91` × `/0052-31`, VAMOS
   `57213191/0001-97` × `/0007-82`. Continua sendo só positiva — raiz diferente não rejeita.
3. **Corroboração não exige entidade quando o banco não tem emitente.** Boleto de parcela
   costuma vir sem emitente nenhum (NF 898045: R$ 480.000 ÷ 12 = R$ 40.000 exatos).
4. **CNPJ/CPF malformado sai do núcleo.** "GM & S TRANSPORTES 8796767000180" tem 13
   dígitos e escapava das regex de CNPJ/CPF; o número virava token e quebrava a
   comparação. Corta corridas de 11+ dígitos (números curtos são nome: "RESTAURANTE BR 376").
5. **Nº de documento sai do núcleo.** Sem emitente, o fallback lê o nome do arquivo e
   produz coisas como `SAVANA. NF158648 +`.
6. **Prefixo para abreviação, simétrico, mínimo 5 letras.** "ACESS" × "ACESSORIOS",
   "EQUI" × "EQUIPAMENTOS". Com mínimo 4, "ROSA" vira prefixo de "ROSANE" e casava
   "ROSANE ROSA" com todo sobrenome ROSA da base (colisões subiam para 140).

**Descartado por medição:** exigir apenas os tokens *raros* (deixando as palavras do ramo
livres) recupera a AUDEME, mas leva os pares casados de 101 para **549** — qualquer par
que divida um token raro passa a casar. Mantida a contenção total + discriminante.

**Correção de contabilidade:** a identidade `encontradas = encontradasPlanilha +
outroMesBanco` **não é invariante** — uma fatura consolidada é 1 documento cobrindo N
notas (em 01/2026, 1 documento absorve 12). A dica do card foi reescrita para não afirmar
essa soma. A identidade que vale sempre, e que os cards usam, é
`totalPlanilha = encontradasPlanilha + naoEncontradas`, verificada nos 8 períodos.

---

## 5. Perdas aceitas (Março, todas justificadas)

| Documento | Motivo de não casar mais |
|---|---|
| `FT7900` BANCO SANTANDER | planilha R$ 1.377.307,85 × pasta R$ 52.610,67, razão 26,18 — não é fração de parcela; casava a 33 meses de distância |
| `499851` FIG TELECOM | razão 10,97, também não fecha como parcela |
| `17914` LOCALIZA | razão 8,76; o pareamento antigo já era divergência de valor |
| `246879` BIOS NETWORKS | conta mensal de valor fixo (R$ 1.095,67); casava o PDF de Março com a nota de 11/2025 — é exatamente a armadilha de recorrente que a janela existe para evitar |

O `112` GOMES E SAVACINSKI saiu desta lista: com a regra 6.1 final ele **volta a casar**.
O boleto é emitido pelo BANCO JOHN DEERE (financiador), então a entidade nunca ia bater —
mas R$ 700,28 × 10 = R$ 7.002,80 contra R$ 7.000,00 na planilha fecha como parcela 10x,
que é a evidência que a regra passou a aceitar.

---

## 6. Em aberto

### 6.1 ✅ Regra de corroboração — decidida e medida (14/08/2026)

As três variantes previstas foram medidas, mais duas que a inspeção sugeriu. O critério de
aceitação (continuar cortando `FT7900` e `499851`) foi verificado, não presumido, e uma das
candidatas **falhou nele**: aceitar só `valorBate.ok` traz a `FT7900` de volta em 01/2026,
razão 26,19 a 31 meses de distância.

| variante | encontradas (6 meses) | perdas vs baseline | inéditos | `FT7900` |
|---|---|---|---|---|
| (a) exige entidade (era o estado atual) | 2.787 | 78 | 16 | cortado |
| (b) só `valorBate.ok` | 2.826 | **36** | 13 | ⚠ **volta** |
| (c) só valor exato, sem fração | 2.796 | 69 | 16 | cortado |
| **(f) entidade ou parcela plausível** ← escolhida | 2.818 | 43 | **12** | cortado |
| (g) plausível sempre, sem entidade | 2.802 | 57 | 10 | cortado |
| (h) plausível sempre + entidade | 2.771 | 92 | 14 | cortado |

**Escolhida (f):** sem acordo de entidade, o valor só corrobora se o documento se explicar
como total (cabeçalho/soma dos itens) ou como **parcela plausível** — razão `total ÷ valor`
a menos de 0,01 de um inteiro, com N ≤ `MAX_PARCELAS`.

Duas hipóteses foram **descartadas por medição**, não por argumento:

1. *"Casar com um `VL_ITEM` individual é evidência fraca"* — variantes (c)/(d)/(e).
   Não é: a parcela legítima está gravada exatamente assim (R$ 7.300,01 da CIMAG é um
   `VL_ITEM` de uma nota de R$ 21.900). Recuperavam só 15 dos 42 casamentos.
2. *"Exigir plausibilidade sempre, inclusive quando a entidade bate"* — variante (g).
   Corta 2 inéditos ruins (`2020.03.05` MARIA MARGARIDA, R$ 150.000 × R$ 1.200, razão 125,
   a 71 meses) mas custa 14 casamentos — e um dos 2 que corta é a `FT567.683` da RANDON
   **ADMINISTRADORA DE CONSÓRCIO**, razão 29,002: parcela de consórcio legítima, barrada só
   porque `MAX_PARCELAS = 24`. Fica registrado abaixo como item novo.

### 6.2 ✅ Perdas de 04, 05 e 06/2026 — atribuídas

Com a regra (f) as perdas caíram de 23/15/17 para 13/8/12, e cada uma tem causa:

| Causa | 04/2026 | 05/2026 | 06/2026 |
|---|---|---|---|
| Razão não fecha como parcela (o corte pretendido) | 5 | 4 | 3 |
| Mesmo período — não é a janela | 5 | 4 | 2 |
| Recuperação por valor+emitente fora da janela de ±1 mês | 3 | 0 | 7 |

- **Corte pretendido:** `FT7900` (26,18), `499851` FIG (10,97), `728062` BRADESCO (8,889),
  COCARI `174418`/`172712` (2,27 / 2,25), `902197` SCM (7,41), `105912` LOCALIZA (2,66).
- **Mesmo período:** distância 0 meses, então `corroborado` nem é consultado — vêm dos
  outros apertos (entidade, chave de agrupamento), já atribuídos na rodada anterior.
- **Valor+emitente:** contas recorrentes de valor fixo (DETRAN PR, BIOS, M2B) que o
  baseline casava com o mês errado — a armadilha que `JANELA_VALOR_MESES` existe para
  cortar. **Ressalva:** 3 delas (`410081` LOCALIZA, `894294` DETRAN, `36` CELSO GARCIA)
  estão a apenas 1 mês, deveriam passar pela janela de ±1 mês, e não apurei por quê.

### 6.3 ✅ Alta de divergentes em 05 e 06/2026 — inspecionada, é legítima

Não é ruído. Classificando as divergências pelo texto do alerta:

| | 03/2026 | 05/2026 | 06/2026 |
|---|---|---|---|
| Divergências novas vs baseline | 12 | 22 | 26 |
| ...que são "possível parcela não confirmada" | 12 | 20 | 22 |

São razões inteiras exatas em documentos que não se declaram parcelados — o alerta do
item 2 da auditoria funcionando (`7.482,20 ÷ 2`, `9.084 ÷ 3`, `5.000,12 ÷ 6`,
`24.654 ÷ 10`). O salto é maior em 05 e 06 só porque esses meses partiam de uma base
baixa (18 e 12 divergências), não porque tenham algo de diferente.

A inspeção rendeu de brinde a regressão **9b** (`tipoBate` com `NÃO IDENTIFICADO`
acentuado, que parou de funcionar quando o item 9 introduziu `deacc`): 3 divergências
falsas em 06/2026 e 1 em 05/2026, já corrigidas.

### 6.4 `MAX_PARCELAS = 24` é baixo para consórcio (novo)

A `FT567.683` da RANDON ADMINISTRADORA DE CONSÓRCIO tem razão 29,002 — parcela 29x de um
consórcio, que hoje passa só porque a entidade bate. Qualquer regra que dependa de
plausibilidade de parcela vai barrá-la. Consórcio costuma ter 60–80 parcelas; subir o
limite é tentador, mas afrouxa a plausibilidade para todo mundo. Não medido.

### 6.5 Casamentos inéditos ainda suspeitos (novo)

Dos 12 inéditos da variante escolhida, um é claramente errado e **não vem da mudança de
6.1** (existe também na regra antiga): `2020.03.05` MARIA MARGARIDA, planilha R$ 150.000,00
de 03/2020 × documento de R$ 1.200,00 em 02/2026 — razão 125, distância 71 meses. Passa
porque a entidade bate e algum `VL_ITEM` vale R$ 1.200. Sugere que a janela deveria ter um
limite duro de distância mesmo com entidade confirmando. Não medido.

### 6.6 Itens da auditoria não mexidos

- **10 e 11** (55.585 linhas de cartão descartadas; `RECIBO E OUTROS → '*'` desligando a
  validação de tipo em 15.758 linhas) — decisão de negócio, continuam como estavam.
- **Filiais** (`ELEKTRO …0001-97` × `…0002-78`) continuam casando entre si. Separá-las
  exigiria deixar o CNPJ **rejeitar** um casamento, e o código documenta que o CNPJ do
  lado banco é ruidoso demais para isso.

---

## 7. Arquivos tocados

| Arquivo | Situação |
|---|---|
| `routes/comparar-notas.js` | alterado — todas as correções acima; em 08/09/2026, `empatesParaTela` e os campos de irmãos/empates no bloco `conferencia` |
| `routes/_pareamento.js` | o motor vivo desde 02/09/2026 — em 08/09/2026 ganhou o veto de janela relaxado nas pastas vizinhas (§20), os maços de arquivamento e a marcação de empates |
| `conferencia-notas.html` | alterado — card "Divergentes" (subtração dupla), dicas dos cards e, em 08/09/2026, a tabela "Mais de um documento possível" |
| `ANALISE-COMPARADOR.md` | atualizado com o que foi aplicado |
| `routes/_baseline.js` | **artefato de medição, não commitar** |
| `_medir/_variantes.js` | harness dos 6 meses (pares / 2º campo / fracos) — **é o que valida qualquer mudança no motor**; artefato, não commitar |
| `_medir/_rota.js` | chama o handler real da rota fora do servidor; artefato, não commitar |
| `_medir/_irmaos.js`, `_medir/_t5.js` | inspeção de maços e de escopo; artefatos. `_t5.js` **não** enriquece com OCR — ver §20.1 |

---

## 8. Por que "faltando na pasta" é tão alto (medido em 14/08/2026)

Março/2026 mostra 2.383 notas sem documento, de 2.586. **Não é defeito do comparador e não
é específico de Março** — a proporção é a mesma em todos os meses:

| Período | Notas no escopo | Casadas | Sem documento |
|---|---|---|---|
| 01/2026 | 1.755 | 188 | 89,3% |
| 02/2026 | 2.078 | 183 | 91,2% |
| 03/2026 | 2.586 | 203 | 92,2% |
| 04/2026 | 1.837 | 189 | 89,7% |
| 05/2026 | 1.836 | 175 | 90,5% |
| 06/2026 | 2.079 | 191 | 90,8% |

### A hipótese do item 0 estava errada

A auditoria supôs que "o relatório mensal no banco parece cobrir só parte do mês". A
distribuição por dia do `DT_LANCAMENTO` refuta: **todos os dias têm notas casadas e não
casadas**, com cobertura entre 12% e 25% em cada dia útil. Não há janela de dias ausente.
(Os dias com 100% — 01, 08, 14, 15, 21, 22, 28 — são fins de semana, com 2 a 10 notas cada.)

### A causa real: os dois lados não contêm o mesmo tipo de coisa

A pasta tem 848 documentos contra 2.586 lançamentos na planilha. **Mesmo casando 100% dos
documentos da pasta, 1.738 notas continuariam sem par** — o teto é estrutural, não de
precisão. O que sobra é dominado por lançamento que não gera documento arquivável:

| TIPO | Sem documento | % | Cobertura |
|---|---|---|---|
| RECIBO E OUTROS | 1.460 | 61,3% | 8% |
| NOTA FISCAL RFB | 352 | 14,8% | 30% |
| NOTA FISCAL SERVICO | 272 | 11,4% | 28% |
| DESPESAS BANCARIAS | 183 | 7,7% | **0%** |
| FATURA | 114 | 4,8% | 47% |

Abrindo os 1.460 `RECIBO E OUTROS` por entidade: 334 alimentação (restaurante, lanchonete,
padaria, supermercado — R$ 135 de média), 279 pessoa física (reembolso/autônomo), 105
administradora de cartões (ACG), 103 folha e encargos (FGTS, FOLHA DE PAGAMENTO), e o
restante pulverizado em fornecedores miúdos.

A cobertura cai junto com o valor, o que é coerente com "despesa miúda não é arquivada":

| Faixa | Cobertura |
|---|---|
| < R$ 50 | 1% |
| R$ 50–200 | 8% |
| R$ 200–1k | 17% |
| R$ 1k–10k | 35% |
| > R$ 10k | 37% |

### O número que interessa não é 2.383

Só **624** das 2.383 (`NOTA FISCAL RFB` + `NOTA FISCAL SERVICO`) são nota fiscal de verdade,
que deveria ter documento correspondente. Esse é o universo real de conferência; o resto é
ruído estrutural inflando o card.

---

## 9. Ajuste aplicado em 14/08/2026 (decisão do usuário)

### 9.1 `DESPESAS BANCARIAS` fora do escopo

Tarifa bancária não gera PDF para arquivar: **183 notas em Março, cobertura de exatamente
0%** — nenhuma casou em nenhum período medido. Entrou em `TIPOS_NAO_FISCAIS`, pelo mesmo
critério que já valia para `IMPOSTO` e `PREVISAO`.

> **Reverte uma decisão anterior.** O código registrava explicitamente
> *"DESPESAS BANCARIAS fica de fora — mantida na conferência por opção do usuário"*. A opção
> foi revista com a medição de cobertura na mão. Se a intenção original era vigiar essa
> categoria por outro motivo, é só tirar da lista.

Verificação de consistência: `encontradas` **não mudou em nenhum período** ao excluí-las —
o que confirma a medição de cobertura zero. Se alguma tivesse casado, o número teria caído.

| Período | Na planilha (antes → depois) | Faltando na pasta (antes → depois) |
|---|---|---|
| 01/2026 | 1.755 → 1.629 | 1.567 → 1.441 |
| 02/2026 | 2.078 → 1.888 | 1.895 → 1.705 |
| 03/2026 | 2.586 → 2.403 | 2.383 → 2.200 |
| 04/2026 | 1.837 → 1.671 | 1.648 → 1.482 |
| 05/2026 | 1.836 → 1.652 | 1.661 → 1.477 |
| 06/2026 | 2.079 → 1.922 | 1.888 → 1.731 |

Os cards continuam fechando (`totalPlanilha = encontradasPlanilha + naoEncontradas`).

### 9.2 Card "Faltando na pasta" passa a destacar as fiscais

O card mostrava lançamento contábil, não documento esperado. Agora destaca
`naoEncontradasFiscais` — as categorias com equivalente fiscal (`NF`, `NFS`, `FATURA`,
pelo mapeamento que `tipoPlanilhaParaBanco` já fazia) — com o total logo abaixo
("de 2.200 lançamentos") e a composição por TIPO na dica.

Em Março: **738 fiscais** de 2.200. Note que são 738, não os 624 estimados na análise
inicial: `FATURA` (114) entra, porque tem a **maior** cobertura de todas as categorias
(47%) — tratá-la como não documental seria contraditório.

A aba "Faltando na pasta" continua listando tudo, mas ordenada com as fiscais primeiro;
sem isso elas ficavam diluídas entre milhares de recibos, páginas adiante.

### Ainda em aberto nesta frente

`RECIBO E OUTROS` continua sendo 1.460 das 2.200 de Março. É categoria guarda-chuva do
Delsoft — engloba recibo, consórcio, NF avulsa —, então **não** dá para excluir em bloco
como as outras: parte dela tem documento legítimo (8% de cobertura). Separar o que é
despesa miúda do que é nota avulsa exigiria regra por entidade, não por TIPO.

---

## 10. Chave de acesso da NF-e — validação com gabarito real (14/08/2026)

Primeira medição desta série feita contra **documento real**, não contra o baseline.
Fontes: planilha `Consulta Delsoft.xlsx`, pasta
`\larsil-dell\ALRF26.EXT.BANC\2026.03.EXTRATOS CONTABILIDADE\SANTANDER` (190 PDFs de
documento) e o `dados_parser` gravado no banco.

> A pasta é **área viva**: hoje ela tem 190 documentos com numeração 000–025 por dia,
> enquanto o relatório de 03.2026 registra 848 entradas numeradas 081–089 para a mesma
> pasta. Não dá para amarrar linha do relatório ao PDF exato — os arquivos foram
> renumerados. As medições abaixo são sobre o conteúdo atual da pasta.

### 10.1 O que os documentos realmente são

Os PDFs são **multi-documento**: página 1 é o boleto, página 2 em diante é a DANFE. Isso
explica o que a auditoria vinha atribuindo a "erro de leitura da IA": **boleto não tem
número de nota fiscal**. Quando o PDF é só boleto, a IA é obrigada a preencher um
`Nº da NF-e` que não existe no documento — e devolve o Nosso Número, o valor, ou nada.
Não é desatenção, é pergunta sem resposta. Daí a instabilidade: o mesmo arquivo relido em
outro relatório dá outro número (11 de 24 documentos repetidos entre relatórios).

### 10.2 A chave estava lá e não era lida

A DANFE traz a chave de acesso, impressa em grupos de 4 dígitos separados por espaço:

```
CHAVE DE ACESSO
5026 0103 7275 1600 0120 5500 1000 1842 4718 7636 0858
```

Ela dá, deterministicamente: **CNPJ do emitente** (dígitos 7–20) e **número da nota**
(dígitos 26–34 → `184247`).

| | |
|---|---|
| PDFs de documento em Março | 190 |
| Sem camada de texto (exigiriam OCR) | 1 |
| **Com chave de acesso válida** | **86 (45,3%)** |
| Nº da chave confere com o número real da nota | **76** |
| Diverge | **0** |

Zero divergências. Onde existe, a chave é fonte confiável.

**Por que não era usada:** a regex de chave só existia em `parseDanfe`/`parseCte`, e
`PARSERS = { CTE, NF, IMPOSTO }`. Mas a produção quase não usa esse caminho — em 03.2026,
**702 dos 848 documentos (83%) foram extraídos pela IA**, que é instruída a ler campos de
boleto e nunca recebe pedido de chave:

| Origem da extração | Documentos | Com chave de acesso |
|---|---|---|
| IA | 702 | **0 (0,0%)** |
| conteúdo (parser local) | 91 | 21 (23,1%) |
| demais | 55 | 0 |

### 10.3 Correção aplicada

`chaveAcessoDoTexto` / `nfDaChaveAcesso` / `cnpjDaChaveAcesso` / `enriquecerComChaveAcesso`
em `routes/_nf-parsers.js`, chamados nos **dois** caminhos de `process-folder.js` (IA e
parser local). Nada vem do nome do arquivo — só do texto do documento.

Detalhe que só apareceu na medição: **código de barras de boleto também tem 44 dígitos**.
Sem validar estrutura, a linha digitável de uma conta da SABESP virava
"NF 100100108 do CNPJ 01001000801001", e contas da ELEKTRO geravam notas inexistentes. A
chave da NF-e é validável — código de UF nas posições 1–2 e modelo (55/57/65) nas 21–22 —
e o filtro derrubou 9 chaves falsas de 95.

O comparador usa o número da chave como busca adicional (`Nº da NF-e (chave)`, mais o
derivado de `Chave de acesso` para relatórios antigos). **Sem efeito nos relatórios já
gravados** — eles vêm do extrator antigo; o ganho aparece no reprocessamento. Verificado
que não há regressão nos 6 períodos (encontradas, faltando e divergentes idênticos, cortes
de `FT7900` e `499851` mantidos).

### 10.4 Precisão com gabarito — o primeiro número real

Confronto dos 86 documentos de nota fiscal comprovada contra a planilha inteira:

| | | |
|---|---|---|
| Achados por **nº + CNPJ do emitente** | 44 | 51,2% |
| Achados pelo nº, CNPJ não confirma | 34 | 39,5% |
| **Sem correspondência na planilha** | **8** | **9,3%** |

Os 34 do meio quase todos são casamento correto em que **a planilha não tem CNPJ**
(`cnpj=(sem)`) e o nome bate à vista: GRANFER, ALAGRO, PROFETA PNEUS, EMBREMAC, UNIPETRO.
Somando, **~91% das notas fiscais comprovadas estão na planilha**.

Mas 2 dos 34 são colisão real: as NF **706 e 708**, do CNPJ `32418130000135` no documento,
caem sobre `FRISIA COOPERATIVA` (`76107770000361`) e `EXPRICE CONS CONTABIL`
(`40910185000196`) na planilha — empresas diferentes com o mesmo número de nota. O CNPJ da
chave é a única evidência capaz de rejeitá-las, e hoje o código usa CNPJ apenas como
evidência **positiva** (ver "Filiais", §6.6).

### Em aberto nesta frente

- **Usar o CNPJ da chave para REJEITAR casamento.** Diferente do CNPJ lido pela IA (ruidoso,
  às vezes o do pagador), o da chave é estrutural e confiável. Seria a primeira evidência
  negativa do comparador — mudança de política, precisa de medição própria.
- **Deixar `Nº da NF-e` vazio quando o documento é só boleto**, em vez de preencher com algo
  plausível. Hoje o número inventado ativa buscas que casam errado.
- **Reprocessar os períodos** para que a chave passe a existir nos relatórios; sem isso a
  correção fica inerte.

---

## 11. Linha digitável do boleto — valor e vencimento sem depender de leitura (14/08/2026)

Continuação de §10, respondendo "e os boletos e recibos?". Mesmo método: medir contra
os PDFs reais da pasta de Março.

### 11.1 Que evidência determinística cada documento tem

| | docs | % |
|---|---|---|
| Chave NF-e **+** boleto | 79 | 41,6% |
| Só boleto | 31 | 16,3% |
| Só chave NF-e | 7 | 3,7% |
| **Nenhuma das duas** | **73** | **38,4%** |

### 11.2 Boleto: o código carrega valor e vencimento

A linha digitável (47 dígitos) traz o fator de vencimento nas posições 34–37 e o valor em
centavos nas 38–47. Não é leitura, é aritmética:

| | |
|---|---|
| Documentos com linha digitável | **110 (57,9%)** |
| Valor decodificado confere | **109** |
| Vencimento decodificado impresso no próprio documento | **110 (100%)** |

A única "divergência" de valor é artefato do nome do arquivo
(`007.DOC- 13950,2026.03.25.BRV`, sem separador entre valor e data): o decodificado
R$ 13.950,00 está correto. Na prática, **110/110** nos dois campos.

**Aplicado:** `linhaDigitavelDoTexto` / `dadosDoBoleto` / `enriquecerComBoleto` em
`routes/_nf-parsers.js`, chamados nos dois caminhos de `process-folder.js`. Gravam
`Linha digitável`, `Banco do boleto`, `Valor do boleto` e `Data de vencimento`.
`extrairValorDeParsed` passa a **preferir** `Valor do boleto` ao valor lido pela IA — é a
primeira vez que o comparador usa uma fonte verificável de valor.

Dois cuidados que a implementação precisou:

- **Fator de vencimento tem duas leituras.** O contador estourou 9999 e reiniciou em
  1000 = 22/02/2025, então o mesmo fator dá duas datas; escolhemos a que cai na janela
  de operação. Sem isso, todo vencimento sairia com ~27 anos de erro.
- **Carnê não pode herdar o boleto.** Extraímos UMA linha digitável; num carnê ela é de
  uma parcela só. Os campos do boleto são removidos das linhas de carnê — ali quem sabe
  separar as parcelas é a IA.

Sem efeito nos relatórios já gravados (o campo não existe neles) e sem regressão nos
6 períodos.

### 11.3 Recibo: o número não está no documento

Hipótese testada e **descartada**: os 73 sem âncora são Pedidos de Compra internos
(`Rpdc002a-125`) e trazem `Número Pedido`. Parecia ser a chave de casamento — mas o
Número Pedido só existe na planilha em **19 de 54 (35%)**, com valor conferindo em 3,
enquanto o número que está no *nome do arquivo* acerta 31. Não é a chave.

O que a inspeção mostrou: o PDF arquivado é o pedido interno, **não a conta do
fornecedor**. O número que casaria (`RCB 216180`, `FAT 405315`) foi lido do papel pelo
arquivista e digitado no nome — não está no conteúdo digitalizado. Nenhuma melhoria de
extração resolve isso.

O que o Pedido de Compras **tem**, com rótulo: fornecedor, CNPJ, valor da parcela e data
de vencimento. Para esses documentos o caminho é `fornecedor + valor + vencimento` sem
número — que é o `valor-emitente` já existente, hoje limitado a ±1 mês e marcado como
fraco; a diferença seria alimentá-lo com campos determinísticos em vez de adivinhados.

Exceção útil: conta de concessionária declara o número em texto claro
(`NOTA FISCAL No. 4053158 - SÉRIE 0`, ELEKTRO) — 8 documentos na amostra.

### Em aberto nesta frente

- **Beneficiário do boleto por posição.** Varrer CNPJ solto é fraco: só 22% dos documentos
  têm exatamente um CNPJ fora do grupo, 62,6% são ambíguos (pagador, beneficiário,
  sacador, banco). O PyMuPDF dá coordenadas — dá para ler o valor ao lado do rótulo
  "Nome do Beneficiário" em vez do texto achatado. Resolveria o "quem" dos 110 boletos.
- **`NOTA FISCAL No. X` rotulada** nas concessionárias.
- **`PAGADOR_CNPJ_ROOT` é uma constante só** (`08420245`, LARSIL). Na pasta medida a
  pagadora é ALR FLORESTAL (`52387856`, em 85% dos documentos) e não seria filtrada. Não
  se manifestou nos relatórios atuais — risco, não defeito medido.
- **Processo, não código:** para os 73 sem número, a conta do fornecedor precisaria ser
  arquivada junto com o pedido. Hoje a informação que casaria some antes de chegar ao sistema.

---

## 12. Pastas vizinhas — os cards não fechavam porque mediam coisas diferentes

**Gatilho:** o usuário apontou que 491 encontradas + 738 faltando não chega perto das 2.403
da planilha, e perguntou se a lógica de contagem funciona.

### O que a auditoria mostrou (03/2026)

A contagem estava **certa**, e fechava — só que em dois universos separados que o card
somava visualmente:

```
lado PASTA      491 + 271 + 86 = 848 = documentos indexados   (491 arquivos distintos, 0 repetidos)
lado PLANILHA   203 + 2200 = 2403
```

`Encontradas = 491` conta DOCUMENTO; `Na planilha` e `Faltando na pasta` contam LANÇAMENTO.
Somar os dois nunca poderia fechar.

### O defeito real por trás disso

Dos 491 documentos da pasta de Março, só **203** casam com linha de Março; **288 (59%)**
casam com linhas de meses anteriores — dominante −1 mês (160), −2 (65), −3 (41). Não é
anomalia de Março: todos os 6 períodos ficam entre 56% e 62%.

A simetria disso é que a pasta de **Abril** guarda os documentos de Março. Medida da
cobertura real das 2.403 linhas de Março:

| origem do documento | linhas cobertas |
|---|---|
| pasta de 03.2026 | 203 |
| **pasta de 04.2026** | **181** |
| 02, 05, 06 | 11 |
| **total** | **395 (16,4%)** |

E das 738 "faltando na pasta (fiscais)", **170 tinham documento arquivado** — só que na
pasta do mês seguinte (ELEKTRO 419428, CIT DRIVE 24, TICKET 523078, AUTO BATERIAS 84109…).

### Correção — seção 6b

Última chance antes de declarar a linha sem documento: procura nas pastas `[-1, +1, +2]`
meses. Só por NÚMERO, e com guard **mais estrito** que o da seção 5 — fora do mês não existe
o contexto que sustenta um match só por número, então exige entidade compatível **ou** valor
confirmado, além do número. Guias de tributo e lançamentos de cartão são excluídos dos
candidatos.

Esses documentos **não** entram na contagem da pasta (`docsCasados`) nem em "faltando na
planilha" — senão o mês vizinho apareceria inteiro como problema deste mês, e o mesmo
documento seria "da pasta" em dois meses. Eles apenas retiram a linha de "faltando".

| período | docs pasta | casados | **vizinhas** | falt. planilha | falt. pasta (fiscal) |
|---|---|---|---|---|---|
| 01/2026 | 771 | 462 | 167 | 224 | 396 |
| 02/2026 | 825 | 476 | 154 | 256 | 455 |
| 03/2026 | 848 | 491 | **185** | 271 | **738 → 575** |
| 04/2026 | 868 | 503 | 139 | 269 | 355 |
| 05/2026 | 710 | 398 | 193 | 210 | 428 |
| 06/2026 | 731 | 488 | 14 | 211 | 564 |

06/2026 recupera pouco porque 07.2026 tem só 26 documentos processados — é o fim da série,
não regressão. `docsCasados` e `faltandoPlanilha` **não mudaram em nenhum período**: a
seção 6b não toca no lado da pasta. FT7900 e 499851 seguem cortados.

### Bug menor achado no caminho

O lado PASTA não fechava em 5 dos 6 meses (por 1 ou 2 documentos): lançamentos de cartão
(`CC278`) eram descartados em silêncio, sem entrar em nenhuma lista. Agora são contados em
`resumo.cartoes`. Com isso as **duas** identidades fecham nos 6 períodos:

```
docsPasta   = docsCasados + tributos + faltandoPlanilha + cartoes
totalPlanilha = encontradasPlanilha + naoEncontradas
```

### Cards

Reorganizados em três blocos com unidade explícita — "Planilha — lançamentos", "Pasta —
documentos", "Para conferir" — cada um com a identidade que fecha impressa embaixo. É o que
impede a pergunta de voltar: o número pode ser conferido na tela.

### Em aberto

- A janela `[-1, +1, +2]` foi escolhida pela distribuição medida, não otimizada. +3 em diante
  rende pouco (5 linhas em Março) e cada pasta extra custa uma leitura de relatório.
- Custo: 3 consultas a mais por requisição. O parse é cacheado por período+tamanho; a busca
  do CONTEÚDO não.
- A cobertura real de Março segue baixa em termos absolutos (395 de 2.403) — a causa é
  estrutural (§8), não de casamento.

---

## 13. Veracidade medida contra gabarito real — e a causa dos falsos "sem lançamento"

### Correção do que foi afirmado em §10 e §11

O gabarito usado naquelas seções veio de `\larsil-dell\ALRF26.EXT.BANC\...`. **Não é a pasta
que o sistema processa.** O `MONITOR_PATH` do `.env` aponta para outro caminho, e os dois
conjuntos têm **zero nomes de arquivo em comum** (692 do relatório × 190 do disco). Os números
de precisão de §10/§11 descrevem uma população que nunca entrou nesta comparação — não valem.
A validação dos extratores (chave de acesso, linha digitável) continua válida: valida o
decodificador, não a população.

Março não é auditável: a pasta monitorada é diretório de trabalho, esvaziado a cada ciclo.
Hoje só contém Maio.

### Gabarito real — 05/2026

540 dos 702 documentos do relatório ainda estão no disco (77%). Desses, **124 (23%)** têm chave
de acesso NF-e válida → NF e CNPJ verdadeiros.

**Casamentos declarados:**

| | |
|---|---|
| nº da linha == nº da chave | 82/97 (84,5%) |
| divergentes com CNPJ confirmando o fornecedor (fatura × NF-e anexa) | 3 |
| divergentes com fornecedor **errado** | **0** |
| divergentes indecidíveis (linha sem CNPJ) | 12 |
| CNPJ da linha × CNPJ da chave, onde há CNPJ | **43/43** |

Nenhum casamento provadamente errado; nenhum caso de casar com a empresa errada.

**"Sem lançamento": 17 de 27 (63%) são falsos** — a nota existe na planilha com o mesmo número
E o mesmo CNPJ. 13 dos 17 com razão inteira exata. O sistema **leu o número certo em 23 dos 27**
— não é falha de leitura.

### Causa, rastreada

`CN_DEBUG_NF=266` na seção 6 (instrumentação temporária, já removida):

```
doc nf=266 valor=1150.21 emitente="ADS DISTRIBUIDORA..." cnpj=41614003000100
  chave "266": 2 linhas no indice global
    per=11.2025 ADS  valor=11502.13  dist=6  usada=false  valorBate=true/parcela 10x  entBate=true  corrob=true
  -> casa
(mesmo documento, 4 ocorrências seguintes)
    per=11.2025 ADS  valor=11502.13  dist=6  usada=TRUE   valorBate=true/parcela 10x  entBate=true  corrob=true
  -> sobreviveram aos guards: 0  => "sem lançamento"
```

**Cinco documentos em Maio trazem NF 266, R$ 1.150,21 cada — são 5 das 10 parcelas.** A planilha
tem **uma** linha: NF 266, ADS, R$ 11.502,13 em 11/2025. O primeiro documento consome a linha;
os outros quatro encontram `planilhaUsada=true` e caem em "sem lançamento".

Tudo que a regra precisa está certo — número, CNPJ, entidade, `valorBate = parcela 10x`,
`corroborado = true`. O único obstáculo é a invariante **1 documento ↔ 1 lançamento**, que uma
compra parcelada quebra por construção.

### Tamanho do efeito

Documentos em "sem lançamento" cujo número já foi consumido por outro documento, com razão
inteira entre 2x e 36x:

| período | sem lançamento | nº já consumido | é parcela |
|---|---|---|---|
| 01/2026 | 224 | 70 | 66 |
| 02/2026 | 256 | 89 | 84 |
| 03/2026 | 271 | 99 | 83 |
| 04/2026 | 269 | 103 | 93 |
| 05/2026 | 210 | 71 | 64 |
| 06/2026 | 211 | 72 | 49 |
| **total** | **1441** | **504** | **439 (30,5%)** |

### Correção proposta (não implementada)

Trocar a invariante por **1 lançamento ↔ N parcelas**: uma linha da planilha pode ser casada por
mais de um documento quando (a) o valor do documento é fração inteira exata do total,
(b) a quantidade de documentos casados não passa de N (a própria razão), e (c) a soma das
parcelas casadas não ultrapassa o total. Exibir como "Parcela k de N".

Riscos a cobrir antes: digitalização duplicada do mesmo boleto passaria a casar duas vezes
(hoje a segunda é barrada pelo `planilhaUsada`); e a contabilidade dos cards precisa decidir
se N documentos de parcela contam como 1 lançamento coberto (contam — a linha é uma só).

---

## 14. Regra de parcelas — 1 lançamento ↔ N documentos (implementada)

Correção da causa rastreada em §13.

### O que mudou

`planilhaUsada` deixou de ser veto absoluto na seção 6. Uma nota já casada volta a ser
candidata quando `parcelaLivre(p, rowB)` confirma, com **quatro** limites:

1. razão `total ÷ valor do documento` inteira, entre 2 e `MAX_PARCELAS`;
2. a série já aberta tem o mesmo N (nota consumida por algo que não é parcela nunca reabre);
3. o nº de documentos da série não passa de N e a soma não passa do total;
4. **deduplicação** — `chaveParcela` = vencimento, ou data de arquivamento se não houver.
   Sem nenhum dos dois a parcela é indistinguível e o documento é recusado.

O ponto 4 é o que devolve a proteção que o `planilhaUsada` dava sem querer: enquanto a nota
era consumida uma vez só, o mesmo boleto digitalizado duas vezes não casava de novo.
Parcelas de verdade têm vencimentos diferentes; a cópia repete o vencimento.

Na parcela adicional o `fraco` do `valorBate` não vira divergência (a razão inteira já foi
provada), e a nota ser de outro mês não vira `data-divergente` — é o esperado numa compra
parcelada. Exibe `ℹ Parcela k de N — R$x de R$y (nota lançada em Mês/Ano)`, `matchVia='parcela'`.

### Resultado

| período | casados | sem lançamento | parcelas |
|---|---|---|---|
| 01/2026 | 462 → 493 | 224 → 193 | 31 |
| 02/2026 | 476 → 513 | 256 → 219 | 37 |
| 03/2026 | 491 → 530 | 271 → 232 | 39 |
| 04/2026 | 503 → 551 | 269 → 221 | 48 |
| 05/2026 | 398 → 429 | 210 → 179 | 31 |
| 06/2026 | 488 → 521 | 211 → 178 | 34 |
| **total** | **+219** | **−219** | **220** |

As duas identidades continuam fechando nos 6 períodos. `encontradasPlanilha` e
`naoEncontradas` **não mudam** — N parcelas cobrem 1 lançamento, e a linha da planilha é uma
só; quem muda é o lado pasta. FT7900 segue cortado.

**Diferença de 1 em 06/2026** (34 parcelas, +33 casados): comparando contra uma variante com
`parcelaLivre` desligada, **nenhum documento deixou de casar** nos dois períodos testados. É
reclassificação — um documento que já casava por outro caminho passou a casar como parcela.

Os 6 casos marcados divergentes entre as 31 parcelas de Maio são alertas de **tipo**
(`banco FATURA × planilha NOTA FISCAL`), alheios à regra.

### Limite conhecido

A deduplicação por vencimento só é forte nos relatórios **reprocessados** — os já gravados
não têm o campo, e caem na data de arquivamento. Duas digitalizações do mesmo boleto
arquivadas em dias diferentes ainda passariam. O teto (N documentos, soma ≤ total) limita o
estrago a uma parcela contada a mais numa série.

## 15. Retenção na fonte — o imposto não é divergência (10/09/2026)

> **Índice do capítulo.** Começou numa nota que o painel acusava errado e terminou
> reescrevendo como o sistema lê documento-imagem. Quatro coisas mudaram de fato —
> §15/§15.1/§15.2 (parser de NFS-e), §15.9 (disjuntor de OCR), §15.11/§15.13
> (visão) — e três foram medidas e REPROVADAS, que valem tanto quanto:
>
> | § | assunto | resultado |
> |---|---|---|
> | 15 | retenção lida do papel, conta conferida | 131 → 96 divergências |
> | 15.1 | rótulo `IR`, colisão ISSQN×COFINS | +2 notas em março |
> | 15.2 | dois layouts de NFS-e (municipal e nacional) | 12 → 16 em março |
> | 15.3 | por que mandamos texto à IA, e não a nota | 32 registros com dado deduzido |
> | 15.4 | consolidado dos dois layouts | **131 → 68**, R$ 13.019,88 |
> | 15.5 | o que a 1ª gravação ensinou | conferir conteúdo, não contagem |
> | 15.6 | `getTable` por geometria | **REPROVADO** (16 → 11) |
> | 15.7 | pareamento por quebra de linha | **REPROVADO** (16 → 5) |
> | 15.8 | balanço: texto está no teto | o ganho está na imagem |
> | 15.9 | falha de OCR era destrutiva | disjuntor + recusa de gravar |
> | 15.10 | visão × OCR | 0 campos → 37 campos |
> | 15.11 | visão aplicada na rota | 3 defesas, 4 bugs achados |
> | 15.12 | openai × anthropic | natureza do erro > contagem |
> | 15.13 | gpt-4.1-mini + prompt v2 | melhor E mais barato |
>
> **O fio condutor:** nenhuma fonte prova a si mesma. O que sustentou a qualidade
> em todas as etapas foi a VERIFICAÇÃO — a aritmética do papel
> (`bruto − retenções = líquido`) e o gabarito do nome do arquivo —, não a escolha
> de biblioteca, modelo ou provider.

### O caso que abriu o assunto

O painel acusava **CORREA TRUCK HOUSE, NF 377**: planilha R$ 3.690,00, documento
R$ 3.505,50, diferença −R$ 184,50 (−5,0%). Abrindo o PDF, os R$ 184,50 são o **ISSRF
retido na fonte** — a NFS-e imprime "Valor Serviço 3.690,00", "ISSRF 184,50", "Valor
Líquido 3.505,50", e o boleto Santander cobra os 3.505,50.

Nenhum dos dois números está errado. A planilha lança o **bruto** (a despesa
contratada); o boleto cobra o **líquido**; a diferença é o tributo que o tomador
recolhe no lugar do prestador. O comparador é que estava lendo o campo errado.

### Causa raiz: NFS-e não tinha parser

`PARSERS` em `_nf-parsers.js` cobria CTE, NF (DANFE) e IMPOSTO. **NFS caía no
genérico**, que grava um `Valor total` só, sem distinguir bruto de líquido. Medido
com `_medir/_campos-retencao.js` sobre 10.926 documentos com `dados_parser`:
**nenhum campo de retenção existia no acervo** — não havia o que comparar.

Como o rótulo `VALOR LIQUIDO` é uma das alternativas de `porRotuloServico`
(`_nf-itens.js:309`), o valor gravado para a NFS-e costumava ser o líquido.

### O caminho reprovado: adivinhar a alíquota

Primeira tentativa (`_medir/_retencao-aritmetica.js`): testar se a diferença bate
com alguma alíquota legal (ISS 2–5%, IRRF 1,5%, PIS/COFINS/CSLL 4,65%, INSS 11%),
sozinha ou somada duas a duas. Sobre 131 divergências (fora parcela):

| classe | n | % |
|---|---|---|
| explicadas por alíquota | 50 | 38,2% |
| desconto ≤15% NÃO explicado | 37 | 28,2% |
| diferença >15% NÃO explicada | 23 | 17,6% |
| documento MAIOR que o lançado | 21 | 16,0% |

**Reprovado.** O ISS é municipal e a base varia: ARPSEG retém 3,52% em três notas,
AGRIPONTA 3,97% e 4,11%, ANDRADE MARTINS 3,33% — percentuais estáveis por
fornecedor e ausentes de qualquer tabela. Ampliar a lista de alíquotas até
alcançá-los faria a regra "explicar" **qualquer** diferença pequena, engolindo erro
de digitação junto. É o mesmo erro que `_cabecalho-nf.js` já documentou para o
total da nota: número errado com cara de certo é pior que campo vazio.

### A regra adotada: ler o que a nota escreve, e conferir a conta

`parseNfse` (novo, em `_nf-parsers.js`) lê os três valores e cada tributo pelo seu
próprio rótulo. `retencaoDoParser` (`comparar-notas.js`) só aceita quando a
**aritmética fecha no próprio papel**: `bruto − Σretenções = líquido`, com um
centavo de folga por tributo.

A trava não é decorativa. Medido em `_medir/_parser-nfse.js`: a NFS-e da **SKILLHUB**
imprime "IRRF 1,50 / COFINS 3,00 / PIS 0,65", que são **alíquotas, não valores**
(1,5% de 790,12 = 11,85, não 1,50). Somá-las daria R$ 5,15 e "explicaria" um
desconto de R$ 48,59 como retenção parcial. Exigir que a conta feche recusa esses
casos: sem bruto e sem líquido impressos, não há o que verificar.

**ISSQN fica fora da soma**: nas notas da ROCHA & ROCHA e da CONSEGMA esse rótulo
vem seguido da BASE DE CÁLCULO (`ISSQN 17.000,00` = o próprio bruto), não do
imposto. O ISS efetivamente retido tem rótulo próprio (ISSRF / ISS RETIDO).

### Onde cada peça entra

- `_nf-parsers.js` — `parseNfse` registrado em `PARSERS.NFS`. Só **acrescenta**
  campos: `extrairNotaFiscal` continua rodando em `process-folder.js` e o
  `Object.assign` mantém a precedência do parser de tipo, então `Valor total` não
  se perde.
- `_pareamento.js` — `enriquecerComOcr` põe o **bruto** em `d.valor` (é o que a
  planilha lança) e guarda o líquido em `valorAlt`. Como `valorBate` testa os dois,
  **nenhum par existente se perde**: a mudança é aditiva.
- `comparar-notas.js` — `ehRetencao` tira o caso da lista e conta em `retencoes` /
  `valorRetencoes`, do mesmo modo que a parcela já saía.

`ehRetencao` é testado **antes** da tolerância de diferença, de propósito: com o
bruto em `d.valor` o par passa a bater e cairia no `continue`, saindo da lista sem
ser contado — correto na tabela e invisível no rodapé.

### Resultado medido (jan–jun/2026, `_medir/_retencao-efeito.js`)

|  | antes | depois |
|---|---|---|
| divergentes na lista | 131 | **96** |
| valor da divergência | R$ 649.869,76 | R$ 644.856,29 |
| parcelas (fora) | 104 | 104 |
| retenções (fora) | 0 | **58** |
| imposto retido | — | **R$ 6.723,64** |

**35 linhas saíram** da lista e **nenhuma entrou**. As 58 contadas superam as 35
porque 23 pares já batiam por outro caminho e agora ficam explicitamente
classificados — a invariante é `saiu ≤ contadas`, não igualdade.

Entre as que saíram: CORREA TRUCK NF 377 (−184,50), ROCHA & ROCHA NF 38 (−1.045,50),
onze notas da ARPSEG, MRD ENGENHARIA, KUHNEN, HOSPITAL MOURA, LOCALIZA.

O que **permanece** na lista é problema de verdade: par errado (GIZELE FERREIRA NF
3764, WN AUTO ELETRICA NF 143), valor invertido (FERNANDO MENDES 10.044 × 10.440),
documento maior que o lançado (MS LOCAÇÕES).

### Limite conhecido

Os campos novos só existem em documentos **relidos**. O acervo já gravado não os
tem, então o efeito na tela depende de reprocessamento — ver
`cache-esconde-mudanca-de-extracao.md`. A medição acima simula o estado pós-releitura
lendo os PDFs na hora (cache em `_medir/.cache/retencao.json`, 87 arquivos com
retenção conferida em 4.238 lidos).

Fora do alcance da regra: NFS-e cujo PDF é **imagem** (só o OCR lê) e notas que
imprimem o líquido sem discriminar o tributo — nessas a conta não fecha e o caso
continua, corretamente, na lista.

### §15.1 — Duas falhas de leitura achadas ao auditar março (10/09/2026)

Auditar as NFS-e que **não** fecharam a conta (`_medir/_nfse-sem-retencao.js`, 98
notas de 03.2026) separou o correto do defeito. Das 88 sem retenção conferida:

| classe | n | veredito |
|---|---|---|
| bruto == líquido (nota sem retenção) | 31 | correto |
| papel diz explicitamente "não retido" | 13 | correto |
| sem vocabulário de retenção | 3 | correto |
| declara mas não leu bruto nem líquido | 21 | fora de alcance (layout/imagem) |
| declara, leu só um dos dois | 17 | fora de alcance |
| **leu os dois e a conta não fechou** | **3** | **defeito real** |

Os 3 últimos eram bug, e a inspeção do PDF da **GENUSCLIN NF 37846** mostrou duas
causas distintas no mesmo papel (layout de Cascavel/PR):

1. **rótulo `IR`, não `IRRF`.** A linha é `ISSQN 179,43 ISSRF 0,00 IR 89,72 INSS
   0,00 CSLL 59,81 COFINS 179,43 PIS 38,88`. Buscar só `IRRF` perdia os R$ 89,72.
2. **colisão de valor entre colunas.** `ISSQN 179,43` e `COFINS 179,43` têm o mesmo
   valor; somar rótulo a rótulo não distingue qual foi capturado.

**A correção não foi acrescentar mais rótulos** — foi usar o que a nota já calcula:
`TOTAL TRIB. FEDERAIS 367,84`. Confere: 89,72 + 59,81 + 179,43 + 38,88 = 367,84, e
5.981,00 − 367,84 = 5.613,16 (o líquido impresso).

`retencaoDoParser` agora testa candidatas em ordem — total federal impresso, total
federal + ISS municipal, soma dos rótulos — e **todas passam pelo mesmo teste de
fechamento**. Nenhuma é aceita por autoridade do rótulo, então a SKILLHUB (que
imprime alíquotas no lugar de valores) segue recusada. Verificado nos 6 casos de
`_medir/_parser-nfse.js` mais os adversos.

Efeito em 03.2026: **10 → 12 notas** com retenção conferida.

### §15.2 — Dois layouts de NFS-e, e o que era ruído (10/09/2026)

Auditadas as 88 NFS-e de 03.2026 que não fechavam (`_medir/_nfse-tem-retencao-real.js`),
a pergunta certa era: quantas têm ALGUM tributo **maior que zero** no papel? Só essas
podem ser perda; o resto é nota sem retenção.

| | n | veredito |
|---|---|---|
| retenção conferida | 12 | — |
| **nenhum tributo > 0 no papel** | **75** | não tem retenção; parser correto |
| tributo > 0 mas não fecha | 11 | candidatas reais |

Os 75 imprimem o vocabulário com valor zerado (`TRIBUTOS FEDERAIS PIS 0,00 INSS 0,00
CSLL 0,00 IRRF 0,00` — AGRO AIR, CLINVIDA, EDSON SOUZA) ou nem são NFS-e (SAVANA e
FIDELITY são boletos, só têm `VALOR DO DOCUMENTO`). **Escrever regex para eles seria
inventar retenção onde não há.**

Das 11 restantes, a inspeção achou um **segundo layout** — o padrão NACIONAL da NFS-e,
que nomeia tudo diferente:

| campo | municipal (Cascavel) | nacional |
|---|---|---|
| bruto | `VALOR SERVICO 5.981,00` | `VALOR DO SERVICO R$ 3.004,62` |
| líquido | `VALOR LIQUIDO` / `DA NFS-E` | `VALOR LIQUIDO DA NOTA` |
| total | `TOTAL TRIB. FEDERAIS` | `TOTAL DAS RETENCOES FEDERAIS` |
| agrupados | (rótulo por tributo) | `PIS/COFINS/CSLL 4,65%: R$ 25,39`, `CONTRIBUICOES SOCIAIS - RETIDAS` |

Note o `R$` entre rótulo e número, que o layout municipal não usa.

**A armadilha da alíquota, de novo.** `PIS/COFINS/CSLL 4,65%: R$ 25,39` fazia a regex
capturar **4,65** (o percentual) em vez de 25,39 — o mesmo erro da SKILLHUB, agora por
outro caminho. A correção foi negativa, não aditiva: `(?!\s*%)` em **todo** rótulo de
tributo recusa capturar valor seguido de `%`. Sem isso, `CSLL` sozinho também pegava 4,65.

Efeito em 03.2026: **12 → 16 notas**; não-fechadas de 11 → 7. As 7 restantes têm causa
conhecida e correta: SKILLHUB (alíquotas puras, recusa deliberada), UNAVANTI e MAQNELSON
(parcela, não retenção), LOCALIZA (tributos parciais no papel).

Verificado em 5/5 casos-limite, incluindo a recusa da SKILLHUB.

### §15.3 — "Por que mandamos texto à IA, e não a nota?" (10/09/2026)

Pergunta do usuário, e ela expõe um problema real — mas a premissa precisa de um
ajuste antes: **não mandamos texto *em vez* da nota.** Há três caminhos, e só dois
têm perda.

| caminho | fonte do texto | perda |
|---|---|---|
| PDF nativo (maioria) | `pdf-parse` lê o texto EMBUTIDO no arquivo | nenhuma — é o que o emissor gravou |
| PDF escaneado | servidor OCR (imagem → texto) | real: o layout se perde |
| escaneado **sem** OCR | **o nome do arquivo** | total: o dado é deduzido |

O terceiro caminho é o achado. `_nf-shared.js:47` instrui a IA, quando não há texto:
*"extraia os dados EXCLUSIVAMENTE a partir do nome do arquivo"*. Medido
(`_medir/_imagens-sem-ocr.js`): **67 linhas, 32 com `origem=IA`** (0,6% do acervo).
Exemplo real: o arquivo `002.DOC- Grupo 020280- Cota 919-…` produziu emitente
**"Grupo"** — a primeira palavra do nome, gravada como razão social.

É dado inventado com aparência de dado lido. Mesma família do que
`chave-acesso-valida-o-dv.md` já registrou.

**Onde visão ajudaria, e onde pioraria.** O ganho de mandar a imagem não é a IA
"ver" melhor — é remover o OCR, que entrega texto plano e joga fora o layout: qual
número estava em qual coluna. É exatamente a perda que causou os bugs de §15.1/§15.2
(o `ISSQN 179,43` colidindo com `COFINS 179,43`, o `4,65%` lido como valor). Mas nos
PDFs NATIVOS mandar imagem REDUZ a veracidade: trocaria texto exato por
reconhecimento visual.

**O que de fato sustenta a qualidade não é a fonte, é a VERIFICAÇÃO.** A conta
`bruto − retenções = líquido` recusou a SKILLHUB e o `4,65%` sem saber de onde o
texto veio. Ela funciona igual com pdf-parse, OCR ou visão — e continua necessária
em todos os casos, porque nenhuma fonte prova a si mesma.

Conclusão: visão faz sentido nos caminhos 2 e 3 (onde há perda medida), sempre com a
verificação aritmética por cima — nunca no lugar dela, e não no caminho 1.

### §15.4 — Resultado consolidado dos dois layouts (10/09/2026)

Regressão completa jan–jun/2026 (`_medir/_retencao-efeito.js`, cache de retenção
regravado com o parser de §15.2):

|  | antes | só layout municipal | **com os dois layouts** |
|---|---|---|---|
| divergentes na lista | 131 | 96 | **68** |
| valor da divergência | R$ 649.869,76 | R$ 644.856,29 | R$ 638.577,14 |
| parcelas (fora) | 104 | 104 | 104 |
| retenções (fora) | 0 | 58 | **89** |
| imposto retido | — | R$ 6.723,64 | **R$ 13.019,88** |

**63 linhas saíram, ZERO entraram.** A invariante `saiu ≤ contadas` fecha (63 ≤ 89;
a folga são os pares que já batiam por outro caminho e agora ficam classificados).

Suportar o layout nacional **quase dobrou** o alcance da regra — 58 → 89 — e a lista
de divergências caiu quase à metade do original (131 → 68). Entre as que saíram:
GENUSCLIN NF 37846 (−367,84, o caso que §15.1 consertou) e cinco notas da ROCHA &
ROCHA de ~R$ 1.045 cada.

O que **permanece** na lista continua sendo problema real: par errado (GIZELE
FERREIRA, WN AUTO ELETRICA), valor invertido (FERNANDO MENDES 10.044 × 10.440),
documento maior que o lançado (MS LOCAÇÕES).

### §15.5 — Releitura de 03.2026: o que a gravação ensinou

Executada em 10/09/2026 via PowerShell — **o bash corrompe o caminho UNC**
(`\larsil-dell\...` vira `C:\larsil-dell\...` ao comer as barras), e a primeira
tentativa morreu em ENOENT sem tocar o banco.

Resultado: 1.208 processados, 0 erros, 49,7 min. Dos 2.221 PDFs da pasta, 933
entraram (1.288 são CPV/extrato, filtrados por `ehAnexoIgnoravel`), e **0 foram
reaproveitados do cache** — que é o efeito esperado de `forceLocal`.

**A lição está na conferência.** `_medir/_conferir-retencao-gravada.js` foi ao banco
ler o CONTEÚDO e achou **10 retenções, não 16**: o processo carregou o `parseNfse`
na memória ao iniciar, antes das correções de §15.1/§15.2. Conferir só o log teria
mostrado "1.208 processados, 0 erros" e declarado sucesso.

É a mesma armadilha de `cache-esconde-mudanca-de-extracao.md`, numa variante nova:
lá o cache escondia a mudança, aqui é o **processo já em execução** que congela a
versão do código. Regra prática: mexeu no parser, a releitura em andamento está
obsoleta — é preciso rodar de novo.

### §15.6 — `getTable` (geometria) medido e REPROVADO como substituto (10/09/2026)

Hipótese testada: `getText` devolve texto plano e perde o layout — daí a colisão
`ISSQN 179,43` × `COFINS 179,43` da GENUSCLIN e a alíquota `4,65%` lida como valor.
O pdf-parse 2.x expõe `getTable`, que reconstrói tabelas pela GEOMETRIA do PDF. Se
cada tributo viesse em sua célula, a ambiguidade sumiria na origem.

A inspeção da GENUSCLIN foi animadora — a tabela sai perfeita, com cada tributo
isolado e acentuação preservada:

```
| ISSRF 0,00 | IR 89,72 | INSS 0,00 | CSLL 59,81 | COFINS 179,43 |
| PIS 38,88 | Total Trib. Federais 367,84 | Valor Líquido 5.613,16 |
```

**Mas a medição sobre as 98 NFS-e de 03.2026 reprovou** (`_medir/_tabela-vs-texto.js`):

| | n |
|---|---|
| as duas fontes acham (e concordam no valor) | 11 |
| **só o texto acha** | **5** ← a tabela perderia |
| **só a tabela acha** | **0** ← nenhum ganho |
| total hoje (texto) | 16 |
| total só com tabela | 11 |

Zero ganhos e cinco perdas, entre elas ROCHA & ROCHA (R$ 1.045,50), MRD e G.A.R —
justamente as do layout nacional que §15.2 acabou de consertar.

**Por quê:** inspecionando a MRD, `getTable` detecta 3 tabelas e **todas são do
pedido de compra anexo** (`Código | NCM | Material | UND | Qtde`), nenhuma da NFS-e.
O detector depende de LINHAS DESENHADAS, e o layout nacional dispõe os campos em
blocos sem bordas. Onde há grade (o DANFE municipal de Cascavel) funciona bem;
onde não há, não vê nada.

**Conclusão: manter `getText`.** Somar as duas fontes daria os mesmos 16 — o
esforço não se paga, e a tabela sozinha seria uma regressão de 16 → 11. Fica
registrado para ninguém retentar: o problema do texto plano é real, mas `getTable`
não o resolve neste acervo.

O que de fato resolveu foi ler o total que a própria nota soma (§15.1) e recusar
valor seguido de `%` (§15.2) — as duas travas verificadas pela aritmética.

### §15.7 — Pareamento por quebra de linha: medido e REPROVADO (10/09/2026)

Terceira alternativa testada. A premissa parecia sólida: `norm()` faz `\s+ → ' '` e
transforma o PDF numa fita, criando a colisão `ISSQN 179,43` × `COFINS 179,43`. E a
inspeção da GENUSCLIN mostrou que **o PDF já entrega o pareamento pronto**:

```
107: [ISSQN]   108: [179,43]
109: [ISSRF]   110: [0,00]
111: [IR]      112: [89,72]
```

Ou seja, a informação de layout nunca esteve perdida no arquivo — nós a descartamos
no primeiro passo. Colar cada rótulo ao valor da linha seguinte e separar os pares
com `;` deveria dar layout de volta sem biblioteca nova.

**Medido nas 98 NFS-e de 03.2026** (`_medir/_alt-quebra-de-linha.js`):

| | n |
|---|---|
| as duas acham (concordam) | 5 |
| **só a fita acha** | **11** |
| **só por linha acha** | **0** |
| total fita **16** · total por linha **5** | |

**Por quê:** o layout de linhas alternadas é MINORIA. Na maioria das notas rótulo e
valor já vêm na mesma linha, e a barreira `;` corta pares que estavam corretos —
ARPSEG (3 notas), KUHNEN, JOFER, LOCALIZA, TORNEARIA. Otimizar para o formato de um
documento quebrou os outros.

### §15.8 — Balanço: a extração por texto está no teto

Três alternativas medidas, três reprovadas:

| alternativa | resultado | por quê |
|---|---|---|
| adivinhar alíquota (§15) | 38% de cobertura | ISS é municipal, não há tabela |
| `getTable` geometria (§15.6) | 16 → 11 | não vê layout sem bordas |
| pareamento por linha (§15.7) | 16 → 5 | linhas alternadas são minoria |

O que funcionou foi sempre o mesmo padrão: **ler o que a nota afirma e conferir a
aritmética** (`bruto − retenções = líquido`). As 7 notas de março que ainda não
fecham têm causa conhecida e legítima — alíquotas puras (SKILLHUB), parcela
(UNAVANTI, MAQNELSON), tributos parciais (LOCALIZA).

**O ganho restante não está em ler melhor o texto que já temos.** Está nos 1.037
PDFs de 03.2026 que são IMAGEM (47% dos documentos da pasta): invisíveis a qualquer
parser de texto. É onde ficam os 66 registros que hoje têm dado deduzido do NOME do
arquivo (ver `ia-le-nome-do-arquivo-sem-ocr.md`).

### §15.9 — Falha de OCR era destrutiva na releitura; disjuntor adicionado (10/09/2026)

O `ocr_server.py` (PaddleOCR) morreu no meio da releitura de 03.2026 —
`MemoryError`, exit 3221225477. Causa: **três medições rodando em paralelo**, cada
uma abrindo milhares de PDFs, enquanto a releitura pedia OCR. Os erros foram
`Unable to allocate 7.38 MiB` e `could not create a primitive` **com 6 GB livres**:
memória não-contígua para o PaddleOCR, não falta de RAM.

Nada foi perdido — o `process-folder` acumula as rows e só grava no fim, e a
rodada foi interrompida em 65%. Mas a inspeção mostrou **dois modos de falha
silenciosos e destrutivos**, que existiam independentemente desta queda:

**1. Documento-imagem sem OCR virava row vazia.** O `catch` do `ocrViaBackend` só
logava; o documento seguia com `text = ''`, era classificado "Não identificado" e —
numa releitura, que regrava tudo — **sobrescrevia o dado bom** de uma leitura
anterior. Em `forceAI` é pior: sem texto, o prompt manda a IA extrair do NOME do
arquivo (§15.3), gravando dado deduzido como se fosse lido.

**2. O relatório mensal era regravado sem os perdidos.** Os `upsertRelatorio` no
fim gravam o que sobrou. Uma rodada em que centenas de documentos-imagem falharam
os **apagaria** do relatório. O log diria "processados N, 0 erros".

**Conserto** (`routes/process-folder.js`):

- `ErroOcrIndisponivel` distingue "o serviço não respondeu" (fetch falhou, HTTP
  5xx) de "o OCR rodou e não achou texto", que é resultado legítimo. HTTP 4xx
  continua erro comum — é problema do pedido, não do serviço.
- PDF que é imagem + OCR indisponível → **recusa** produzir row, nos dois caminhos
  (local e `forceAI`). Sem texto não há o que analisar; gravar seria inventar.
- **Disjuntor**: `MAX_FALHAS_OCR = 5` falhas CONSECUTIVAS abortam a rodada com
  mensagem explícita, **antes de qualquer `upsertRelatorio`**. Um erro isolado é do
  arquivo; uma rajada é do serviço. Na queda medida, as 45 falhas vieram sem
  nenhum sucesso entre elas.

Verificado nos 4 cenários (`scratchpad/testar-disjuntor.js`): conexão recusada e
HTTP 500 → `ErroOcrIndisponivel`; HTTP 400 → erro comum (não abre o disjuntor);
HTTP 200 → texto normal. E a ordem no fonte garante que o abort precede a gravação.

### §15.10 — Visão em vez de OCR: TESTADO e aprovado para PDF-imagem (10/09/2026)

Pergunta do usuário: em vez de OCR, renderizar a página e pedir à IA que leia.
Nunca havia sido testado — e a infraestrutura **já existia** (`anthropic-nota-fiscal.js`
e outras rotas já enviam imagem à IA; só não estavam ligadas ao scan).

Viabilidade confirmada: `pdf-parse` tem `getScreenshot`, que rasteriza a página em
PNG base64 **sem depender do Python** — contorna justamente o componente que caiu.

**Resultado em 10 PDFs-imagem de 03.2026** (`_medir/_visao-vs-ocr.js`, Haiku 4.5):

| | OCR + parsers | VISÃO |
|---|---|---|
| respondeu | 10/10 | 10/10 |
| **campos preenchidos** | **0** | **37** |
| tipo reconhecido | 10× "Não identificado" | RECIBO, EXTRATO, FATURA |

**Zero contra trinta e sete.** Nestes documentos o OCR devolve texto que os parsers
não classificam; a visão lê emitente, CNPJ, número, data e valor.

**Custo irrisório:** US$ 0,0022 por documento → **US$ 0,14 pelos 66** sem OCR,
**US$ 2,24 pelos 1.037** documentos-imagem de março.

**A conferência que o teste embutiu.** O valor lido pela IA foi comparado com o do
NOME DO ARQUIVO (digitado à mão pela equipe — gabarito independente):

- **5 batem no centavo**, com `ondeAcheiOValor` = "Valor debitado: R$ …"
- **3 divergem**, e a IA DECLARA o campo: `"SALDO DEVEDOR ATUALIZADO"`

As 3 são planilhas de evolução de dívida da CAIXA. Inspecionando o PDF renderizado:
o documento tem dezenas de valores e a coluna certa é "Valor total pago"
(R$ 166.960,86); a IA pegou o saldo devedor (R$ 2.663.696,90). **Não inventou —
leu a coluna errada**, e o primeiro prompt não distinguia as duas.

O campo `ondeAcheiOValor` foi o que tornou isso visível, e é a diferença prática
contra o OCR: a leitura vem com a sua própria procedência, então dá para conferir
sem abrir o papel. Serve de terceira verificação, ao lado da aritmética
(`bruto − retenções = líquido`) e do valor do nome do arquivo.

**Conclusão:** aprovado para os PDFs-imagem, onde hoje o resultado é zero ou dado
deduzido do nome (§15.3). NÃO substitui o texto nativo — ali `pdf-parse` já entrega
o que o emissor gravou. E não dispensa a verificação: continua valendo a regra de
que a fonte não é garantia, a conta é.

### §15.11 — Visão aplicada na rota (10/09/2026)

`routes/_nf-visao.js` (novo) + integração em `process-folder.js`. Para PDF-imagem a
ordem passa a ser **visão → OCR (reserva)**; PDF com texto nativo não muda.

Ligado por `VISAO_PDF` (padrão ligado; `VISAO_PDF=0` volta ao comportamento antigo
sem tocar código), porque consome API paga.

**Três defesas, todas nascidas de erro medido em documento real:**

1. **Gabarito do nome do arquivo.** O valor lido é comparado com o do nome
   (digitado à mão pela equipe — leitura independente). `bate` / `parcela` (razão
   inteira, legítima) / `diverge`. Divergiu? O número vai para
   `Valor lido (não confere com o nome)` e **não** vira valor do documento; os
   demais campos continuam valendo, porque o erro foi de QUAL número, não de leitura.
2. **`ondeAcheiOValor`** — o rótulo da célula de origem, exigido no prompt. Foi ele
   que expôs o `"SALDO DEVEDOR ATUALIZADO"` nas planilhas da CAIXA. Dá procedência
   à leitura sem abrir o papel.
3. **Retenção só com a conta fechando** — mesma disciplina de `retencaoDoParser`
   (§15): `bruto − retenções = líquido` ou os campos não são gravados.

**Bugs achados testando com PDF real (provider ativo = openai, GPT-4o-mini):**

| erro | consequência | correção |
|---|---|---|
| `"17.904,40"` → **17,90** | valor 1000x menor gravado como bom | `num()` decide pelo ÚLTIMO separador; 10/10 nos formatos |
| `valorTotal` vazio, líquido preenchido | valor entrava **sem passar pelo gabarito** | o líquido vira o valor a conferir |
| data `02/03/2028` (era 2026) | documento vai para pasta-mês inexistente e some | ano fora de [ano−6, ano+1] não é gravado |
| `valorDoNomeArquivo` ingênua | `3505,50`→505,50 e `10034,63`→34,63 | adotada a lógica de `valorDoNome`; 5/5 concordam |

O primeiro é o mais instrutivo: a trava do gabarito **não teria pego**, porque o
`valorTotal` vinha vazio e o veredito saía `sem-gabarito`. Uma defesa que não é
exercitada no caminho real não protege — só testar com documento de verdade mostrou.

### §15.12 — OpenAI × Anthropic na leitura por imagem (10/09/2026)

O provider ativo era **openai**, mas §15.10 mediu com **anthropic**. Rodar produção
com um provider medido em outro é confiar em número que não vale para o caso.
`_medir/_visao-openai-vs-anthropic.js` roda os DOIS sobre os MESMOS 20 PDFs-imagem,
comparando pelo valor do NOME DO ARQUIVO (gabarito digitado à mão pela equipe).

| | openai (gpt-4o-mini) | anthropic (haiku 4.5) |
|---|---|---|
| valor **confirmado** pelo gabarito | 8 | **12** |
| valor **DIVERGE** | **9** | **4** |
| sem gabarito | 3 | 2 |
| erro (marcou ilegível) | 0 | 2 |
| campos preenchidos | 112 | 118 |
| data plausível | 8 | 5 |

**Anthropic erra menos da metade dos valores** — 4 contra 9. E a natureza do erro
difere, o que importa mais que a contagem:

- **openai: erro de FORMATO.** `19.485,07 → 19,49` e `18.960,96 → 18,96` — razão
  exata de 1000×, truncamento no separador de milhar, **apesar do prompt exigir
  ponto decimal explicitamente**. Dois casos claros.
- **anthropic: erro de CAMPO.** Lê o número certo da célula errada (o
  `SALDO DEVEDOR ATUALIZADO` das planilhas da CAIXA). Nunca deformou um número.

Os 7 casos restantes do openai também são campo errado — os dois falham nas mesmas
planilhas bancárias, que são o documento genuinamente difícil (dezenas de valores,
nenhum rótulo óbvio de "o valor deste pagamento").

**Dois pontos honestos sobre o teste:**

1. **A primeira versão do comparador estava errada** e teria dado empate falso: eu
   fiz monkey-patch de `getActiveAiProvider`, mas `_nf-visao` desestrutura a função
   no `require` e congela a referência — teria rodado openai duas vezes. Trocado
   por parâmetro explícito em `lerPorVisao(...)`, e o roteamento foi PROVADO
   (zerando cada chave, cada provider reclama da sua) antes de gastar as chamadas.
2. **O "ilegível" do anthropic não é derrota.** Ele recusou 2 documentos em que o
   openai chutou valores errados (1.532,62 e 17.579,76 para gabaritos de 3.259,42 e
   1.459,72). Recusar é melhor que inventar.

**Decisão: a leitura por visão usa anthropic**, independente do provider configurado
para texto. `_nf-visao.js` fixa o provider dessa via, com o motivo no código.
O gabarito continua sendo a defesa principal: mesmo no anthropic, 4 em 20 divergem
e são barrados antes de virar valor do documento.

### §15.13 — gpt-4.1-mini com prompt v2: melhor e mais barato (10/09/2026)

O usuário tem créditos na OpenAI, então a pergunta virou "dá para viabilizar o
mini?". §15.12 tinha reprovado o `gpt-4o-mini` por DEFORMAR números — mas o
catálogo tem modelos mais novos e baratos que nunca foram testados.

`_medir/_visao-modelos.js` roda N modelos sobre os MESMOS 20 PDFs-imagem:

| modelo | DIVERGE (prompt v1) | DIVERGE (prompt v2) | US$/1.037 docs |
|---|---|---|---|
| gpt-4o-mini | 9 | — | 0,31 |
| gpt-4.1-nano | 6 | 8 | 0,27 |
| **gpt-4.1-mini** | 5 | **3** | **0,89** |
| haiku-4.5 | 4 | 4 | 2,59 |

**O prompt v2 tirou 2 dos 5 erros do 4.1-mini**, que passou a ter o melhor
resultado — por um terço do preço do haiku. Três mudanças, cada uma mirando um
erro medido:

1. **regra de conversão com o erro nomeado** — `"R$ 35.012,74" → 35012.74 (ERRADO:
   35.01 — isso perdeu os milhares)`, mais uma auto-checagem de ordem de grandeza;
2. **regra de comprovante/estorno** — o valor é o da operação, não saldo anterior
   nem total do dia (dois erros eram exatamente isso);
3. **`pareceTruncamentoDeMilhar()`** — diagnóstico, não correção (ver abaixo).

Os 3 erros restantes são as planilhas de dívida da CAIXA, onde **todos** os
modelos erram: não distinguem entre si por ali.

**O `nano` PIOROU com o prompt v2** (6 → 8). Prompt mais longo e detalhado não é
universalmente melhor — modelo menor se perde com mais instrução. Sem medir os
dois, a "melhoria" teria sido aplicada às cegas.

**Um erro meu, e por que não o contornei.** Escrevi primeiro uma função para
RECUPERAR o valor truncado (`35,01 → 35.010`). Ao testar, ela nunca passava na
reconferência: o truncamento apaga os centavos, então o número reconstruído jamais
bate no centavo. Dava para afrouxar a tolerância e "fazer funcionar" — seria
inventar precisão que não existe. Virou detecção pura: o valor continua barrado,
mas a linha ganha `Diagnóstico: o modelo truncou o separador de milhar`, e quem
confere sabe que basta reler a escala em vez de procurar outro campo. 9/9 nos
casos-limite, incluindo a recusa do `16.675,23` (dígito trocado, 0,5% de erro).

**Aplicado:** `MODELO_OPENAI = 'gpt-4.1-mini'` e o provider da via de visão passa a
ser `openai`. O gabarito segue como defesa principal — 3 em 20 ainda divergem e são
barrados antes de virar valor do documento.

### §15.14 — A linha digitável vence a leitura do valor (10/09/2026)

Acompanhando a releitura com visão, duas das 5 divergências eram boletos Itaú
escaneados. Num deles a visão leu **186,13** onde o valor é **13.166,11** — pegou
um fragmento e embaralhou os dígitos (o papel está torto e a fonte é fina).

**O projeto já tinha a defesa, e ela não alcançava este caso.** `dadosDoBoleto`
(_nf-parsers.js) decodifica o valor nas posições 37-46 dos 47 dígitos da linha
digitável — mas rodava só sobre TEXTO, e num PDF-imagem não há texto.

**Correção:** o prompt de visão passa a pedir `linhaDigitavel`, e quando ela vem
com 47 dígitos o valor decodificado **vence** o valor lido. A diferença é de
natureza: ler um número da página é reconhecimento (erra e produz outro número
plausível); decodificar por posição é aritmética (errar um dígito quebra a
decodificação, não produz valor crível).

Resultado nos dois boletos que divergiam:

| arquivo | antes | depois |
|---|---|---|
| ITAU …114105 | leu 186,13 → **diverge** | 13.166,11 → **bate** |
| ITAU …112520 | divergia | 13.209,83 → **bate** |

A origem gravada passa a ser `linha digitável (posições 37-46): 0001316611`, que
diz de onde o número veio.

**E a aritmética corrigiu a MINHA leitura também.** Ao inspecionar o PNG do boleto
eu li "13.186,11" no campo Valor do Documento e escrevi isso como o valor correto.
A decodificação devolveu 13.166,11 — que é o que está no nome do arquivo. O papel
é ruim o bastante para enganar leitura humana e de IA; o campo posicional não se
engana. Mesmo princípio de `chave-acesso-valida-o-dv.md`.

### §15.15 — Pendências abertas ao fim de 10/09/2026

1. **Reler 03.2026 de novo.** A rodada que gravou hoje começou ANTES da melhoria da
   linha digitável (§15.14). O ganho é pequeno — 2 boletos em 933 — e não valeu
   interromper uma rodada saudável, mas fica pendente. Conferir depois com
   `_medir/_conferir-retencao-gravada.js`: deve mostrar **16** retenções (hoje 10).

2. **Os outros cinco meses nunca foram relidos.** 01, 02, 04, 05 e 06/2026 seguem
   com a extração antiga: sem parser de NFS-e, sem os dois layouts, sem visão. A
   medição de §15.4 (131 → 68 divergências, R$ 13.019,88 em retenções) é o que se
   ganha ao reler todos — hoje isso existe só como número medido, não como dado
   gravado.

3. **Planilhas de evolução de dívida da CAIXA.** Nenhum modelo lê o valor certo
   (§15.12/§15.13): a página tem dezenas de valores e nenhum rótulo óbvio de "o
   valor deste pagamento". O gabarito do nome barra todos, então não entra dado
   errado — mas também não entra dado. Se virarem prioridade, o caminho provável é
   uma regra própria por emitente, não outro modelo.

4. **`VISAO_PDF=0` desliga a via de visão** sem tocar código, caso o custo de API
   precise ser cortado. Medido: ~US$ 0,90 por releitura mensal completa.

### §15.16 — A visão NÃO reduziu as notas não encontradas; achei uma regressão minha

Pergunta do usuário depois da releitura: "isso diminuiu a quantidade de notas não
encontradas?". Medido (`_medir/_efeito-visao-no-pareamento.js`, rodando o mesmo
`conferirPeriodo` sobre o índice de OCR de ANTES e o de DEPOIS):

| 03.2026 | antes | depois |
|---|---|---|
| casados no mês | 214 | 207 |
| casados em pasta vizinha | 187 | 190 |
| **sem documento** | **227** | **231** (+4) |
| ganharam documento | — | 4 |
| **perderam documento** | — | **8** |

**Piorou.** E a causa são dois bugs do `parseNfse` que criei no mesmo dia:

**1. O número era lido e DESCARTADO.** `parseNfse` grava sob a chave `'Nº da NFS-e'`;
`CHAVES_NUMERO` (comparar-notas.js) não a incluía. O parser extraía `530` corretamente
e o campo era jogado fora na leitura. As três notas da ARPSEG (NF 530/531/534)
perderam a via `numero+entidade`, que caiu de **41 para 29** pares.

**2. Campo vazio apagava campo bom.** O merge `{...novos, ...parserData}` em
process-folder.js dá precedência ao parser de tipo — e os parsers gravam `'—'` no
campo que não acharam. O travessão sobrescrevia o que o extrator tinha achado:
`Emitente` da ARPSEG passou de "ARPSEG LTDA - ARPSEG GESTAO E CONSULTORIA" para
"ARPESEG" (o nome do arquivo, com o erro de digitação da equipe).

**Corrigido:** `'Nº da NFS-e'` e `'Valor do serviço'` nas chaves procuradas; o merge
filtra `'—'`/vazio antes de aplicar a precedência. Verificado — o número volta.

**O banco ainda tem os dados ruins**: só uma nova releitura os substitui (ver §15.15,
item 1, cuja prioridade muda de "melhoria" para "conserto").

**A lição de método.** `_conferir-retencao-gravada.js` mostrava 16 retenções e dizia
"OK" — o que foi gravado estava certo. A regressão só apareceu ao medir o EFEITO NO
PAREAMENTO, que é o que o usuário vê. **Campo gravado não é campo usado**, e conferir
a gravação não substitui conferir a consequência.

### §16 — "Como acertar mais valores?" (11/09/2026)

Pergunta do usuário. A resposta ocupou o dia e mudou o entendimento do problema:
**o valor errado quase nunca é erro de leitura — é erro de ESCOLHA.**

#### §16.1 — Primeiro, "de agora em diante só vamos usar via ia"

Decisão do usuário, medida antes de aplicar (`_medir/_ia-vs-local-no-valor.js`).
A média solta por origem (IA 56% × local 22%) **não serve**: a IA foi usada
historicamente onde o parser local já havia falhado, então ela compara dificuldade,
não motor. A comparação pareada — os 220 arquivos com leitura das DUAS vias, mesma
dificuldade por construção — dá **IA melhor em 121, local melhor em 9**, líquido
+112. Mesma lição de `metrica-pareada-nao-ratio.md`.

Aplicado em `routes/force-scan.js`: o botão "Ler pasta" chamava `runScan` sem
`forceAI` e era o ÚLTIMO caminho gravando leitura só local — produzia resultado
diferente do scan agendado sobre os mesmos arquivos. Não é cheque em branco: o
extrator determinístico continua rodando ANTES da IA, que só preenche o vazio.

De brinde, um defeito achado no caminho: `scheduler.js` passava um callback `async`
ao node-schedule, que **ignora a promise devolvida**. Uma rejeição ali viraria
`unhandledRejection` e, no Node 25, derrubaria o processo sem imprimir nada.
Agora tem `.catch()`.

#### §16.2 — A anatomia dos erros, antes de qualquer conserto

Remendar prompt contra a classe errada é o que `remendo-de-prompt-quebra-o-que-funciona.md`
documenta como reprovado. Então `_anatomia-dos-erros-de-valor.js` classificou cada
erro pela RELAÇÃO ARITMÉTICA com o gabarito do nome (múltiplo inteiro, submúltiplo,
soma de itens, dígito a mais, transposto, vizinho).

`_erros-que-importam.js` cortou o escopo: dos 7.618 valores fora do alvo, **4.388
(58%) estão em documento que `categoriaNaoFiscal` já filtra da conferência** —
consórcio, empréstimo, crédito. Não são problema: o sistema não os usa. Sobram
**3.230** em documento fiscal.

E dentro deles, o achado que redirecionou o dia: em **1.476 (46%) o número CERTO já
está gravado na mesma linha, em outra chave** — 776 em `Valor do boleto`, 700 em
`Valor total`. 59% desses erros são pacote "+ BOL": a nota traz o total (R$ 3.220) e
o boleto a parcela que se paga (R$ 805), que é o que o nome registra. O pipeline
preferia o valor da NOTA.

#### §16.3 — O teto: quanto dá para ganhar sem reler nada

Antes de refinar a regra, `_teto-do-valor.js` mediu o limite. Um oráculo varre TODAS
as chaves numéricas de `dados_parser` (inclusive dentro de `Itens` e somas de
subconjuntos) e pergunta se existe ALGUM número que bate com o gabarito:

| | |
|---|---|
| hoje | 54% |
| regra "boleto<nota, depois total" | 67% |
| **teto de uma escolha perfeita** | **69%** |

Refinar a escolha rende no máximo +82 documentos. **O que está fora do teto é erro de
leitura de verdade** — só melhora relendo. `_ia-resgata-fora-do-teto.js` testou reler
por IA os 1.654 fora do teto (70% deles lidos por `local`, antes da decisão de §16.1).

#### §16.4 — A regra de precedência, e a trava que a salvou

`_valor-do-boleto-acerta.js` mediu as DUAS metades — medir só onde erra hoje é a
armadilha clássica, porque não conta quantos ACERTOS a troca vira erro.
"Boleto primeiro" media GANHA 1.530 / PERDE 101.

As perdas não se ignoram por causa de um líquido bom: sobrescrever leitura boa é o
dano de `ocr-cai-com-medicoes-em-paralelo.md`. `_perdas-da-regra-vencedora.js` olhou
as 101 e achou o padrão — **o boleto MAIOR que o total não é parcela, é multa/juros**
(130,16 onde se pagou 78,09, num documento do SENATRAN). Daí a trava: o boleto só
vence quando é MENOR que a nota.

#### §16.5 — A âncora: o usuário estava certo e eu não tinha conferido

"Não dá pra diferenciar pela fatura mesmo?" — eu havia afirmado que o número da
fatura não estava no PDF e que nenhuma leitura resolveria. **Tinha olhado só os
primeiros 1.800 caracteres da página 1** (a Ordem de Compra). O PDF tem 2 páginas.

`_bios-acha-a-fatura.js` conferiu: nos PDFs que trazem o BOLETO, o número está lá, ao
lado do valor DAQUELA fatura:

    Data Doc   Número Doc   Valor do documento
    11/10/25   242502       125,00
    11/11/25   245612        75,00

A contabilidade digita esse número no NOME do arquivo ("FT 245650"). Achá-lo no texto
e ler o valor vizinho é **determinístico** — não depende de IA nem de o valor ser o
mais destacado da página. Mede 93% de acerto quando age, e age em ~40% dos documentos.

Isto resolve a classe que NENHUMA releitura resolveria: a **ordem de compra coletiva**
(BIOS NET, 12 pontos de internet numa OCP só, um arquivo por ponto). O PDF vale
1.170,00 e cada arquivo paga 75,00 — só o número da fatura distingue.

`_ancora-mais-regra.js` respondeu se as duas melhorias somam ou se sobrepõem, em
amostra ALEATÓRIA de 300 documentos (semente fixa):

| configuração | acertos | taxa |
|---|---|---|
| hoje | 163 | 55% |
| só regra de campo | 181 | 61% |
| **âncora + regra** | **213** | **71%** |

Somam. A âncora tem prioridade; onde ela se cala, a precedência decide.

#### §16.6 — Três travas de sanidade, cada uma paga por um caso real

A âncora ingênua devolvia lixo plausível. Cada trava em `routes/_valor-do-pagamento.js`
existe por um documento específico:

1. **Encargo** (`RE_ENCARGO`) — devolvia 1,70 / 0,08 / 0,50: juros ao dia e multa, que
   no boleto ficam logo depois do número. Ancorada no FIM: o que reprova um candidato é
   o rótulo IMEDIATAMENTE antes dele, não a palavra solta na vizinhança. Sem isso,
   "…1,70 ao dia Valor do documento **728,00**" reprovava o 728,00 junto.
2. **Piso relativo de 1%** — candidato abaixo de 1% do maior valor é encargo ou alíquota.
3. **Rótulo de documento** (`RE_ROTULO_DOC`) — o "901512" do nome de um arquivo da
   IMOVEIS ANAPOLIS era a ORDEM DE COMPRA, e a janela caiu na tabela de materiais.
   "ORDEM DE COMPRA" e "PROJETO" ficam de FORA de propósito: são identificadores do
   comprador, não da nota. **Silêncio é melhor que um número plausível e errado.**

Com as travas, o acerto subiu de 86% para 93% e as perdas caíram de 3 para 1.

#### §16.7 — A validação que achou o que as medições não viam

Todas as medições acima testaram a decisão em cima dos dados JÁ gravados.
`_validar-pipeline-valor.js` roda `analyzePdf` de verdade — o caminho que o scan usa —
porque **"a regra acertaria" ≠ "o sistema acerta"**: a regra pode estar certa e ficar
no lugar errado do pipeline, ser sobrescrita adiante, ou não receber o texto.

Achou dois defeitos invisíveis para as medições anteriores:

- **5 documentos que tinham valor ficaram `null`**
- **1.653,04 virou 653,04** — leitura de SUFIXO, errada por um fator de 1.000 e com
  cara de certo. É a mesma armadilha que `valorDoNomeArquivo` já documentava
  ("3505,50" → 505,50), reencarnada numa regex nova.

O conserto é o lookbehind `(?<![\d.,])` em `RE_MOEDA`. Apareceu num documento real da
IMOVEIS ANAPOLIS durante a validação — não num teste sintético.

`_medir/_testar-valor-do-pagamento.js` fixa os dois como regressão, junto com os casos
que quebraram as versões anteriores da âncora: **28 casos, todos passando**. A bateria
existe porque "um conserto que passa no caso que o motivou mas quebra o vizinho" já
aconteceu duas vezes nesta sessão.

#### §16.8 — O que ficou no código

`routes/_valor-do-pagamento.js` (novo, ~240 linhas) decide qual valor do documento é o
que se paga. Ligado em `process-folder.js:518` (via IA) e `:857` (via parser local).

**Não apaga o valor lido**: o número anterior vai para `Valor total da nota` quando a
chave ainda não existe, e a proveniência fica em `Origem do valor pago` — para que a
conferência possa AUDITAR a escolha em vez de confiar nela.

#### §16.9 — Pendências ao fim de 11/09/2026

1. **Nada disto está gravado no banco.** O módulo decide na hora da leitura; as linhas
   já gravadas seguem com a escolha antiga. O ganho medido (54% → 71%) existe como
   número, não como dado — igual ao item 2 de §15.15, e agora por dois motivos.
2. **A regressão de §15.16 continua aberta**: 03.2026 precisa ser relido porque o
   `parseNfse` gravou número e emitente ruins. Código corrigido, banco não.
3. **Os outros cinco meses nunca foram relidos** (01, 02, 04, 05 e 06/2026).
4. **Nada foi commitado desde `a685dea` (03/09)**: o trabalho dos dias 09, 10 e 11 está
   todo na árvore de trabalho da branch `comparador-ocr-segundo-sinal`.

---

### §17 — Os quatro dias que este documento não tinha (14–18/09/2026)

Escrito em 18/09. O documento parou em §16.9 (11/09) enquanto o trabalho seguiu por mais
quatro dias, e o commit `be8c511` ("2.0.0 — Alguma hora...") engoliu tudo em 185 arquivos
sem mensagem. Esta seção recupera o que foi **decidido**, que é o que a mensagem de commit
perdeu. Três dos cinco dias terminaram em REPROVAÇÃO — e duas das reprovações vieram
depois de uma tabela agregada que dizia "aprove".

#### §17.1 — O parser de tipo não rodava no modo IA (15/09)

O defeito estrutural do período, achado ao investigar por que as retenções de §15.4 não
apareciam no banco. `analyzePdf` tem dois caminhos, e **só o caminho local chamava o
parser específico do tipo** (`parseNfse`, `parseDanfe`, `parseCte`, `parseImposto`). O
caminho de IA não chamava.

Como o modo IA é o de produção desde §16.1, o efeito era total: os campos que só o parser
de tipo produz **nunca chegavam ao banco, em documento nenhum, de mês nenhum**. Medido em
12 NFS-e reais de 03.2026, depois da releitura:

| campo | no papel | no banco |
|---|---|---|
| retenção (ISS 4,80 · COFINS 690,38 · PIS 149,89 …) | 5 | **0** |
| `Valor do serviço` | 11 | **0** |

E a IA não supria a falta: o schema do `extrairNotaAI` **não tem campo algum de retenção**.
§15.4 media R$ 13.019,88 em retenções em jan–jun — nada disso estava sendo gravado.

Corrigido em `process-folder.js:464`, com precedência conservadora: o parser de tipo
preenche **só o que está vazio**. Chave de acesso e linha digitável são validadas por
construção (DV mod-11, fator de vencimento) e leitura nenhuma substitui prova aritmética.

**A lição é de método:** `o-erro-mora-onde-a-funcao-nao-roda` já registrava este padrão, e
ele reincidiu. Uma função pode estar perfeita, testada e medida, e simplesmente não ser
chamada no caminho que a produção usa. Nenhuma medição de QUALIDADE do parser acharia
isso — só perguntar "ele roda aqui?".

#### §17.2 — A data de emissão: confirma o par, mas não casa (15/09)

`_medir/_data-como-sinal.js` mediu jan–jun, 2.108 pares. A emissão que a planilha registra
× a que o extrator leu da nota:

| força do par | as duas emissões coincidem |
|---|---|
| força 3 | **70,7%** |
| força 2 | 56,6% |
| força 1 | **3,3%** |

Razão de 20×. E o número que mais importa: dos 171 pares fracos, 122 têm as duas datas e
**118 divergem**. É a evidência independente — vinda de um campo que não participou do
casamento — de que **o par por valor sozinho é, quase sempre, colisão**. §17.3 e a memória
`precisao-multicampo-comparador` diziam a mesma coisa por outros caminhos; aqui um quarto
campo confirma.

**Virar 4º sinal foi medido e REPROVADO** (`_medir/_data-quarto-sinal.js`): −4 pares bons,
+2 duvidosos. A causa é sutil e vale guardar — somar força a quem TEM o campo **penaliza o
documento cuja emissão não foi lida**. A ausência de dado virava desvantagem competitiva, e
o par de força 3 perdia para o de força 2.

Ficou como **rótulo**, em `_pareamento.js:500` e `comparar-notas.js:1768`, com três estados
que o painel pinta: `true` divergem (suspeito) · `false` coincidem (confirmado por um campo
que não casou) · `null` falta uma das duas (o sinal se cala). Tolerância de 1 dia, porque
planilha digitada e leitura de papel não podem divergir por fuso.

#### §17.3 — A passada única: a tabela aprovou, a inspeção reprovou (15/09)

Dois lançamentos de março tinham valor E entidade batendo com documento do próprio mês e
não casavam, mortos no veto de 15 dias — que no mês corrente não aceita `entidadeDispensa`.
O diagnóstico apontava defeito de SEQUÊNCIA, não de limiar: se mês e vizinhas entrassem
numa passada só, `parear` ordenaria por força e o melhor documento venceria independente da
pasta.

A tabela agregada aprovou com folga:

| variante | pares | 2º campo | fracos |
|---|---|---|---|
| A produção | 2.108 | 91,9% | 171 |
| C passada única | **2.115** | **93,2%** | **143** |

**A inspeção dos 6 ganhos reprovou.** 3 bons (ERPO força 2, JESSICA força 2, IGUAÇU força
2) contra 4 falsos — todos força 1, fornecedor diferente casado só pelo valor, **três deles
em R$ 100,00**. Dois lançamentos distintos (BOA VISTA e JOHN LENON) casaram com o **mesmo**
documento. Assinatura de colisão de valor redondo.

Líquido negativo. **Por que o índice enganou:** "2º campo" é a PROPORÇÃO de pares com dois
sinais — acrescentar pares fracos e bons ao mesmo tempo pode subir a proporção enquanto a
qualidade cai. É `media-agregada-esconde-par-falso` reencarnado num experimento novo, e por
isso `_data-quarto-sinal.js`, escrito logo depois, **imprime cada par trocado**.

#### §17.4 — Cobertura × precisão, e o filtro que engole par bom (14–15/09)

`_estado-do-acervo.js` nasceu de "quais campos ele salva sem problema?" e separa duas
perguntas que o acervo mistura: **cobertura** (o campo está preenchido?) e **precisão** (o
que está lá está certo?). Um campo com 100% de cobertura e 50% de precisão é pior que um
com 60% e 95% — o primeiro **mente em silêncio**.

`_onde-melhorar.js` respondeu se o 63% era limite do sistema ou idade do dado, e a resposta
foi idade: linhas do parser local antigo convivem com linhas de IA, e as melhorias de 09–11
só alcançaram o que foi relido. Daí a releitura, que é o que entregou valor em 17/09.

`_custo-beneficio-do-filtro.js` achou o custo do `categoriaNaoFiscal`: **84 pares de 2+
sinais cortados em jan–jun, R$ 789.671,72** — documentos que existem, são lidos, e nunca
chegam ao pareamento, vários de força 3. O filtro não está errado por isso (ele existe para
tirar o papel que não é nota de fornecedor), mas o benefício declarado é um **limite
superior**: "não casaria" ≠ "não é documento", porque o PIX ao fornecedor pode não casar
simplesmente por o lançamento já ter casado com a nota.

#### §17.5 — O carnê que não era carnê (16/09)

`004.DOC-430000,00-PIX ENVIADO Macponta.pdf` virou **45 parcelas de R$ 6.798,65 do
DAYCOVAL**, espalhadas até 12.2029 sob o nome da MACPONTA. A IA achou um carnê anexado e
dividiu o documento errado.

O que distingue o caso ruim do carnê legítimo não é "valor do nome ≠ valor gravado" — em
consórcio o nome traz a parcela, e divergir é esperado. É a **soma**: no carnê legítimo a
parcela do nome é uma das gravadas; aqui o valor do nome não bate com nenhuma nem com o
total.

E o conserto expôs um defeito do upsert: a limpeza de parcelas só alcança o período em que
está gravando, e as 45 parcelas estavam em 45 períodos. Reprocessar só 04.2026 deixaria 44
sobras — mesmo defeito de `parcelas-pn-sobram-no-upsert`, por outra via. Daí
`_reprocessar-pix-macponta.js`, que **primeiro remove o PDF de todos os períodos**, depois
grava.

#### §17.6 — O commit de 17/09: releitura entrega, extração não

Ver a mensagem de `f5efa23`, que é detalhada. Em resumo: **748 documentos relidos com
`forceAI`, 0 erros**, cobertura de IA subindo de 12,2% para 69,5% em junho, e em nenhum mês
a releitura piorou linha que o parser local já tinha.

E **quatro variantes de extração de valor medidas, nenhuma implementada** — a linha
digitável como precedência global (o banco prometia +150, a releitura deu +1 em 68), duas
proteções do valor na linha 630, e o prompt conferir o valor contra a LD (0 ganhos, e mais
instável).

O defeito de `process-folder.js:630` **é real e está provado**: é a única sobrescrita
incondicional de `Valor total`, e apaga a linha digitável validada. Fica documentado e não
corrigido, porque os consertos medidos rendem ~1 caso e um deles perde em guia pública,
onde a LD diverge do pago por bom motivo.

A única mudança de código foi o interruptor `ANCORA_LOCAL` (`process-folder.js:38`),
**ligado** — desligar a âncora reprovou: **−7 em 1.700 documentos**, com junho sozinho
fazendo 0 ganhos e 8 perdas.

#### §17.7 — Duas pendências encerradas sem gastar nada (18/09)

Ambas estavam abertas há dias descrevendo problemas que **já não existiam**. As duas foram
fechadas com consultas ao banco, zero chamadas de API.

**A regressão de 03.2026 (§15.16) não está mais lá.** A releitura aconteceu entre 10 e
14/09 e ninguém fechou o item. Três verificações independentes:

1. o código tem as duas correções (`comparar-notas.js:504` e `:724-729`);
2. o travessão — o dano que só a releitura desfaz, porque foi GRAVADO — sumiu: março tem
   **0 em Emitente, 0 em Valor**, 5 em Número (0,1%), contra 2,5% em abril e 1,9% em junho.
   Março é o mês **mais limpo** dos seis;
3. a via voltou acima do patamar: `numero+entidade` por mês dá 01=262 · 02=248 ·
   **03=296** · 04=254 · 05=286 · 06=262. Março **lidera**. A regressão media 29 contra 41.

**A armadilha:** o `Emitente: "ARPESEG"` (erro de digitação da equipe) continua no banco de
março e parece o segundo sintoma. Não é — aparece igual em 01, 05 e 06/2026, que nunca
tiveram o bug, e é o comportamento intencional de `emitente-nao-vem-do-extrator`. **Escolher
o sintoma errado faz uma pendência parecer viva para sempre.** O sintoma tem de ser algo que
só a releitura desfaz; "número na chave errada" não serve, porque a correção do LEITOR o
curou sem tocar no banco.

**A variante "a visão não é sobreposta pela transcrição" tem teto de ganho ZERO.** A
medição estava pausada em 16/30 por viés de amostra, com plano de retomada escrito. A conta
de população respondeu antes de gastar API:

| | documentos | com linha digitável |
|---|---|---|
| PDF-texto | 4.537 | 1.189 (26,2%) |
| **PDF-imagem** | **306** | **8 (2,6%)** |

**Boleto chega como PDF de texto.** O que chega como imagem é recibo (162) e consórcio (92).
O cruzamento onde a variante agiria são 8 documentos em 4.843 — e **7 já estão certos**,
três deles gravando `Origem do valor pago = "linha digitável (corrigido)"`, o que prova que
a guarda de `_nf-visao.js:311` funciona em produção. O oitavo não tem gabarito legível no
nome.

De quebra, o diagnóstico anterior do viés estava errado: eu o atribuíra à marca `Valor lido
(não confere com o nome)`, e ela explica só 34 dos 306. Filtrar por ela — o plano de
retomada — teria produzido **outra rodada de inativos e outra conta de API**.

#### §17.8 — O método que estes cinco dias endureceram

Três reprovações vieram de tabelas que aprovavam, e duas pendências custaram dias por
descreverem dano morto. O que ficou:

1. **Dimensione o pool antes de medir.** Ganho possível = documentos que a variante toca −
   os que já estão certos. Se der ~0, não meça. Custa duas consultas; a medição custa API e
   horas.
2. **Inspecione os ganhos, um a um.** Média agregada aprovou a passada única e a IA×local;
   abrir os deltas reprovou as duas. Todo script novo de 15/09 em diante imprime os casos.
3. **Pergunte se a função roda no caminho de produção**, antes de medir a qualidade dela.
4. **Escolha um sintoma que só o conserto desfaz** — o que foi gravado, não o que a leitura
   corrige sozinha.
5. **Compare com os vizinhos.** 5 travessões em março pareceriam dano residual; ao lado de
   78 em abril, são ruído normal.

#### §17.9 — Pendências ao fim de 18/09/2026

1. **A escolha de valor de §16 continua sem ir ao banco.** O módulo decide na leitura; as
   linhas já gravadas seguem com a escolha antiga. O ganho medido (54% → 71%) segue sendo
   número, não dado. **É a pendência mais antiga ainda de pé** — desde 11/09.
   **Dimensionada em §17.14:** vale 1.306 linhas fiscais, não as 8.600 brutas.
2. **O defeito de `process-folder.js:630`** está provado e não corrigido, por decisão
   medida (§17.6).
3. **O filtro `categoriaNaoFiscal` custa 84 pares e R$ 789 mil** (§17.4) e nunca foi
   afinado regra a regra.
4. ~~`_efeito-visao-no-pareamento.js` não roda mais~~ — **consertado em §17.10**, e o
   conserto achou outra coisa.
5. **01, 02 e 03/2026 não foram relidos** com o código atual — 04, 05 e 06 foram, em 17/09.
   ~~§17.10 dá o primeiro motivo concreto para reler março~~ — **esse motivo foi atendido em
   §17.13 pela releitura dirigida**, sem reler mês nenhum.

#### §17.14 — O que falta, dimensionado (18/09)

Feito o balanço ao fim do dia, com números em vez de intuição. **O painel hoje: 3.057
lançamentos, 2.150 com documento (70,3%), 907 sem — R$ 4,69 milhões (23,2% do valor).**

**O buraco, por causa:**

| causa | n | valor | % |
|---|---|---|---|
| ESCOPO — não tem nota de fornecedor | 152 | R$ 2.583.819 | **54,0%** |
| SEM PAPEL — não existe no acervo | 550 | R$ 1.840.968 | 38,5% |
| MOTOR — papel existe com o mesmo valor | 235 | R$ 363.142 | **7,6%** |

**O motor responde por 7,6%, e quase todo ele é ilusório:** os candidatos da classe MOTOR
são fornecedor diferente com valor redondo igual (R$ 150 J M MEDARDO × LETICIA, R$ 100
BORRACHARIA × RIO DOCE). Casar isso PIORA a conferência — é a assinatura que reprovou a
passada única (§17.3) e que inflou três contas neste dia (§17.11, §17.12).

**Março é 46% do buraco e está explicado:** FOLHA DE PAGAMENTO (R$ 669.745) e MACPONTA
(R$ 660.000) são metade, e nenhum é defeito do sistema.

**Conclusão que orienta o que vem depois:** o trabalho técnico de extração e pareamento está
perto do teto. **54% do que falta não tem nota por natureza**, e o motor já recusa
corretamente quase tudo que sobra. O que resta com retorno real:

1. **Marcar o que o sistema não sabe.** O rótulo `emissaoDiverge` de §17.2 é o modelo:
   separa par bom de duvidoso (70,7% × 3,3%) sem casar nada. Transformar os 161 pares
   fracos em fila de conferência humana dirigida vale mais que inventar regra nova.
2. **A sequência de passadas** — mês antes de vizinha — já custou pares em DUAS medições
   independentes (§17.3 e a troca do BOM CLIMA em §17.13). É o defeito estrutural mais bem
   documentado ainda aberto. A passada única reprovou como está; o que falta é ordenar por
   força ANTES de fechar par, não fundir as passadas cegamente.
3. **Decisão de negócio, não técnica:** se folha, cartão, tributo e pessoa física saíssem da
   conta por definição, o painel iria de 70% para perto de 85% — e o número passaria a
   significar "falta papel" em vez de misturar isso com "nunca houve papel".

**Dimensionamento da pendência 1** (a escolha de valor de §16): 80,5% de precisão onde
`Origem do valor pago` existe contra **40,8% onde não existe** — a decisão funciona. Mas das
8.600 linhas sem ela que erram o valor, só **1.306 estão dentro da conferência**; 7.294 são
consórcio e financiamento que `categoriaNaoFiscal` filtra, e boa parte das 1.306 é `#pN`
(parcela de carnê), onde divergir do nome é esperado. **Releitura de escopo médio, ganho
incerto** — menos atraente do que o número bruto sugeria.

#### §17.10 — O script de efeito mentia, e ao consertá-lo março reabriu (18/09)

Eu tinha registrado que `_efeito-visao-no-pareamento.js` "não rodava por falta de cache".
**Estava errado em dois níveis**, e os dois valem mais que o conserto em si.

**Primeiro:** o cache existia. O script rodava.

**Segundo, o defeito real:** a linha `semDoc: r.lancamentosSemDocumento` lia o campo
errado. `conferirPeriodo` devolve dois campos parecidos e de tipos diferentes —
`lancamentosSemDocumento` é a **contagem** e `semDocumento` é a **lista**. O script
comparava a contagem consigo mesma e imprimia **"SEM DOCUMENTO 227 → 227, +0"** enquanto
os pares mudavam embaixo (214→211 no mês, 187→190 nas vizinhas).

**Isso é pior que quebrar.** Um script que falha manda consertá-lo; este terminava com
`+0` e cara de medição limpa — **exatamente no indicador que a pendência de 03.2026 mandava
conferir** ("deve mostrar perderam documento: 0"). Se alguém tivesse rodado em 10/09 para
validar a releitura, teria lido "nenhuma regressão".

Consertado, e com três defesas que o script não tinha:
- **invariante de tipo** — falha alto se `_pareamento` trocar contagem por lista de novo;
- **conferência cruzada** — o delta de "sem documento" tem de bater com `perdeu − ganhou`,
  dois caminhos independentes para o mesmo número. É o que teria denunciado o bug;
- **o cache saiu do scratchpad** para `_medir/.cache/ocr-antes.json`. O caminho anterior
  tinha um **ID de sessão de 10/09 embutido**; bastou a sessão acabar para o script
  depender de um arquivo que ninguém sabia recriar. E o guarda agora explica como tirar um
  retrato novo, e diz quando o script **não serve** (depois da releitura não há "antes").

**E aí o conserto achou o que a medição escondia.** Rodando de verdade: 7 lançamentos
ganharam documento, **7 perderam** — e três dos que perderam são as ARPSEG NF 530/531/534,
as mesmas de §15.16. O número está certo no banco e o documento está na pasta de março:

| NF | lançamento | documento | diferença |
|---|---|---|---|
| 530 | R$ 10.393,97 | R$ 10.034,63 | 3,46% |
| 531 | R$ 5.514,00 | R$ 5.323,37 | 3,46% |
| 534 | R$ 827,00 | R$ 798,41 | 3,46% |

**Percentual constante: é retenção na fonte** (§15). A planilha lança o BRUTO e o nome do
arquivo registra o LÍQUIDO. E os três documentos **não têm campo de retenção nenhum** —
nem `Valor do serviço`, nem ISS/PIS/COFINS. São NFS-e lidas pelo caminho da IA **antes do
conserto de §17.1**, quando esse caminho não chamava `parseNfse`.

Ou seja: a regressão de §15.16 está mesmo encerrada (a via de número voltou, §17.7), mas
**março tem um problema diferente, ainda aberto** — e o conserto dele já existe no código
desde 15/09. Falta reler. É o primeiro motivo concreto para a pendência 5, e diferente das
variantes reprovadas de 17/09: aqui não se inventa regra nova, só se aplica um parser que
já roda.

**A lição de método:** eu afirmei que o script estava quebrado sem rodá-lo — por dedução, a
partir de um caminho de arquivo que parecia morto. Rodar custou um comando. `sucesso-
silencioso-engana-vigilancia` e `o-erro-mora-onde-a-funcao-nao-roda` são a mesma família:
**um número plausível não prova que a função rodou, e "está quebrado" não se deduz do
código, se verifica executando.**

#### §17.11 — A conta de população da retenção: 12 pares, e o parser já os resolve (18/09)

Medida antes de decidir a releitura, como §17.8 manda.

**Lado 1 — a população.** NFS-e sem nenhum campo de retenção gravado:

| mês | NFS-e | com retenção | SEM |
|---|---|---|---|
| 01 | 81 | 40 | 41 |
| 02–06 | 437 | **0** | 437 |
| **total** | **525** | **40** | **485** |

Os 40 de janeiro vêm de uma releitura antiga. Fora deles, **nenhuma NFS-e do acervo tem
retenção gravada**.

**Lado 2 — quanto isso custa em pares.** Lançamento sem documento cujo valor bate com um
documento da pasta a menos de uma retenção plausível (0,5%–10%), exigindo 2º sinal. E aqui
a separação por via foi decisiva:

| critério | lançamentos | valor |
|---|---|---|
| qualquer sinal (número OU entidade) | 152 | R$ 492.195,83 |
| **só por NÚMERO** | **12** | **R$ 33.205,64** |

**A coluna larga é quase toda colisão** — CEMAVI × BOBIG, EVOLUTION × SAVANA, CLAYTON ×
SKILLHUB: fornecedores diferentes cujo valor casualmente cai na faixa de "uma retenção de
distância". Entidade + valor aproximado casa qualquer coisa. É a armadilha de §17.3 de novo,
e por pouco não reportei R$ 492 mil como oportunidade.

**Os 12 por número têm assinatura limpa:** ARPSEG a 3,27–3,52% e KUHNEN a 4,53% —
percentual estável por fornecedor, exatamente o que §15 descreve e o que reprovou adivinhar
alíquota.

**Lado 3 — a releitura entrega?** Rodei o `parseNfse` de hoje sobre os PDFs reais:

    Valor do serviço   10.393,97   ← o BRUTO que a planilha lança
    ISS retido            359,34   ← a diferença, ao centavo

**7 de 7.** Os campos estão no texto nativo e o parser já os lê — só não foram gravados,
porque estas linhas são anteriores a §17.1. **Não falta código: falta reler.**

**E um erro meu no caminho, que vale mais que o resultado.** Na primeira tentativa chamei
`pf.extractText`, que **não é exportada** por `process-folder.js`. `await undefined(...)`
caiu no `catch`, o script imprimiu **"⚠ SEM TEXTO NATIVO"** para os 7 PDFs, e eu quase
concluí que a releitura não resolveria — a conclusão oposta à verdadeira. Sete linhas
idênticas e plausíveis, produzidas por uma função que nunca rodou. A API correta é a classe
`PDFParse` (`process-folder.js:308`), e a regra que teria me salvado é a de sempre: **use a
mesma chamada que a produção usa, não uma parecida.**

#### §17.12 — "Só tem em março?" Não: todos os meses, e 7 fornecedores (18/09)

Pergunta do usuário depois de §17.11, e ela corrigiu o recorte — eu tinha medido março
como se fosse o caso.

**A população é uniforme.** NFS-e sem retenção gravada, por mês:

| mês | NFS-e | sem retenção | pares recuperáveis |
|---|---|---|---|
| 01 | 81 | 41 | 2 |
| 02 | 54 | **54** | 0 |
| 03 | 100 | **100** | 4 |
| 04 | 84 | **84** | 3 |
| 05 | 92 | **92** | 3 |
| 06 | 107 | **107** | 3 |
| **total** | **525** | **485** | **15** |

Março não é exceção — é o mês com mais NFS-e. Os 41 de janeiro com retenção vêm de uma
releitura antiga; nos outros cinco meses a cobertura é **zero**.

**A conta larga enganou pela terceira vez no dia.** Medindo pelo lado do documento, 236
NFS-e não casaram com lançamento nenhum, e 177 delas tinham um lançamento livre "a uma
retenção de distância" — R$ 640 mil. **Exigindo o número igual, caem para 8.** Os
descartados eram MAQNELSON 28172001 × AGRIPONTA 1591, TORNEARIA ZAFENATE 987 × NATALY 7:
fornecedores diferentes cujo valor casualmente cai na faixa de 0,5–10%.

É a terceira vez em um dia que "valor aproximado + sinal fraco" produz um número grande e
falso (§17.3 na passada única, §17.11 na retenção por entidade, agora esta). **A faixa
percentual não é evidência de nada sozinha** — ela só estreita candidatos, quem decide é o
número.

**Os 15 pares vêm de 7 fornecedores, e 10 deles de dois:**

| | pares | valor | alíquotas |
|---|---|---|---|
| ARPSEG | 7 | R$ 27.987,12 | 3,27 · 3,32 · 3,46 · 3,52% |
| KUHNEN E CHAVES | 3 | R$ 2.500,00 | 4,53 · 4,80% |
| outros 5 | 5 | R$ 11.538,52 | 1,57 – 8,17% |

A alíquota varia **dentro do mesmo fornecedor** (ARPSEG entre 3,27% e 3,52%, por mês) —
confirmação independente de por que §15 reprovou adivinhar alíquota: o ISS é municipal e a
base muda. Só ler o que a nota escreve funciona, e é o que `parseNfse` faz.

**O que isto muda na decisão:** a releitura não precisa ser do acervo inteiro nem de um mês
inteiro. **15 pares em 7 fornecedores** é escopo de releitura dirigida — as NFS-e desses
CNPJs, em seis meses. E como o mecanismo está provado (§17.11: o parser extrai em 7 de 7), o
risco é baixo. Ainda assim é ganho modesto: **R$ 42.025,64 em R$ 4,69 milhões sem
documento, ou 0,9% do buraco.**

#### §17.13 — A releitura executada, e o elo que faltava no índice (18/09)

Releitura dirigida dos 15, com `_medir/_reler-retencao.js` (novo): relê ANTES de tocar no
banco, backup do CSV de 17 períodos, e invariantes que abortam se o documento voltar sem
`Valor do serviço` ou se o `Valor total` deixar de ser o líquido. **15/15 gravados, 0 erros.**

**E o painel não mudou.** 2.147 pares antes, 2.147 depois.

O dado estava no banco — conferido linha a linha: `Valor do serviço 10.393,97`, `ISS retido
359,34`. `camposOcr` sobre esse mesmo JSON devolvia `retencao = {bruto, liquido, retido}`
corretamente. E `enriquecerComOcr` (`_pareamento.js:393`) já sabia usá-lo como valor de
casamento, com o líquido preservado em `valorAlt`.

**O elo quebrado estava no meio:** `contarNoCsv` monta o índice `ocrPorArquivo` copiando
campo a campo, e a lista era

    for (const k of ['numero', 'emitente', 'valor', 'dtEmissao'])

`retencao` **não estava nela**. O cálculo acontecia e o resultado era descartado na fusão.
O comentário de `CHAVES_VALOR` afirmava que "`retencaoDoParser` já põe o bruto em
`out.retencao` e `enriquecerComOcr` o usa" — descrevendo uma cadeia que nunca se completou.
Três peças certas, uma linha de ligação ausente, e **nenhum erro em lugar nenhum**: é
`o-erro-mora-onde-a-funcao-nao-roda` na sua forma mais silenciosa.

**Com `'retencao'` na lista, o A/B sobre os mesmos dados:**

| | A (hoje) | B (fix) | delta |
|---|---|---|---|
| pares | 2.148 | 2.151 | **+3** |
| força 3 | 1.473 | 1.487 | **+14** |
| força 2 | 515 | 503 | −12 |
| força 1 | 160 | 161 | +1 |
| perdas | — | — | **0** |

Os −12 de força 2 são **promoção**, não perda: viraram força 3. O ganho está na categoria
certa — 14 pares a mais com os três sinais concordando. Dos 15 alvos, **14 casaram** (o
JOÃO PAULO NF 1 casou por outra via, sem precisar da retenção; só o MARANHÃO ficou de fora,
e é um dos dois cuja nota não declara retenção).

**A ressalva honesta: 1 piora.** O lançamento BOM CLIMA de 01.2026 (R$ 1.040,00, NF 814)
casava em força 3 com `026.DOC- ... BOM CLIMA. NFS 814`, arquivado em 02.2026. Agora casa em
força 1 com `014.DOC- 988,00 ... TORNEARIA . NF 1001`, do próprio mês — porque o bruto da
TORNEARIA é **exatamente R$ 1.040,00**, o líquido do BOM CLIMA.

Não é defeito da retenção: é o **defeito de SEQUÊNCIA** que §17.3 já havia diagnosticado. A
passada do mês corrente roda antes da vizinha, então um par fraco do próprio mês fecha antes
de o par forte da pasta vizinha ser considerado. A retenção só criou mais uma oportunidade
para a colisão acontecer.

**Balanço: +3 pares, +14 de força 3, 0 perdas, 1 troca ruim.** Aplicado. A troca é conhecida
e tem causa identificada — e é a segunda evidência independente de que a sequência de
passadas custa pares, depois de §17.3.
