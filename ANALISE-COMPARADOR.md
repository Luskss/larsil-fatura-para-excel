# Análise do comparador de notas fiscais

Auditoria da lógica de comparação planilha Delsoft × pasta de PDFs.

- **Data:** 13/08/2026 (revisto em 14/08/2026 — ver "regra de corroboração")
- **Código auditado:** `routes/comparar-notas.js`, `conferencia-notas.html` (painel de comparação)
- **Base de medição:** `Consulta Delsoft.xlsx` — aba `Consulta1`, 118.811 linhas, períodos de 12/2022 a 06/2026
- **Consulta de referência:** Março/2026 (2.573 notas na planilha × 848 documentos na pasta)

Todos os números abaixo foram medidos rodando a lógica real contra esse arquivo, não estimados.

---

## Resumo

| # | Problema | Impacto | Status |
|---|---|---|---|
| 0 | Aba/cabeçalho fixos | Comparação retornava 0 notas sem erro | ✅ Corrigido |
| 1 | Match global sem janela de data | Casa a nota errada | ✅ Corrigido |
| 2 | `valorBate` aceita qualquer fração | Divergência de valor vira "OK" | ✅ Corrigido |
| 3 | `entidadeMatch` por substring | Casa empresas diferentes | ✅ Corrigido |
| 4 | Seção 6 não pontua candidatos | Escolha arbitrária | ✅ Corrigido |
| 5 | Casamento guloso por ordem | Resultado depende da ordem da planilha | ✅ Corrigido |
| 6 | Chave de agrupamento funde títulos | Apaga contas reais | ✅ Corrigido |
| 7 | `nfClean` assimétrico | 4,8% nunca casam por número | ✅ Corrigido |
| 8 | Modo "dias" vaza para o mês | Contas não fechavam | ✅ Corrigido (ver ressalva) |
| 9 | `norm()` não remove acentos | Falha em 41 entidades | ✅ Corrigido |
| 10 | 59,6% das linhas CP descartadas | Cobertura | 🟡 Confirmar |
| 11 | Validação de tipo desligada na maior categoria | Cobertura | 🟡 Confirmar |
| 12 | Card "Divergentes" subtrai duas vezes | Número errado na tela | ✅ Corrigido |
| 13 | Cards não fecham | Número errado na tela | ✅ Corrigido |
| 14 | Parâmetro morto em `tipoBate` | Cosmético | ✅ Corrigido |

### Março/2026 — antes e depois das correções

O "antes" abaixo é um baseline **reconstruído e validado** (`git HEAD` + apenas o item 0),
que reproduz exatamente os 7 números medidos nesta auditoria. Ver
[PROGRESSO-COMPARADOR.md](PROGRESSO-COMPARADOR.md) para a receita e a medição completa.

> Números do escopo **anterior** à exclusão de `DESPESAS BANCARIAS`
> ([PROGRESSO §9.1](PROGRESSO-COMPARADOR.md)): "Na planilha" em Março é **2.403** hoje, e
> "faltando na pasta" é 2.200 (das quais 738 são fiscais). O pareamento não muda — as
> notas excluídas tinham cobertura zero.

| | Antes (só item 0) | Depois |
|---|---|---|
| Na planilha | 2.573 | 2.586 |
| Encontradas | 493 | 491 |
| Divergentes | 120 | 129 |
| Faltando na planilha | 269 | — |
| Impostos | 86 | 86 |

Comparando **pareamento a pareamento** (documento da pasta → nota da planilha), e não só
totais: 489 pares idênticos, **0 reatribuições**, 4 perdas e 2 ganhos. As 4 perdas estão
justificadas uma a uma no documento de progresso (razão de parcela não inteira e conta
recorrente casando com o mês errado).

Nos 8 períodos medidos: **47 perdas, 12 ganhos, 10 reatribuições** em 2.972 documentos
casados no baseline.

Os cards fecham por `totalPlanilha = encontradasPlanilha + naoEncontradas`, verificado em
8 períodos. Nenhuma nota aparece nas duas listas — era possível antes, porque a seção 6
casava notas que a seção 5 já tinha empurrado para "faltando na pasta" e só as
consolidadas voltavam.

> Atenção: `encontradas = encontradasPlanilha + outroMesBanco` **não** é identidade — uma
> fatura consolidada é 1 documento cobrindo várias notas.

**Números por período e itens ainda em aberto:** ver
[PROGRESSO-COMPARADOR.md](PROGRESSO-COMPARADOR.md).

---

