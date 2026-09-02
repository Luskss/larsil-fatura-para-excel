# Tipos ignorados na Comparação com Planilha Delsoft

Documenta tudo que é excluído das três contagens do painel "Comparação com Planilha
Delsoft" (pasta / banco / planilha), por quê, e onde está no código. Números de
exemplo são de março/2026.

Fonte: [`routes/comparar-notas.js`](routes/comparar-notas.js).

---

## 0. Como cada fonte decide "o mês"

Antes de qualquer exclusão, as três fontes precisam concordar em que "março/2026"
significa a mesma coisa. Desde 25/08/2026 as três usam o MESMO critério — a data
real do documento, nunca um campo de controle de quando algo foi processado:

| Fonte | Como decide o mês |
|---|---|
| **Pasta** | Data no NOME do arquivo (`YYYY.MM.DD` ou `DD.MM.YYYY`); se não achar, a subpasta |
| **Banco** | Mesma regra da pasta, recalculada a partir do nome gravado no relatório do OCR |
| **Planilha** | `DT_LANCAMENTO` (data do pagamento); `DT_EMISSAO` como reserva |

Antes da correção do item 6.1, o banco usava o campo `PERIODO` da tabela SQL, que
é gravado pelo scheduler no momento em que ele PROCESSOU o arquivo — não a data do
documento. Isso fazia o card "Salvos no banco" incluir documentos de outros meses
e excluir documentos de março gravados sob outro período. Ver item 6.1 para os
números medidos.

---

## 1. Escopo aplicado ANTES de qualquer exclusão (planilha)

Antes de excluir nada, a planilha já é restrita a:

- **ORIG ∈ {NF_ENTRADA, LMCP, TAXA}** — as demais origens (CP, CR, OC, LMCR,
  TRANSF-REC, TRANSF-PAG, ADI, NF_Saída-Serv) não entram na contagem.
- **FILIAL = LARSIL** — as demais filiais (FLORSIL, ALR TRANSPORTES, ALR FLORESTAL,
  S5 FLORESTAL, MS AGROPECUARIA, ERICLEIA, S&D ADM, S&D LOCADORA, S&D TRANSPORTES,
  PLANTSIL, PIGUARÁ) não entram.

Isso não é "ignorado" no sentido deste documento — é o universo de onde as
exclusões abaixo são tiradas. Em março/2026: 27.977 linhas no mês → 2.430 dentro
desse escopo.

---

## 2. Excluídos por CONTA CONTÁBIL (`CONTAS_SEM_DOCUMENTO`)

**Onde:** `comparar-notas.js`, constante `CONTAS_SEM_DOCUMENTO` (linha ~229).

Lançamentos cuja `CONTA_C` é folha, benefício, encargo ou tarifa bancária. Esses
nunca têm nota fiscal de fornecedor para arquivar — são movimentação interna ou
paga em lote, não compra. Cortados **antes** da deduplicação, para não inflar o
número de "lançamentos que deveriam ter documento".

| Conta | Março/2026 | O que é |
|---|---:|---|
| VALE REFEICAO | 757 | Reembolso individual em restaurante/padaria/mercado |
| DESPESAS BANCARIAS | 65 | Tarifa de conta corrente |
| FGTS | 17 | Encargo trabalhista |
| SALARIOS | 16 | Folha de pagamento |
| RENIMENTO S/ APLIC FINANCEIRAS | 13 | Receita financeira, não compra |
| JUROS PAGOS | 4 | Encargo financeiro |
| FERIAS + 1/3 | 4 | Folha de pagamento |
| BOLSA ESTAGIO | 2 | Folha de pagamento |
| VALE TRANSPORTE | 1 | Benefício |
| CESTA ALIMENTACAO | 1 | Benefício |
| JUROS A PAGAR | 1 | Encargo financeiro |
| ISSQN | 1 | Imposto retido |
| **Total excluído** | **888** | |

Lista completa de contas na constante (algumas sem ocorrência em março, mas
cortadas em outros meses): CESTA ALIMENTACAO, VALE TRANSPORTE, BENEFICIOS,
SALARIOS, FERIAS + 1/3, 13º SALARIO, BOLSA ESTAGIO, FGTS, INSS, INSS A RECUPERAR,
ISSQN, INDENIZACOES TRABALHISTAS, RECLAMATORIA TRABALHISTA, DESPESAS BANCARIAS,
IOF, JUROS PAGOS, JUROS A PAGAR, DISTRIBUICAO DE LUCROS, CAPITAL SOCIAL,
DEPRECIACAO E AMORTIZACAO, RENIMENTO S/ APLIC FINANCEIRAS.

**Por que pela conta e não pelo TIPO:** o código já cortou por `TIPO='RECIBO'` no
passado, mas isso também descartava contas que **têm** nota — água, aluguel,
manutenção lançadas como recibo. A conta contábil (quem classifica é a própria
contabilidade) separa melhor: em 6 meses de 2026, VALE REFEICAO tem 0,7% de
cobertura documental contra 38,7% de ALUGUEIS e 41,0% de TELEFONE — por isso essas
últimas **ficam dentro** mesmo sendo lançadas como recibo.

---

## 3. Excluídos por lançamento INFORMATIVO

**Onde:** `comparar-notas.js`, função `ehInformativo` (linha ~244).

Entidade começando com `*` (ex.: `*P.R.B INFORMATIVO`, `*INF. JUROS INFORMATIVO`,
`*DEPRECIACAO`). É a própria contabilidade marcando que não é pagamento a
fornecedor — geralmente um lançamento de contrapartida ou nota contábil.

Baixo volume (4 em março, 64 em 6 meses de 2026), mas valores altos (R$ 81
milhões em 6 meses) — por isso importa excluir mesmo sendo poucos registros.

---

## 4. Duplicação por NF+ENTIDADE repetida (não é exclusão, é deduplicação)

**Onde:** `comparar-notas.js`, chave `vistos` (linha ~304).

Uma nota com vários itens ocupa várias linhas na planilha, todas com o mesmo
cabeçalho (mesma NF, mesma ENTIDADE). A chave de agrupamento é `NF+ENTIDADE`
(sem o valor): a 2ª, 3ª... linha da mesma nota não conta como um lançamento novo.

Verificado em março/2026: 1.426 linhas na base comparável → 639 chaves distintas
(a diferença são as linhas repetidas da mesma nota). Confirmado que a chave não
colapsa lançamentos diferentes: acrescentar o valor à chave dá exatamente o mesmo
número de grupos.

---

## 5. Excluídos do lado da PASTA (arquivos no disco)

**Onde:** `comparar-notas.js`, `RE_DOC` / `ehDoc` (linha ~32) e `contarNaPasta`
(linha ~73).

### 5.1. Já implementado: arquivos que não são "NNN.DOC"

Só conta PDFs cujo nome começa com um número seguido de `.DOC` (ex.:
`001.DOC- 75,56...pdf`). A pasta também guarda, e ignora:

- **`NNN.CPV.pdf`** — comprovante de pagamento do boleto (não é a nota em si)
- **`000.pdf`** — extrato do dia
- outros anexos que não seguem o padrão `NNN.DOC`

### 5.2. PDFs "NNN.DOC" que não são nota fiscal

**Onde:** `comparar-notas.js`, `PADROES_NAO_FISCAL` / `categoriaNaoFiscal`
(linha ~35), aplicado dentro de `contarNaPasta`.