## 0. ✅ Corrigido — aba e linha do cabeçalho fixos

`lerPlanilhaIndexada()` assumia `wb.Sheets[wb.SheetNames[0]]` e `header = rows[1]`.

Na `Consulta Delsoft.xlsx` a 1ª aba é uma tabela dinâmica (`Din. Rec. Gerencial`) e os dados
estão em `Consulta1`, com um bloco de legenda ("Mapa Colunas") ocupando as linhas 1–22 e o
cabeçalho real na linha 23. Resultado: todos os `indexOf` retornavam −1, `row[-1]` era
`undefined`, o filtro `ORIG === 'CP'` descartava as 118.811 linhas — e a API respondia
`success: true` com `totalPlanilha: 0`. Todo PDF da pasta caía em "faltando na planilha".

**Correção aplicada:**

- `acharCabecalho()` (`routes/comparar-notas.js:249-280`) varre todas as abas e as primeiras
  200 linhas de cada, procurando a linha que contenha `ORIG, NF, ENTIDADE, VL_TOTAL_CAB`.
  Comparação normalizada por `norm()`, tolerante a caixa e espaços.
- Loop de dados passa a começar em `headerRow + 1` (`:318`).
- Se o cabeçalho for encontrado mas nenhum lançamento `ORIG='CP'` sair, lança erro explícito
  em vez de devolver zero calado (`:397-405`).

**Verificado em três cenários:**

| Cenário | Resultado |
|---|---|
| `Consulta Delsoft.xlsx` | detecta `Consulta1`, cabeçalho linha 23 → 2.573 notas em Março/2026 |
| Formato antigo (1ª aba, cabeçalho linha 2) | continua funcionando |
| Planilha sem as colunas | HTTP 500 nomeando colunas faltantes e abas verificadas |

**Março/2026, antes → depois:**

| | Antes | Depois |
|---|---|---|
| Na planilha | 0 | 2.573 |
| Encontradas | 0 | 493 |
| Divergentes | 0 | 120 |
| Datas divergentes | 0 | 21 |
| Faltando na pasta | 0 | 2.381 |
| Faltando na planilha | 743 | 269 |
| Impostos | 105 | 86 |

> **Nota sobre "faltando na pasta: 2.383"** — confirmado em 14/08/2026: **não é defeito**, e a
> explicação que estava aqui antes ("o relatório parece cobrir só parte do mês") está **errada**.
> A distribuição por dia do lançamento mostra notas casadas e não casadas em *todos* os dias,
> com cobertura entre 12% e 25% — não existe janela de dias faltando. Ver §8 do
> [PROGRESSO-COMPARADOR.md](PROGRESSO-COMPARADOR.md) para a medição.

---

## 🔴 Fazem a comparação casar a nota ERRADA

### 1. Match global sem janela de data

`routes/comparar-notas.js:1019`, `:1062`

`planilhaPorNF` e `planilhaPorVal` indexam a planilha **inteira** (12/2022 → 06/2026). A seção 6
consulta esses índices sem nenhuma restrição de período.

Medido:

- **531** números de NF aparecem em mais de um período (de 11.623 distintos). A NF `15` existe em
  5 meses; a `17`, em 5.
- **761** pares (entidade, valor) se repetem em meses diferentes — contas recorrentes de valor
  fixo: EVOLUTIZE R$ 2.171,87 em 6 meses seguidos, FLORSIL R$ 399,00 em 6, ASSOCIAÇÃO COMERCIAL
  R$ 176,74 em 4.
- **288 das 493 encontradas em Março/2026 (58%) vieram por `nf-global`** — ou seja, a maioria dos
  acertos hoje depende justamente do caminho mais frouxo.

### 2. `valorBate` aceita quase qualquer fração como "parcela Nx"

`routes/comparar-notas.js:151` (bloco de parcelas em `:161-176`)

Com `MAX_PARCELAS = 24` e tolerância `n * 0.015`, qualquer valor próximo de `total / N` é aceito
como parcela. Testado com uma nota de planilha de R$ 24.000,00:

| Valor na pasta | Veredito |
|---|---|
| R$ 1.000,00 | ✅ ok — "parcela 24x" |
| R$ 2.000,00 | ✅ ok — "parcela 12x" |
| R$ 8.000,00 | ✅ ok — "parcela 3x" |
| R$ 999,99 | ✅ ok — "parcela 24x" |

Divergência real de valor vira "OK". A função não verifica se o documento é de fato parcelado,
apesar de `parser['Parcela']` já ser lido em `:641`.

### 3. `entidadeMatch` casa empresas diferentes

`routes/comparar-notas.js:92`

A regra `na.includes(wb) || nb.includes(wa)` sobre as 3 primeiras palavras, somada ao `includes`
do núcleo, produz nas 2.283 entidades da base:

- `COMPANHIA DE SANEAMENTO BASICO SP` ↔ `COMPANHIA DE SANEAMENTO DE MINAS GERAIS` (SABESP ↔ COPASA)
- `ELEKTRO REDES S.A. 02.328.280/0001-97` ↔ `...0002-78` — filiais distintas tratadas como a mesma
- `COMERCIO DE PECAS PARALELO -PR` casa com VALFOR, BUENO e BOBIG (todas colidem entre si)

Agrava o item 1: este é exatamente o *guard* que deveria conter os falsos positivos do match
global, e é frouxo demais para o papel.

### 4. Seção 6 não pontua os candidatos

`routes/comparar-notas.js:1019`

```js
if (cands.length) { naPlanilha = cands[0]; break; }
```

Pega o primeiro na ordem da planilha. A seção 5 (`:952-958`) faz o correto, pontuando valor + tipo.
O mesmo documento casa de forma diferente conforme o lado que o encontrou primeiro.

### 5. Casamento guloso, dependente da ordem

`routes/comparar-notas.js:910-963`

Cada linha do banco é consumida pela primeira nota que a reivindica (`usadasBanco`), sem
reatribuição posterior. Se uma nota seguinte seria um match melhor, ela perde. Reordenar as
linhas do export Delsoft muda o resultado da conferência.

---

## 🟠 Fazem a comparação PERDER notas

### 6. Chave `periodo|nf|ent` funde títulos distintos

`routes/comparar-notas.js:346`

Quando duas linhas compartilham a chave, só o `VL_ITEM` acumula — o `VL_TOTAL_CAB` da segunda é
**descartado**. São **61 notas** afetadas:

| Chave | Valores fundidos |
|---|---|
| `06.2026 \| 219736 \| SANESUL` | R$ 172,16 **e** R$ 168,63 |
| `06.2026 \| 112061 \| TICKET SERVICOS` | R$ 300,00 **e** R$ 400,00 |
| `12.2025 \| 101710 \| SANCOR SEGUROS` | R$ 6.400,00 **e** R$ 12.900,00 |
| `06.2026 \| 2406-01 \| ERICLEIA F. D. SILVA` | R$ 476.500,51 **e** R$ 1.000.000,00 |

A segunda conta desaparece da conferência e o PDF correspondente cai em "faltando na planilha".

### 7. `nfClean` assimétrico entre os dois lados

`routes/comparar-notas.js:360` (planilha) × `:520` (banco)

A planilha preserva pontuação; o lado banco faz `replace(/\D/g, '')`.

| NF na planilha | `nfClean` gerado | O banco procura por |
|---|---|---|
| `2026.02.01` | `2026.02.01` | `20260201` |
| `26.01SIND` | `26.01SIND` | `2601` |
| `25.12difpr` | `25.12difpr` | `2512` |

**566 notas (4,4%)** nunca casam por número, por construção.

### 8. Modo "dias" vaza para o mês inteiro

`routes/comparar-notas.js:815`, `:1027`, `:1062`

`notasPlanilha` é filtrado por dia em `:711-717`, mas três caminhos (`acharConsolidacao`, fallback
por data, recuperação por valor+emitente) usam `porPeriodo.get(periodo)` — o mês cheio — e marcam
essas notas em `planilhaUsada`/`consolidadas`. Notas de dias que não foram pedidos são consumidas
e somem do relatório.

### 9. `norm()` não remove acentos

`routes/comparar-notas.js:17`

**489** entidades da planilha têm acento, e o emitente do lado banco vem da IA/PDF. `COMÉRCIO` ≠
`COMERCIO`, e `nucleoEntidade()` também não remove o token acentuado. Mesmo efeito no filtro de
cartão (`:231`): `/\bCAR(TAO)?\s*CRED/` não pega `CARTÃO CRED`.

---

## 🟡 Cobertura / escopo — confirmar se é intencional

### 10. 59,6% das linhas CP são descartadas

`routes/comparar-notas.js:226`

**55.585 de 93.281** linhas `ORIG=CP` caem no filtro de cartão de crédito. Detalhe: as regras por
NF (`/^CC\d/` e `/^CR[.\s]/`) casam **0 linhas** neste export — 100% dos descartes vêm da regra de
ENTIDADE. Cada compra no cartão traz `CARTAO CRED 1883/9940 V.14 SANT RODRIGO` no lugar do
fornecedor real, então nenhuma delas é conferível.