Investigado em 25/08/2026 e implementado no mesmo dia: dos 896 PDFs "NNN.DOC" de
março/2026, 259 são pagamentos que nunca têm NF de fornecedor — o mesmo tipo de
problema do item 2, só que do lado da pasta. Eles são detectados por padrão no
NOME do arquivo e saem do card "PDFs na pasta" (ficam em `naoFiscal` /
`naoFiscalPorCategoria`, visíveis no tooltip).

| Padrão no nome do arquivo | Março/2026 | O que é |
|---|---:|---|
| `Grupo NNNN... Cota NNN` | 190 | Parcela de consórcio — não tem NF, é cota |
| `PAGTO FINANC VEIC`, `CDC VEICULOS/MAQUINAS` | 26 | Financiamento de veículo/máquina |
| `PIX ENVIADO`/`PIX RECEBIDO` | 10 | Transferência, sem NF associada |
| `GIRO CAIXA`, `GIRO PEAC`, `CRED ESP`, `PARC FLUTUANTE` | 9 | Crédito/giro empresarial |
| `FGTS` no nome | 8 | Encargo trabalhista |
| `DETRAN`, `MINISTERIO DA JUSTICA` | 4 | Taxa de governo |
| `EMPRESTIMO`, `DAYCOVAL` | 3 | Empréstimo |
| `SALARIO`, `FERIAS` | 3 | Folha de pagamento |
| `RCB 9039xx`/`9049xx` | 2 | Guia de governo (tributo, tem aba própria) |
| `ISS RETIDO`, `pgto VA`, `SISPAG`, outro financiamento | 4 | Diversos, sem NF |
| **Total identificado** | **259** | |

Depois de tirar esses 259: **896 − 259 = 637**, contra **639** na planilha (depois
de todos os cortes acima) — diferença de **2**, dentro do ruído esperado de uma
heurística por nome de arquivo. Confirmado após a implementação: `contarNaPasta`
devolve exatamente 637 fiscal + 259 não-fiscal = 896, sem perder nenhum arquivo.

**Conclusão da investigação:** a pasta e a planilha já batem quase exatamente. O
"buraco" aparente de ~257 (896 vs 639, antes deste corte) não era documento
faltando — era a pasta contando parcela de consórcio, financiamento e PIX junto
com nota fiscal, coisas que a planilha já não conta do lado dela.

### 5.3. Padrões ampliados após análise de jan–jun/2026 (25/08/2026)

Analisando os 6 meses de 2026 juntos (não só março), achamos mais 7 categorias
não-fiscal que se repetem igualmente em TODOS os meses e ainda não eram
detectadas. Investigação partiu de fevereiro/2026 (o mês com maior diferença
pasta×planilha na época) e os padrões foram então testados contra jan–jun
inteiros para confirmar que valem de forma geral, não só naquele mês.

| Padrão no nome do arquivo | O que é |
|---|---|
| `CHEQUE` | Compensação de cheque |
| `pgto TRCT/FOLHA/ADTO SALARIAL/PENSAO ALIMENTICIA/MEI/PREMIO/DIARIAS/REEMBOLSO/BOLETO CIEE/DIF` | Folha/RH — a planilha Delsoft chama isso de "pgto X - LARSIL" |
| `GUIA ISS/INSS/PIS/COFINS/CSLL/IRPJ/IPTU/IPVA` | Guia de tributo |
| `CONTA GARANTIDA PJ`, `GIRO PARCELADO`, `LIQUIDACAO DE PARCELA` | Variante de crédito/giro empresarial |
| `EVA CARD` | Cartão de benefício (variante do vale-alimentação) |
| `pgto SINDICATO` | Contribuição sindical |
| `ITAU.DOC.NNNNNN` / `BANCO.DOC.NNNNNN` | Transferência bancária (TED/DOC) |

Impacto medido, por mês (arquivos a mais retirados do card "PDFs na pasta"):

| Mês | Reduzido em |
|---|---:|
| 01.2026 | 22 |
| 02.2026 | 43 |
| 03.2026 | 29 |
| 04.2026 | 36 |
| 05.2026 | 29 |
| 06.2026 | 32 |

A uniformidade (22–43 em todos os meses, incluindo março e maio que já batiam
bem) foi o que confirmou que são categorias genuínas — não um ajuste calibrado
para um mês específico.

---

## 6. Excluídos do lado do BANCO (relatório do OCR)

**Onde:** `comparar-notas.js`, `contarNoCsv` (linha ~145).

Mesmo filtro do item 5.1: só conta linhas do CSV cujo nome de arquivo é
`NNN.DOC`. Um boleto de carnê grava uma linha por parcela (sufixo `#p1`, `#p2`…) —
essas são agrupadas de volta em 1 arquivo antes de contar (`arquivoBase`).

O mesmo corte do item 5.2 (`categoriaNaoFiscal`) também roda aqui: o banco grava
tudo que o OCR processou, então tem o mesmo consórcio/financiamento/PIX vindo da
pasta. Exposto em `banco.naoFiscal` / `banco.naoFiscalPorCategoria`.

### 6.1. PERIODO gravado no banco ≠ mês real do documento (corrigido em 25/08/2026)

**Onde:** `comparar-notas.js`, `contarNoCsv` (recálculo do mês) e a query da rota
(agora sem `WHERE PERIODO = @periodo`).

Até 25/08/2026 o banco filtrava por `PERIODO = @periodo` direto no SQL — confiando
que o campo `PERIODO`, gravado pelo scheduler quando ele PROCESSOU o arquivo,
corresponde ao mês do documento. Não corresponde: o scheduler grava sob o período
em que rodou, não sob a data do PDF.

Medido em 03/2026 antes da correção: dos 828 arquivos com `PERIODO='03.2026'`, só
667 tinham data de março no nome do arquivo. Os outros 161 eram principalmente de
fevereiro (74) e janeiro (43), com um punhado de abril e até 2025 — provavelmente
lotes processados com atraso ou reprocessados fora de época.

**Correção:** a rota agora busca `CONTEUDO` de TODOS os `PERIODO` (são só ~31,
poucos MB no total — one round trip, cacheado por tamanho agregado do conteúdo).
`contarNoCsv` recalcula o mês de cada arquivo pela mesma regra da pasta (data no
nome, subpasta como reserva) e só então agrupa por mês — exatamente como pasta e
planilha já faziam. O `PERIODO` gravado deixou de ser usado para decidir o mês;
serve só para saber em qual CSV a linha estava.

---

## Critério do item 5.2 / 6 é uma heurística — não uma classificação confiável

`categoriaNaoFiscal` decide por REGEX no nome do arquivo (`PADROES_NAO_FISCAL`).
Funciona porque quem arquiva nomeia o PDF de forma consistente (ex.: sempre
"Grupo NNNN... Cota NNN" para consórcio), mas isso pode variar:

- um nome fora do padrão esperado não é detectado e continua contando como nota;
- um nome de nota real que por acaso contém uma palavra do padrão (pouco provável,
  mas não impossível) seria excluído por engano.

Se a diferença entre pasta/banco/planilha voltar a crescer de forma inexplicável,
o primeiro lugar a olhar é se apareceu um tipo de pagamento novo, nomeado de um
jeito que os padrões atuais não cobrem — não necessariamente um documento
faltando de verdade.

---

## 7. O que sobra depois de todos os cortes: pasta e banco batem; planilha oscila