### 11. Validação de tipo desligada na maior categoria

`routes/comparar-notas.js:218`

`RECIBO E OUTROS` mapeia para `'*'` (aceita qualquer tipo) e são **15.758 linhas** — a categoria
mais frequente, à frente de `NOTA FISCAL RFB` (4.982) e `NOTA FISCAL SERVICO` (3.886). Na prática
`tipoBate()` quase nunca reprova.

Distribuição completa dos TIPOs em `ORIG=CP`:

| TIPO | Linhas | Mapeamento |
|---|---|---|
| RECIBO E OUTROS | 15.758 | `*` (aceita tudo) |
| NOTA FISCAL RFB | 4.982 | `NF` |
| NOTA FISCAL SERVICO | 3.886 | `NFS` |
| IMPOSTO | 3.496 | ignorado |
| PREVISAO | 2.368 | ignorado |
| FINANC CAMINHOES | 1.629 | — (sem validação) |
| FATURA | 1.581 | `FATURA` |
| DESPESAS BANCARIAS | 1.006 | — (sem validação) |

---

## 🔵 Números errados na tela

### 12. Card "Divergentes" subtrai duas vezes

`conferencia-notas.html:2359`

```js
{ label: 'Divergentes', val: resumo.divergentes - alertasFalsos.size, ... }
```

O servidor **já** exclui os alertas falsos em `routes/comparar-notas.js:1222`
(`&& !n.alertaFalso`), e o cliente popula `alertasFalsos` a partir dessas mesmas flags
(`conferencia-notas.html:2288-2297`). Além disso `alertasFalsos` inclui itens `data-divergente`,
que nunca entraram em `resumo.divergentes`. O card subconta e **pode ficar negativo**.

### 13. Cards não fecham — **corrigido em 14/08/2026**

`totalPlanilha` conta apenas o mês consultado, mas `encontradas` inclui notas casadas em outros
meses pela seção 6. "Encontradas" pode ultrapassar "Na planilha", e
`encontradas + naoEncontradas ≠ totalPlanilha`.

> Diagnóstico completo em **§12 do progresso**. A contagem estava certa; o card é que somava
> duas unidades — `Encontradas` conta DOCUMENTO, `Na planilha`/`Faltando na pasta` contam
> LANÇAMENTO. Em 03/2026, 288 dos 491 documentos (59%) casam com linha de outro mês, e esse
> percentual é estável nos 6 períodos (56–62%).
>
> Três correções: (a) **seção 6b** procura o documento nas pastas `[-1,+1,+2]` antes de
> declarar a linha ausente — 170 das 738 "faltando" fiscais de Março estavam arquivadas na
> pasta de Abril; (b) lançamentos de cartão passaram a ser contados (`resumo.cartoes`) — eram
> descartados em silêncio e faziam o lado pasta não fechar por 1-2 docs em 5 dos 6 meses;
> (c) cards reorganizados em blocos por unidade, com a identidade impressa embaixo.
> As duas identidades fecham nos 6 períodos.

### 14. Parâmetro morto

`tipoBate(tipoBanco, nota, rowB)` (`:184`) recebe `rowB` e nunca o usa. Cosmético.

---

## O que foi aplicado (13/08/2026)

**1 — janela de data proporcional à evidência.** A primeira tentativa foi um corte duro
de ±2 meses; ela derrubou 64 casamentos e a inspeção mostrou que quase todos eram
**parcelas legítimas**: mesma NF, mesmo fornecedor, valor = fração exata do total, nota
lançada meses antes (NF 266 da ADS DISTRIBUIDORA — planilha R$ 11.502,13 em 11/2025,
boleto de Março R$ 1.150,21, exatamente 1/10). Corte por data pura é a métrica errada.
A regra: até 2 meses passa direto; além disso, o valor tem que corroborar. Isso corta a
`FT7900` do BANCO SANTANDER, que casava a 33 meses de distância com R$ 1.377.307,85 na
planilha × R$ 52.610,67 na pasta. A recuperação por valor+emitente, que não tem número
nenhum para se apoiar, ficou em ±1 mês.

**1b — o que "corroborar" exige (revisto em 14/08/2026).** A primeira versão exigia os
**três** sinais — número, entidade e valor. Medindo 6 períodos, a exigência de *entidade*
custava 42 casamentos, quase todos parcelas exatas (3x, 4x, 7x, 11x, 12x): em boleto de
parcela o emitente sistematicamente não é o fornecedor (`RM SECURITIZADORA` pela CIMAG,
`APOLICE BRADESCO`, o nome fantasia `CAMPNEUS`, `FLORESTC` digitado errado). Mas soltar a
entidade e aceitar qualquer `valorBate` traz a `FT7900` de volta — porque `valorBate`
também aprova quando o valor bate com **um item individual** da nota, e numa nota de
R$ 1,37 milhão isso confirma quase qualquer coisa.

A regra final: sem acordo de entidade, o valor só corrobora se o documento se explicar
como total ou como **parcela plausível** — razão `total ÷ valor` perto de um inteiro,
com N ≤ `MAX_PARCELAS`. Testei tratar "casou com um `VL_ITEM` individual" como evidência
fraca e **não funciona**: a parcela legítima está gravada justamente assim (os R$ 7.300,01
da CIMAG são um `VL_ITEM` de uma nota de R$ 21.900). O que separa o falso positivo é a
escala, não o caminho — SANTANDER tem razão 26,18 e FIG `499851` tem 10,97, nenhuma
fecha como número de parcelas.

| variante | encontradas (6 meses) | perdas vs baseline | casamentos inéditos | `FT7900` |
|---|---|---|---|---|
| exige entidade | 2.787 | 78 | 16 | cortado |
| só `valorBate.ok` | 2.826 | **36** | 13 | ⚠ **volta**, a 31 meses |
| **entidade ou parcela plausível** | 2.818 | 43 | **12** | cortado |
| plausível sempre, sem entidade | 2.802 | 57 | 10 | cortado |
| plausível sempre + entidade | 2.771 | 92 | 14 | cortado |

A escolhida perde menos que a original **e** produz menos casamentos inéditos que todas as
outras exceto uma — e essa uma ("plausível sempre") custa 14 casamentos para cortar 2, um
dos quais é a `FT567.683` da RANDON **ADMINISTRADORA DE CONSÓRCIO**, razão 29,002: parcela
de consórcio legítima, barrada só porque `MAX_PARCELAS = 24`.

**2 — fração de parcela exige evidência.** `valorBate` agora recebe o doc do banco e só
aceita `total ÷ N` sem ressalva quando o documento se declara parcelado (campo `Parcela`
do parser ou sufixo `#pN`); quando o parser informa "1/12", só testa N=12. Sem evidência,
a fração ainda casa — para não jogar a nota em "faltando" — mas volta marcada `fraco` e
vira alerta `⚠ Valor não confere direto … conferir` em vez de "OK". São 13 divergências
reais que antes passavam caladas.