Análise de 25/08/2026, comparando jan–jun/2026 depois de aplicar TODOS os cortes
acima (item 5.2 + 5.3 do lado da pasta/banco, itens 2–4 do lado da planilha):

| Mês | Pasta | Banco | Planilha | Pasta/Planilha |
|---|---:|---:|---:|---:|
| 01.2026 | 597 | 585 | 487 | 1,23 |
| 02.2026 | 581 | 575 | 490 | 1,19 |
| 03.2026 | 608 | 601 | 639 | 0,95 |
| 04.2026 | 553 | 544 | 490 | 1,13 |
| 05.2026 | 475 | 467 | 499 | 0,95 |
| 06.2026 | 533 | 524 | 498 | 1,07 |

**Pasta e banco andam praticamente juntos** em todos os meses (diferença de 8 a
12 — provavelmente boletos multi-parcela ou nomes de arquivo que um lado
reconhece e o outro não). Isso confirma que a lógica de pasta e banco está
consistente entre si.

**A planilha oscila**: março e maio batem quase exatamente (0,95); janeiro,
fevereiro, abril e junho ficam com a pasta 7–23% acima. Investigado (comparação
dia a dia de fevereiro, cruzando NF pasta×planilha): a diferença não é
concentrada em dias específicos nem é sempre no mesmo sentido — tem dia em que a
planilha tem mais lançamentos que a pasta, e dia em que é o contrário. Boa parte
do que "sobra" na pasta em dias de maior diferença são faturas pequenas e
recorrentes (ex.: provedores de internet — BIOS NET, SERVERNET, GM TELECOM) cuja
ENTIDADE existe na planilha em outros meses (156 ocorrências de BIOS NET no total,
por exemplo), mas aquela NF específica não está lançada no mês em questão.

> **Esta conclusão foi revista em 25/08/2026** — ver item 8. A hipótese de "a
> planilha simplesmente não tem o lançamento" estava errada: os documentos ESTÃO
> na planilha, mas sob `ORIG='CP'`, fora do escopo do card.

---

## 8. Onde estão, de fato, os documentos que "faltam" na planilha

Investigação de 25/08/2026, motivada pela pergunta "por que tem muitos a mais que
a planilha?". Desta vez o cruzamento foi por **VALOR** (o valor no nome do arquivo
foi conferido por quem arquivou, é âncora mais confiável que a NF) em vez de por
NF exata, o que evita perder casos por diferença de formato de número.

Método: 3.347 PDFs fiscais da pasta (jan–jun/2026) × 3.113 lançamentos da planilha
no escopo do card, casando por valor exato no mesmo mês → mês vizinho → `VL_ITEM`
→ parcela (valor × N). Sobraram 1.634 sem par. Para cada um, buscamos o valor na
**planilha inteira**, sem nenhum filtro, para descobrir onde ele estava:

| Onde o documento realmente está | Qtd | % |
|---|---:|---:|
| Na planilha sob **`ORIG='CP'`** (fora do escopo) | 869 | 53% |
| Em **outro mês** que não o vizinho | 331 | 20% |
| Não existe em lugar nenhum da planilha | 287 | 18% |
| Em **outra filial** (ALR, MS AGROPECUARIA, S5…) | 88 | 5% |
| Cortado por conta contábil (item 2) | 59 | 4% |

Detalhe do "fora do escopo de origem": 821 em `CP`, 28 em `ADI`, 16 em
`TRANSF-REC`, 2 em `CR`, 2 em `LMCR`.

### 8.1. O comentário sobre CP no código está parcialmente errado

`ORIG_ESCOPO` exclui `CP` com a justificativa (no comentário do código) de que
"10.250 dos 10.797 NF_ENTRADA já aparecem em CP com a mesma NF e entidade — é a
mesma compra vista duas vezes". Medido agora para LARSIL, jan–jun/2026, aplicando
os mesmos cortes de conta:

| | Chaves distintas (mês\|NF\|entidade) |
|---|---:|
| Escopo atual (NF_ENTRADA + LMCP + TAXA) | 3.113 |
| CP | 3.217 |
| CP que **já está** no escopo atual | 2.836 (88,2%) |
| CP que seria **novo** | **381 (11,8%)** |

Ou seja: a premissa está certa para 88% dos casos, mas **381 lançamentos existem
só em CP** — e são justamente documentos que a pasta arquivou. Incluir CP no
escopo reduz o desvio médio pasta/planilha de 11,7% para 6,3%, mas **inverte o
sinal em março e maio** (a planilha passa a ter mais que a pasta, ratio 0,87).
Não é uma troca limpa: corrige uns meses e estraga outros, por isso **não foi
aplicado** — fica registrado aqui como decisão pendente.