**3 — entidade por contenção de tokens + raridade.** Substituída a comparação por prefixo
de 3 palavras. Duas entidades casam quando o conjunto de tokens de uma contém o da outra
**e** o conjunto menor tem ao menos um token discriminante — que aparece em no máximo 2
entidades distintas da base (frequência medida na própria planilha, em
`indexarCorpusEntidades`). Sem o teste de raridade, contenção pura casava por sobrenome
("H J DE OLIVEIRA PEDROZO RESTAURANTE" ~ "R. P. OLIVEIRA") ou pelo ramo ("RESTAURANTE E
LANCHONETE PRATAO" ~ "LANCHONETE E RESTAURANTE J & E") — 756 pares novos, pior que a
regra antiga. Com ele: **332 → 69 pares** entre as 2.283 entidades, 263 colisões
eliminadas. Afrouxar o limiar para 3 devolveria DETRAN PR ↔ MG ↔ GO e LEAL BOMBAS
HIDRAULICAS ↔ A. F. LEAL — 15 pares errados para 6 certos.

**4 — seção 6 pontua.** Junta os candidatos de todas as chaves antes de escolher e usa a
mesma função de score da seção 5 (`scoreCandidato`), desempatando pelo período mais
próximo. Os dois lados agora decidem pelo mesmo critério.

**5 — duas passadas.** A primeira fecha só os casamentos indiscutíveis (número + valor +
tipo + entidade confirmando), a segunda distribui o resto, para que um match fraco não
consuma o documento de quem tinha direito a ele. Ressalva honesta: embaralhando as notas
da planilha com 3 sementes diferentes, **o pareamento de Março/2026 não muda nem com nem
sem a correção** — o modo de falha existe no código, mas não se manifesta neste mês.

**6 — `VL_TOTAL_CAB` na chave de agrupamento.** Os itens de uma mesma nota repetem o total
do cabeçalho e continuam agrupando; títulos distintos com mesma NF+entidade+período
passam a ser notas separadas. **+13 notas** em Março (72 em toda a base).

**7 — chave de NF simétrica.** `nfSomenteDigitos()` é aplicada aos dois lados como chave
adicional (mínimo 3 dígitos, para não indexar por "1"/"12"). 623 notas da base (4,8%)
ganharam a chave que faltava. Em Março/2026 isso não mudou nenhum número — é correção
estrutural, não ganho medido neste mês.

**8 — contabilidade do modo "dias".** A causa real não era o alcance das buscas e sim
`naoEncontradas` guardar **cópias** das notas, nunca reconciliadas com o que a seção 6
casava depois. Corrigido guardando referências e filtrando por `planilhaUsada` no fim.
Restringir os fallbacks aos dias pedidos foi testado e **revertido**: derrubava a
conferência de um dia de 46 casamentos para 2, porque o PDF é arquivado na data em que
chega e a planilha lança na data do pagamento — dia 5 casa com dia 6 o tempo todo. Com a
contabilidade correta, casar fora do escopo não desequilibra nada.

**9 — `deacc`/`normCmp`.** Acento removido em toda **comparação**, nunca no que é
armazenado: `norm()` continua alimentando `nota.entidade`, que é chave de alertas-falsos e
vínculos já persistidos no banco e é o que aparece na tela. Corrige também o filtro de
cartão, que não pegava "CARTÃO CRED".

**9b — regressão do próprio item 9, achada em 14/08/2026.** `tipoBate()` tinha a guarda
`tb === 'NÃO IDENTIFICADO'` para não inventar divergência quando a IA não classifica o
documento. Como `tb` passou a vir de `normCmp()` — que aplica `deacc()` —, o valor real é
`NAO IDENTIFICADO` e a guarda **parou de disparar**: todo documento não classificado virava
`⚠ Tipo: banco Não identificado × planilha NOTA FISCAL SERVICO`. Comparação corrigida para
a forma sem acento; elimina 3 divergências falsas em 06/2026 e 1 em 05/2026.

**12 e 13 — cards.** Removida a subtração dupla de `alertasFalsos.size` (o servidor já
exclui os alertas falsos, e o `Map` do cliente inclui itens `data-divergente` que nunca
entraram na conta — o card podia ficar negativo). Adicionado `encontradasPlanilha` ao
resumo, que é o número que fecha com "Na planilha"; os dois cards têm `title` explicando
a decomposição.

### Ainda em aberto

**Pontos novos levantados pela medição de 14/08/2026** (detalhe em
[PROGRESSO-COMPARADOR.md](PROGRESSO-COMPARADOR.md) §6.4–6.6): `MAX_PARCELAS = 24` é baixo
para consórcio (RANDON, 29x); um casamento inédito de razão 125 a 71 meses de distância
passa só porque a entidade bate, o que sugere um limite duro de distância; e 3 perdas por
valor+emitente a 1 mês de distância deveriam ter passado pela janela de ±1 mês.

**Itens 10 e 11** — decisão de negócio, não mexi: 55.585 linhas de cartão de crédito
descartadas (a entidade traz `CARTAO CRED …` no lugar do fornecedor, então não são
conferíveis mesmo) e `RECIBO E OUTROS → '*'`, que desliga a validação de tipo nas 15.758
linhas da maior categoria. Ambas continuam como estavam.

**Filiais.** `ELEKTRO … 0001-97` e `… 0002-78` continuam casando entre si. Não mexi de
propósito: separá-las exigiria deixar o CNPJ **rejeitar** um match, e o código documenta
que o CNPJ do lado banco é ruidoso demais para isso (filiais, OCR, e a IA às vezes grava
o CNPJ do pagador) — hoje ele só adiciona casamentos, nunca remove.

---

## Como reproduzir as medições

As contagens vieram de scripts que replicam `lerPlanilhaIndexada()` sobre a planilha real, e de
chamadas diretas à rota com `req`/`res` stubbados (`requireAuth` só exige
`req.session.cf_loggedIn`). Esqueleto:

```js
require('./config.js');
const rota = require('./routes/comparar-notas.js');
const req = { method: 'POST', session: { cf_loggedIn: true },
              body: { mes: 3, ano: 2026, dias: [] } };
let out; const res = { set: () => res, status: () => res, json(o) { out = o; return res; } };
await rota(req, res);
```