> **❌ REJEITADO em 02/09/2026 — remedido, a conclusão acima não vale mais.**
> Ver [§9](#9-cp-remedido-em-02092026--rejeitado). Duas premissas caíram: o ganho
> de 11,7%→6,3% desapareceu depois que §8.2 foi aplicado (o escopo atual já está
> em 8,9%), e a métrica que sustentava a proposta — desvio do ratio — não mede
> acerto de casamento. Pareando lançamento × documento, **nenhuma variante de CP
> melhora a cobertura**.

### 8.2. Guias de tributo pelo nome da entidade (aplicado)

260 documentos de `GOVERNO` / `PREFEITURA` / `IPVA` passavam como nota fiscal, e
**225 deles (87%) estavam entre os "ausentes"** — quase puro ruído inflando a
pasta. São guias de IPVA por placa (`RC 901726 SDS4G21`) e taxas municipais.

O padrão que já existia (`RCB 9039xx/9049xx`) não os pegava porque os RCs de guia
vão de 9017xx a 9046xx. **Ampliar a faixa numérica é inviável**: 392 documentos de
fornecedor legítimo (pessoas físicas — CELSO, JANICE, LEANDRO…) usam RC na mesma
faixa `90xxxx`. Por isso o padrão novo usa o **nome da entidade**, que é
inequívoco: as 260 ocorrências são todas guia de tributo, nenhuma nota de serviço.

Efeito medido (jan–jun/2026):

| Mês | Pasta antes | Pasta agora | Banco | Planilha | Ratio |
|---|---:|---:|---:|---:|---:|
| 01.2026 | 597 | 522 | 510 | 487 | 1,07 |
| 02.2026 | 581 | 507 | 501 | 490 | 1,03 |
| 03.2026 | 608 | 534 | 529 | 639 | 0,84 |
| 04.2026 | 553 | 544 | 537 | 490 | 1,11 |
| 05.2026 | 475 | 453 | 445 | 499 | 0,91 |
| 06.2026 | 533 | 527 | 518 | 498 | 1,06 |

Desvio médio do ratio: **11,7% → 8,9%**. Janeiro e fevereiro melhoraram bastante
(1,22→1,07 e 1,18→1,03); março piorou (0,95→0,84), porque lá a planilha registra
proporcionalmente mais guias que os outros meses.

### 8.3. Por que NÃO cortamos `IMPOSTOS E TAXAS` da planilha

Testamos o corte simétrico — tirar as guias também do lado da planilha, pela conta
contábil `IMPOSTOS E TAXAS` (110 lançamentos em jan–jun, todos com entidade de
órgão público: `GOVERNO DO PARANA SEC DE ESTADO DA FAZENDA`, `SECRETARIA DA
FAZENDA SP`, `DETRAN PR`, `MUNICIPIO DE…`).

**Piorou**: desvio médio subiu de 8,9% para 11,5%. A planilha registra 110 guias
enquanto a pasta arquiva 260 — as fontes não cobrem tributo na mesma proporção, e
cortar dos dois lados amplifica essa assimetria em vez de cancelá-la. Mantido só o
corte do lado da pasta/banco.

### 8.4. O que sobra

Depois de tudo, ainda há ~287 documentos (18% dos sem-par) cujo valor não aparece
em lugar nenhum da planilha, e 331 que aparecem em meses distantes. Desses, 1.257
têm fornecedor que existe na planilha com outros valores (LOCALIZA 19x, MAQNELSON
54x, BOBIG 16x, EQUATORIAL 17x) — o fornecedor é atendido, aquele documento
específico é que não está lançado no período.

**Resumo da causa raiz:** a maior parte do "a mais na pasta" não é documento sem
lançamento — é lançamento existente numa origem (`CP`) que o card não olha. O
resíduo depois disso é pequeno e disperso.

> **Revisto em 02/09/2026** — ver [§9](#9-cp-remedido-em-02092026--rejeitado). Esse
> "resumo da causa raiz" era consequência da métrica errada. Pareando lançamento ×
> documento, os lançamentos de CP quase não têm documento: a causa raiz do "a mais
> na pasta" continua sendo estrutural (§8.4 e PROGRESSO §8), não escopo de origem.

---

## 9. CP remedido em 02/09/2026 — rejeitado

Reteste de §8.1 contra o código atual, a pedido do usuário. **Conclusão inversa à
de §8.1: CP não deve entrar.**

### 9.1. Por que a conclusão mudou

§8.1 mediu CP **antes** de §8.2 (corte de guias de tributo pelo nome da entidade).
Aquele corte já puxou o escopo atual de 11,7% para 8,9% de desvio — capturou boa
parte do que a inclusão de CP compensava. Somar CP agora passa do ponto.

| | §8.1 (25/08) | Agora (02/09) |
|---|---:|---:|
| Desvio, escopo atual | 11,7% | **8,9%** |
| Desvio, com CP | 6,3% | **10,9%** |
| Veredito | melhora, mas inverte sinal | **piora** |

Com CP inteiro, **os seis meses caem abaixo de 1,00** (0,77–0,99): a planilha passa
a ter mais lançamentos do que a pasta tem documentos, em todo o período.

**O harness reproduz os números documentados** — a coluna do escopo atual bate
linha a linha com a tabela de §8.2, e a sobreposição dá os mesmos 3.113 / 3.217 /
2.836 (88,2%) / 381 (11,8%) de §8.1. Está medindo a mesma coisa.

### 9.2. Dez variantes de escopo, métrica agregada

| Variante | 01 | 02 | 03 | 04 | 05 | 06 | Desvio | Viés |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| *Pasta (documentos)* | 522 | 507 | 534 | 544 | 453 | 527 | | |
| D. + CP só TIPO fiscal | 525 | 500 | 657 | 502 | 521 | 511 | **7,5%** | −3,2% |
| C. + CP sem IMPOSTO/PREV/DB | 536 | 502 | 657 | 503 | 521 | 512 | 7,7% | −3,7% |
| E. + CP só FATURA | 506 | 500 | 657 | 500 | 520 | 510 | 8,1% | −2,5% |
| **A. atual** | 487 | 490 | 639 | 490 | 499 | 498 | 8,9% | +0,3% |
| G. atual sem LMCP | 482 | 486 | 632 | 487 | 495 | 495 | 9,1% | +1,1% |
| F. atual sem TAXA | 478 | 481 | 637 | 468 | 495 | 498 | 10,2% | +2,0% |
| H. só NF_ENTRADA | 473 | 477 | 630 | 465 | 491 | 495 | 10,5% | +2,9% |
| B. + CP inteiro | 556 | 583 | 693 | 551 | 546 | 555 | 10,9% | −10,9% |

Por essa métrica, filtrar CP por TIPO parecia ganho real (8,9% → 7,5%).

### 9.3. A métrica agregada é o critério errado

O desvio `|ratio−1|` só compara **totais**. Ele premia aproximar os números mesmo
quando os conjuntos não se correspondem — a mesma armadilha de PROGRESSO §12
("os cards não fechavam porque mediam coisas diferentes").

Refazendo com **cobertura pareada** (casa lançamento × documento por valor, dentro
do mês, 1 documento por lançamento):

| Variante | Lanç. | Pares | Órfãos planilha | Órfãos pasta | Cobertura |
|---|---:|---:|---:|---:|---:|
| **A. atual** | 3.113 | 1.037 | 2.076 | 2.046 | **33,3%** |
| C. + CP sem IMP/PREV/DB | 3.241 | 1.069 | 2.172 | 2.014 | 33,0% |
| D. + CP só fiscal | 3.226 | 1.063 | 2.163 | 2.020 | 33,0% |
| E. + CP só FATURA | 3.203 | 1.057 | 2.146 | 2.026 | 33,0% |
| B. + CP inteiro | 3.494 | 1.072 | 2.422 | 2.011 | 30,7% |

**As duas métricas discordam e a pareada é a que vale.** Nenhuma variante de CP
ganha: a melhor recupera 32 pares ao custo de 96 lançamentos órfãos.

### 9.4. Qualidade do que CP acrescenta

Taxa de lançamentos **com documento** entre os que cada variante adiciona
(controle: o escopo atual tem 41,9%):

| Variante | Novos | C/ doc | Taxa |
|---|---:|---:|---:|
| CP inteiro | 381 | 52 | 13,6% |
| CP sem IMPOSTO/PREV/DB | 128 | 39 | 30,5% |
| CP só TIPO fiscal | 113 | 32 | 28,3% |
| CP só FATURA | 90 | 24 | 26,7% |

Filtrar por TIPO mais que dobra a taxa, mas **todas ficam abaixo dos 41,9% do
escopo atual** — qualquer variante de CP dilui. Composição dos 381: 158 `IMPOSTO`,
90 `FATURA`, 72 `PREVISAO`, 23 `DESPESAS BANCARIAS` — 66% são categorias que o
comparador já exclui por princípio em outros pontos, com entidades como
`SECRETARIA DA RECEITA FEDERAL`, `INSS` e `PREFEITURA MUNICIPAL`.

### 9.5. Março não é problema de escopo

Março fica em 0,81–0,84 em **todas** as variantes. Dos seus 642 lançamentos, 402
não têm documento nenhum: 120 `NFE AUTORIZADA RECEITA FEDERAL`, 112 `RECIBO`, 71
`NFS EMITIDA PREFEITURAS`, 52 `NFSE SISTEMA NACIONAL`, 40 `FAT AGUA LUZ PEDAGIO`.
São notas fiscais legítimas que não foram arquivadas — a lacuna estrutural de
PROGRESSO §8. Nenhum ajuste de escopo alcança isso.

### Ressalvas da medição

- O pareamento por valor é guloso e usa o valor lido do **nome do arquivo**; os
  absolutos (33,3%) subestimam a cobertura real. O que vale é a **comparação entre
  variantes**, que usa o mesmo critério para todas.
- Mede escopo/filtragem, não o motor de casamento — que não está no
  `comparar-notas.js` atual (ver §10).
- Planilha de 13/08/2026. Export mais novo muda os números.
- Uma hipótese intermediária foi **descartada por medição**: "o sinal negativo do
  `VL_TOTAL_CAB` denuncia estorno". Não denuncia — 99,7% do escopo atual também é
  negativo. É a convenção da planilha, não um sinal.

---

## 10. Mais campos de comparação aumentam a precisão (medido em 02/09/2026)

**Gatilho:** "seria possível aumentar a precisão usando mais itens de comparação?"
Resposta medida: **sim, e o ganho é grande.** Todo o pareamento de §9 usava só o
**valor**, que é âncora fraca — valores redondos colidem o tempo todo.

> **Escopo desta seção:** mede o *pareamento de diagnóstico* construído para avaliar
> escopo, **não** o motor de casamento de produção (que não está no
> `comparar-notas.js` atual — ver §11). O motor antigo já usa número e entidade; o
> que se mede aqui é **quanto** cada campo vale e qual combinação domina.

### 10.1. A evidência existe e quase não é usada

| Lado PASTA (nome do arquivo) | | Lado PLANILHA (colunas) | |
|---|---:|---|---:|
| valor | 98,8% | `NF` | 100,0% |
| entidade | 99,3% | `DT_EMISSAO` | 100,0% |
| número rotulado (`NFS 818325`, `RC 898303`) | 87,2% | `VL_TOTAL_CAB` | 100,0% |
| valor + número + entidade | 86,5% | `FANTASIA` | 92,4% |
| | | `CNPJ` (14 dígitos) | 61,1% |

3.132 PDFs fiscais e 3.113 lançamentos, jan–jun/2026. A planilha tem 36 colunas;
o pareamento por valor usava uma.

### 10.2. Nove estratégias

`confirmado` = pares em que um **segundo** campo também bate. Sem gabarito, é o
único juiz disponível: par só por valor com entidade discordando é suspeito.

| Estratégia | Pares | Cobertura | Confirmado |
|---|---:|---:|---:|
| 1. só valor *(a de §9)* | 1.037 | 33,3% | 774 (74,6%) |
| 2. só número | 852 | 27,4% | 809 (95,0%) |
| 3. só entidade | 1.791 | 57,5% | 430 (24,0%) |
| 4. valor E entidade | 820 | 26,3% | 820 (100%) |
| 5. valor E número | 700 | 22,5% | 700 (100%) |
| 6. número E entidade | 747 | 24,0% | 747 (100%) |
| **7. valor OU (número E entidade)** | **1.143** | **36,7%** | **880 (77,0%)** |
| 8. 2 de 3 | 1.003 | 32,2% | 1.003 (100%) |
| 9. os 3 | 632 | 20,3% | 632 (100%) |

**A estratégia 7 domina a 1 nos dois eixos** — mais pares (+106) *e* maior taxa de
confirmação. Não há trade-off, o que é raro. Para confiança máxima, a **8 (2 de 3)**
dá 1.003 pares com 100% de confirmação, quase a mesma cobertura da regra por valor
e sem nenhum par apoiado num campo só.

### 10.3. Os +106 são achado, não ruído

Casam **NF + entidade** com valor diferente — tipicamente boleto com desconto ou
retenção, que o pareamento por valor perde por construção:

| Planilha | Documento |
|---|---|
| NF 517 ARPSEG, R$ 827,00 | `ARPSEG . NF 517+ AUT` — R$ 797,93 |
| NF 2182 IMPERIUS, R$ 900,00 | `IMPERIUS . NF 2182+ BOL` — R$ 881,98 |
| NF 5580 ANDRADE MARTINS, R$ 479,98 | `ANDRADE MARTINS. NFS 5580 + BOL` — R$ 464,01 |
| NF 55999 FIDELITY, R$ 1.036,38 | `FIDELITY . NFS 55999 + BOL` — R$ 972,64 |

**Independência de ordem verificada:** embaralhando os lançamentos com 3 sementes,
o total fica em 1.143 / 1.142 / 1.143. O ganho não vem do pareamento guloso.

### 10.4. A regra por valor erra em 25% dos casos

263 dos 1.037 pares "só valor" (**25,4%**) têm entidade **e** número discordando.
A inspeção confirma que são erros, não falso alarme:

| Planilha | Documento casado |
|---|---|
| BIOS NETWORKS TELECOM, R$ 125,00 | `VINICIUS . RC 901745` |
| LOCALIZA FLEET SA, R$ 2.115,00 | `ALESSANDRO PEREIRA. NF 901873` |
| LUIZ APARECIDO DANTAS, R$ 1.500,00 | `SANTEC RECAP. NFS 138` |
| MANOEL ALVES DE FREITAS, R$ 1.500,00 | `LUIZ APARECIDO DANTS. RCB 901437` |

Valores redondos (R$ 1.000, R$ 1.200, R$ 1.500) colidem sistematicamente. Um dos
pares casa lançamento de janeiro com documento datado `2026.08.01`.

### 10.5. Data: útil como veto do caminho fraco, não como filtro geral

| Estratégia | Pares | Cobertura | Confirmado | Suspeitos |
|---|---:|---:|---:|---:|
| 7. valor OU (núm E ent) | 1.143 | 36,7% | 77% | 263 (23,0%) |
| 7 + data ≤ 30d | 1.142 | 36,7% | 77% | 263 (23,0%) |
| 7 + data ≤ 15d | 1.047 | 33,6% | 77% | 246 (23,5%) |
| 7 + data ≤ 7d | 790 | 25,4% | 74% | 203 (25,7%) |
| **7, valor-só exige data ≤ 15d** | 1.121 | 36,0% | 78% | 243 (21,7%) |
| **7, valor-só exige data ≤ 7d** | 1.025 | 32,9% | **81%** | **193 (18,8%)** |

Como filtro global a data só custa cobertura. Aplicada **só ao caminho fraco**
(par sustentado apenas por valor), corta 27% dos suspeitos e leva a confirmação a
81%. O `≤ 15d` é a troca mais suave.

### 10.6. CNPJ: a única evidência capaz de rejeitar colisão de número

61,1% dos lançamentos têm CNPJ de 14 dígitos (a coluna `CNPJ`, com o CNPJ colado na
`ENTIDADE` como reserva). Em jan–jun/2026, **21 números de NF são compartilhados
por entidades de raiz de CNPJ diferente** — colisões que só o CNPJ separa:

| Período | NF | Entidades em conflito |
|---|---|---|
| 02.2026 | 154 | EXPRICE CONS CONTABIL `[40910185]` × CELIA CORREIA `[44804614]` |
| 02.2026 | 148 | BORRACHARIA E RECUP `[54634170]` × MAQNELSON AGRICOLA `[77911110]` |
| 02.2026 | 100 | BUENO COM. DE PEÇAS `[51868844]` × ARIANE APARECIDA `[86549570]` |
| 02.2026 | 1055 | G. CASARIL E T. CASARIL `[51212188]` × KUHNEN E CHAVES `[09393594]` |

Confirma PROGRESSO §10.4, que achou o mesmo padrão pela chave de acesso da NF-e
(NF 706/708 caindo sobre FRISIA e EXPRICE). O CNPJ hoje é usado **só como evidência
positiva**; usá-lo para **rejeitar** seria a primeira evidência negativa do
comparador — mudança de política que precisa de medição própria.

### 10.7. Recomendação

1. **Adotar "valor OU (número E entidade)"** como regra de casamento — domina a
   regra por valor nos dois eixos, sem trade-off.
2. **Exigir data ≤ 15 dias quando o par se apoia só no valor** — corta os
   suspeitos sem custar cobertura relevante.
3. **CNPJ como veto** entre candidatos que dividem o mesmo número — mede-se
   separadamente, é mudança de política.

Os itens 1 e 2 valem para o motor de casamento (§11), não para as contagens do
card, que não pareiam nada.

---

## 10.8. Aplicado em 02/09/2026 — `routes/_pareamento.js`

A recomendação de §10.7 foi implementada como **camada aditiva** na rota viva
(`server.js:59` carrega o `comparar-notas.js` da working tree — ver §11). Nenhuma
das três contagens mudou; o pareamento é um quarto número, calculado depois.

**Calibragem escolhida (equilibrada):** `valor OU (número E entidade)`, com veto de
data de **15 dias aplicado só ao par sustentado apenas por valor**.

### Arquivos

| Arquivo | Mudança |
|---|---|
| `routes/_pareamento.js` | **novo** — extração do nome do arquivo, os 3 sinais, a regra e o pareamento |
| `routes/comparar-notas.js` | `arquivosPorMes` e `itens` guardados na varredura; passo 4 chama o pareamento; `dataDoSerial` |
| `conferencia-notas.html` | card "Conferidos" + tooltip com a composição; grid de 3 → 4 colunas |

### Medido na rota real (não no harness)

| Período | Pasta | Planilha | Conferidos | Fracos | Sem doc. | Sem lanç. | ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01.2026 | 522 | 487 | 165 | 24 | 322 | 357 | 31 |
| 02.2026 | 507 | 490 | 193 | 32 | 297 | 314 | 34 |
| 03.2026 | 534 | 639 | 202 | 21 | 437 | 332 | 29 |
| 04.2026 | 544 | 490 | 193 | 18 | 297 | 351 | 22 |
| 05.2026 | 453 | 499 | 197 | 23 | 302 | 256 | 20 |
| 06.2026 | 527 | 498 | 189 | 14 | 309 | 338 | 21 |

**As três contagens não mudaram** em nenhum período (conferido contra a medição de
§9.2). As duas identidades novas fecham nos 6 períodos:

```
conferidos + lancamentosSemDocumento = planilha.total
conferidos + documentosSemLancamento = pasta.total
```

**Como os pares se sustentam** (03/2026): 118 pelos três sinais, 35 valor+fornecedor,
20 número+fornecedor (valor difere — boleto com desconto), 29 só por valor. Apenas
**21 de 202 (10%)** se apoiam num sinal único; são os expostos como "a conferir".

**Independência de ordem verificada na rota:** embaralhando lançamentos e documentos
com 4 sementes, o total não muda em 01, 03 e 05/2026 (165 / 202 / 197). A ordenação
dos candidatos por **força do par** — e não pela ordem da planilha — resolve por
construção o defeito 5 da auditoria (casamento guloso dependente de ordem).

**Custo:** 20–50 ms por requisição, sem varredura nova — o pareamento reusa a
varredura de pasta já cacheada e os lançamentos já lidos da planilha.

### Diferença para os números de §10

§10 mediu 1.143 pares em jan–jun; a rota soma 1.139. A diferença é de **atribuição de
mês**: o harness agrupava os PDFs pela subpasta `2026.MM.*`, a rota usa
`mesDoNome`/`mesDaPasta` — a mesma regra dos cards. Essa consistência é o que faz as
identidades fecharem, e é a atribuição correta.

### Limites conhecidos

- ~~**Só casa dentro do mesmo mês.**~~ Resolvido em §10.9.
- **Não trata parcela** (1 lançamento ↔ N documentos, PROGRESSO §14): cada documento
  consome um lançamento e vice-versa.
- **Não usa CNPJ**, nem como veto (§10.6).
- Depende do nome do arquivo ser bem formado. Medido em 03/2026: dos 534 documentos,
  523 têm valor, 458 têm número, 505 têm data; 8 não têm valor nem número e nunca
  casam.

---

## 10.9. Pastas vizinhas (02/09/2026) — a cobertura quase dobra

O maior ganho que estava na mesa. `conferirPeriodo` em `_pareamento.js` procura o
documento também nas pastas `[-1, +1, +2]` antes de declarar o lançamento sem papel.

### O vizinho que importa é **+1**, não −1

Distribuição medida — de que pasta vem o documento de cada lançamento:

| Período | mesmo | −1 | −2 | −3 | **+1** | +2 |
|---|---:|---:|---:|---:|---:|---:|
| 01.2026 | 165 | 0 | 0 | 0 | **122** | 5 |
| 02.2026 | 193 | 13 | 0 | 0 | **102** | 1 |
| 03.2026 | 202 | 17 | 1 | 0 | **136** | 7 |
| 04.2026 | 193 | 3 | 0 | 2 | **106** | 2 |
| 05.2026 | 197 | 11 | 2 | 1 | **131** | 7 |
| 06.2026 | 189 | 23 | 3 | 1 | **93** | 11 |

O documento é arquivado quando **chega**; a planilha lança no **pagamento**. Logo a
pasta do mês seguinte é que guarda o papel do mês corrente — a mesma simetria que
PROGRESSO §12 descreveu ("a pasta de Abril guarda os documentos de Março"), mas o
peso está em +1, não em −1 como o texto de lá sugere.

### Escolha da janela

| Janela | Conferidos | Cobertura | Pastas lidas |
|---|---:|---:|---:|
| só mesmo mês | 1.139 | 36,7% | 1 |
| `[-1]` | 1.206 | 38,9% | 2 |
| `[-1,+1]` | 1.899 | **61,2%** | 3 |
| **`[-1,+1,+2]`** ← adotada | 1.932 | 62,3% | 4 |
| `[-2,-1,+1,+2]` | 1.936 | 62,4% | 5 |
| `[-3..-1,+1,+2]` | 1.939 | 62,5% | 6 |

O salto está em `+1`; depois de `+2` o retorno morre (62,3% → 62,5% por duas leituras
a mais). Mantida a mesma janela de PROGRESSO §12.

### Resultado na rota

| Período | Conferidos | no mês | vizinhas | Sem doc. (antes → agora) |
|---|---:|---:|---:|---:|
| 01.2026 | 293 | 165 | 128 | 322 → **194** |
| 02.2026 | 309 | 193 | 116 | 297 → **181** |
| 03.2026 | 362 | 202 | 160 | 437 → **277** |
| 04.2026 | 304 | 193 | 111 | 297 → **186** |
| 05.2026 | 349 | 197 | 152 | 302 → **150** |
| 06.2026 | 317 | 189 | 128 | 309 → **181** |

Em março, 138 dos 160 recuperados vieram da pasta de **04.2026**.

### Os pares vizinhos são MELHORES que os do próprio mês

| Origem | 1 sinal | 2 sinais | 3 sinais |
|---|---:|---:|---:|
| mesmo mês | 11,6% | 32,6% | 55,8% |
| vizinhas | 10,8% | 23,8% | **65,3%** |

A inspeção mostra por quê: quase todo recuperado em `+1` é **parcela** — CIMAG NF
103886 (R$ 21.900,00 ÷ 3 = R$ 7.300,00), ADS NF 280 (R$ 16.857,15 ÷ 6), IRMAOS SILVA
NF 110807 (R$ 11.999,40 ÷ 4). Casam por número + fornecedor com valor fracionário,
que é o caso para o qual PROGRESSO §14 construiu o `parcelaLivre`. O caminho
`numero+entidade` os pega sem precisar daquela máquina.

### Dois defeitos achados e corrigidos na implementação

1. **Documento contado por dois meses.** Cada mês roda sua própria conferência, então
   um documento de Fevereiro podia cobrir um lançamento de Janeiro *e* um de
   Fevereiro — medido: **115 documentos em 6 meses**. Corrigido pela mesma decisão de
   PROGRESSO §12: o par vizinho **retira o lançamento de "sem documento" mas não conta
   como documento coberto da pasta**. Verificado depois: 0 duplicados, e as duas
   identidades fecham nos 6 períodos.

   ```
   conferidos            + lancamentosSemDocumento = planilha.total
   conferidos NO MÊS     + documentosSemLancamento = pasta.total
   ```

2. **Dependência de ordem, ±1 par.** Rodar uma pasta vizinha por vez fazia a ordem dos
   offsets decidir o casamento; e candidatos de mesma força e mesma distância ficavam
   na ordem de entrada. Corrigido com **uma passada única** sobre todas as vizinhas e
   desempate final pelo **conteúdo** (NF+entidade, depois nome do arquivo) em vez do
   índice. Verificado com 5 sementes nos 6 períodos: totais idênticos.

**Custo:** 54–96 ms (era 20–50). Não há varredura nova — as pastas vizinhas já estavam
na varredura cacheada; só a conversão dos nomes é refeita.

---

## 10.10. Painel reorganizado por unidade (02/09/2026)

**Gatilho:** o usuário olhou o painel com os quatro cards lado a lado — 534 / 529 /
639 / 362 — e disse "ainda não tá batendo os números".

Estava certo, e **não era erro de contagem**: as duas identidades fechavam. O painel é
que convidava a uma soma impossível.

### O que estava errado

1. **Unidades misturadas em linha.** "PDFs na pasta" (534) e "Salvos no banco" (529)
   contam DOCUMENTO; "Na planilha" (639) conta LANÇAMENTO. Quatro cards iguais lado a
   lado afirmam visualmente que são a mesma grandeza — 534 e 639 nunca vão bater.
2. **O subtítulo reforçava o erro:** *"documentos esperados, contados em três fontes
   independentes"* — dizia explicitamente que os três mediam a mesma coisa.
3. **O card de destaque não era o que reconcilia.** "Conferidos: 362" é o total com
   documento em qualquer pasta; o número que fecha contra os 534 da pasta é o **202**
   (só do mês), que aparecia miúdo no subtexto.

É a mesma armadilha de §12 ("os cards não fechavam porque mediam coisas diferentes"),
reintroduzida ao acrescentar o quarto card.

### O que passou a ser

Dois blocos rotulados, cada um imprimindo **a conta que fecha**:

```
Pasta e banco — documentos arquivados
   534 PDFs na pasta        529 Salvos no banco
   202 com lançamento + 332 sem = 534 PDFs nesta pasta

Planilha — lançamentos do mês
   639 Na planilha    362 Com documento    277 Sem documento
   362 com documento + 277 sem = 639 lançamentos

Os dois blocos contam coisas diferentes — documento e lançamento — e por isso não
somam entre si. Dos 362 lançamentos com documento, 160 têm o papel arquivado em
pasta de outro mês.
```

Mudanças: "Conferidos" → **"Com documento"**; card novo **"Sem documento"** (o número
que interessa a quem confere, antes só no tooltip); subtítulo reescrito; grid por
`style` inline com `auto-fit` em vez de classe Tailwind — o CDN é JIT sobre o DOM e
classe montada por interpolação (`sm:grid-cols-${n}`) não é garantida em HTML injetado.

**Princípio:** todo número da tela tem que ser conferível na própria tela. Enquanto a
soma que fecha só existir na medição, a pergunta volta.

---

## 11. Onde está o motor de casamento (nota de orientação)

Registrado em 02/09/2026 para evitar retrabalho: existem **duas** implementações de
casamento no repositório, e a que roda é a menor.

| | Working tree (viva) | `git HEAD` |
|---|---|---|
| `routes/comparar-notas.js` | 693 linhas → contagem + chamada ao pareamento | 1.198 linhas |
| Pareamento | `routes/_pareamento.js` (§10.8) | embutido na própria rota |
| Regras | valor / número / entidade + janela de data | `parcelaLivre`, `corroborado`, `scoreCandidato`, seção 6b |
| Em produção | **sim** (`server.js:59`) | não |

O `git HEAD` guarda o motor auditado em `ANALISE-COMPARADOR.md` e evoluído em
`PROGRESSO-COMPARADOR.md` — bem mais completo (parcelas, pastas vizinhas,
corroboração), mas **não é o que está no ar**. Recuperar com
`git show HEAD:routes/comparar-notas.js`.

O pareamento novo (§10.8) foi escrito como camada aditiva justamente para não
recriar a mistura que tornou a versão de ~1.800 linhas indepurável: contagem e
casamento falham por motivos diferentes, e se o pareamento estiver errado os três
cards de contagem continuam corretos.

**Ao evoluir o pareamento**, as regras já medidas do motor antigo que ainda faltam
são, em ordem de ganho: busca em pastas vizinhas `[-1,+1,+2]` (PROGRESSO §12) e
parcela 1↔N (PROGRESSO §14).

> **Atualização de 02/09/2026:** o CNPJ como veto, que esta lista trazia como
> terceiro ganho, foi medido e **reprovado** — ver §12.2. O que entrou no lugar
> foi usar o OCR para preencher o que o nome do arquivo não traz (§12.1).

## 12. OCR como segundo sinal (02/09/2026) — aprovado; veto por CNPJ — reprovado

Medido nos mesmos 6 períodos de §10 (jan–jun/2026, 3.103 lançamentos × 3.087 PDFs
fiscais), com o harness em `_medir/`. Baseline = `routes/_pareamento.js` como
estava, lendo só o NOME do arquivo.

| variante | pares | cobertura | sem doc. | confirmado por 2º campo |
|---|---|---|---|---|
| baseline (só nome do arquivo) | 1.934 | 62,3% | 1.169 | 88,9% |
| **+ OCR preenchendo o que falta** | **1.982** | **63,9%** | **1.121** | **90,9%** |
| + OCR + veto por CNPJ | 1.873 | 60,4% | 1.230 | 95,5% |
| + OCR, janela 30 dias | 2.098 | 67,6% | 1.005 | 88,8% |

### 12.1. O que foi aprovado

Usar `dados_parser` (o JSON que o scheduler já grava em
`nfs.RELATORIOS_CONFERENCIA`) para **preencher o campo que o nome do arquivo não
traz**. Sobe cobertura *e* precisão ao mesmo tempo — sem trade-off, o mesmo
critério que escolheu a regra principal em §10.

Cobertura do OCR sobre os PDFs fiscais: registro em 98,4%, emitente em 98,3%,
valor em 79,7%, número em 76,9%.

O ganho vem quase todo do **emitente**: o nome do arquivo é digitado à mão e erra
o fornecedor, e o OCR lê o nome impresso no documento.

    ARPESEG   (nome)  ×  ARPSEG LTDA              (planilha)
    SKILLUB   (nome)  ×  SKILLHUB TECNOLOGIA      (planilha)
    T. M. J.  (nome)  ×  T.J.M. FERRAMENTAS       (planilha)
    ACITEL    (nome)  ×  ASSOCIACAO COMERCIAL...  (planilha)
    BIOSNET   (nome)  ×  BIOS NETWORKS TELECOM.   (planilha)

O nome do arquivo tem **precedência**: o OCR só preenche o que falta e acrescenta
tokens de emitente aos que já existem. Nenhum par do baseline se perdeu por
conflito; os pares que mudaram trocaram documento errado por documento certo
(`VINICIUS` casado com documento da `BIOSNET`, `CLAUDIO` com recibo do `ARI`).

Emitente lido como `LARSIL` é descartado: em recibo, consórcio e boleto de
administradora o emitente impresso é o PAGADOR, e casaria com qualquer lançamento.

### 12.2. O que foi reprovado — veto por CNPJ

§10.6 e a nota de orientação de §11 apontavam o CNPJ como o próximo ganho. **A
medição reprovou.** O veto custa 61 pares bons para comprar 4,6 pp de precisão, e
os pares rejeitados são majoritariamente de força 3 (número + entidade + valor
concordando). O CNPJ que o OCR extrai não identifica o fornecedor:

| lançamento | documento | CNPJ lido pelo OCR | o que é |
|---|---|---|---|
| FERNANDA AGRELLI | recibo dela | 17281106000103 | Copasa — CNPJ de outro anexo do mesmo PDF |
| JOSE ANTONIO ROZAO ...849 | recibo dele | ...949 | dígito trocado na leitura |
| ROOSEVELT (CPF) | recibo dele | 06981180000116 | CEMIG — anexo |
| ELIZEU (CPF) | recibo dele | 12345678000190 | placeholder |
| 530 documentos | consórcio/recibo | 08420245000180 | PORTOBENS (administradora), não o fornecedor |

Numa primeira rodada o veto parecia catastrófico (−718 pares): a planilha exporta
CNPJ como **número**, e o Excel come o zero à esquerda (`01616929000102` chega
como `1616929000102`), o que fazia toda comparação por prefixo acusar divergência
falsa. Corrigido isso, o veto ainda perde pares — a conclusão se manteve.

**O CNPJ sai da lista de ganhos pendentes.** Ele só voltaria a ser útil se o
parser passasse a distinguir emitente de pagador na extração.

### 12.3. Janela de data — mantida em 15 dias

Abrir para 30 dias traz +164 pares, mas derruba a confirmação por 2º campo para
88,8% — abaixo do baseline. É cobertura comprada com par errado, e o critério de
§10 rejeita. Fechar para 7 dias custa 46 pares. **15 dias continua sendo o ponto.**

### 12.4. Estabilidade

Verificado com 4 sementes de embaralhamento da pasta e da planilha: 1.982 pares em
todas. A ordenação por força do par continua tornando o resultado independente da
ordem de entrada, como em §10.8.

### 12.5. Onde ficou no código

- `routes/_pareamento.js` → `enriquecerComOcr(doc, ocr)`, e `numeroBate` passou a
  aceitar `numeroAlt` (o nome às vezes traz o "nosso número" do boleto, não a NF).
- `routes/comparar-notas.js` → `camposOcr()` e o índice `ocrPorArquivo`, montado na
  **mesma varredura** que já conta o banco (uma segunda leitura custaria a mesma
  transferência de vários MB do SQL). Os campos são **fundidos** entre as linhas do
  mesmo arquivo: carnê grava uma linha por parcela e cada uma traz um pedaço.
- `contarNaPlanilha` passou a capturar a coluna `CNPJ` em `itens` — ela não é usada
  pelo pareamento (ver 12.2), mas estava prevista no comentário e custa nada.

O harness da medição está em `_medir/` (`baseline.js`, `comparar.js`,
`verificar.js`). `verificar.js` roda o caminho **de produção**, não a
reimplementação — é o que confirma que 1.982 é o número que a tela mostra.

## 13. Piso de dígitos do número (02/09/2026) — defeito achado pela amostra

A amostra de auditoria (§12.5, `_medir/amostra.js`) trouxe no topo casos assim:

    G CORPORI LTDA · NF 60 · R$ 1.720,00 · lanç. 19/01
    doc: 053.DOC- 1720,00-2026.02.18.CORPORI . NF 60+ BOL.pdf

Fornecedor, valor **e número** idênticos, e mesmo assim "sem documento". Rodando
`_medir/diagnostico.js`, que pergunta ao motor par a par por que recusou:

    CAUSA DE NÃO CASAR (só os que têm candidato óbvio na pasta)
      regra recusou ...................... 43
      perdeu a disputa pelo documento .... 2
      sem candidato óbvio ................ 1076

E nos 43 recusados pela regra, sempre o mesmo diagnóstico:

    nfPlanilha=52  numDoc=52  ->  numero=false
    nfPlanilha=69  numDoc=69  ->  numero=false
    nfPlanilha=60  numDoc=60  ->  numero=false

### 13.1. A causa

`MIN_DIGITOS_NUM = 3` recusava qualquer número com menos de 3 dígitos. O
comentário justificava: *"abaixo disso ('1', '12') ele casaria com quase tudo"*.

O raciocínio vale para o número **sozinho** — mas o motor nunca usa o número
sozinho: `casa()` exige (número E entidade), e o caminho por valor não olha
número. Com o fornecedor exigido junto, o risco de colisão é outro.

O piso descartava 206 lançamentos (6,6% de jan–jun/2026) que têm NF de 1-2
dígitos. Todos caíam no caminho fraco (só valor) e eram vetados pela janela de 15
dias — apareciam como "sem documento" com o papel na pasta ao lado.

### 13.2. A medição

| variante | pares | cobertura | sem doc. | precisão |
|---|---|---|---|---|
| baseline (antes de §12) | 1.934 | 62,3% | 1.169 | 88,9% |
| + OCR (§12) | 1.982 | 63,9% | 1.121 | 90,9% |
| **+ OCR, piso 2 dígitos** | **2.014** | **64,9%** | **1.089** | **91,3%** |
| + OCR, piso 1 dígito | 2.016 | 65,0% | 1.087 | 91,3% |

Sobe cobertura e precisão junto, de novo sem trade-off. Os **34 pares ganhos** são
todos de força 3 ou 4 (fornecedor + número, a maioria com valor também):

    AGRO AIR NF 52 R$ 21.616,00   × 018.DOC- 21616,00 ... AGRO AIR. NFS 52
    JUNIOR LOCACOES NF 69         × 059.DOC- 12641,60 ... JUNIOR LOCACOES. NF 69
    JC LAVANDERIA NF 52           × 044.DOC- 7105,35 ... JC LAVANDEIRA. NFS 52

Os **2 pares perdidos** eram colisão por valor, exatamente o tipo de erro que §10
mediu: `MONT KOYA` casada com documento da `BRV`, `ACG` com `LM CURSOS`. O número
curto, ao entrar, tira o documento de quem o tinha tomado por engano.

Piso 1 rende só +2 sobre o piso 2 e amplia a superfície de colisão sem retorno —
**parou em 2**. Estável em 4 sementes de embaralhamento (2.014 em todas).

### 13.3. Lição de método

O defeito não apareceu em nenhuma das medições de §10 e §12 porque todas mediam
*agregado* — cobertura e precisão somadas. Ele só apareceu quando a amostra
listou casos **individuais** para conferência humana, e o caso mais óbvio da lista
era um par que qualquer pessoa casaria de olho.

Vale para a próxima rodada: **listar exemplos concretos acha defeito que média
esconde.** A amostra pagou o custo dela antes mesmo de alguém conferir.
