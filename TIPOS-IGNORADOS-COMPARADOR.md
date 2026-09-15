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

## 14. Auditoria manual da pasta de março (03/09/2026)

**Gatilho:** o usuário perguntou se os 248 "sem documento" de 03/2026 no painel são
reais ou erro de comparação. Diferente de todas as medições anteriores, esta foi
feita indo à pasta: varredura de `\larsil-dell\LA26.EXT.BANC` inteiro — 6.209 PDFs,
4.238 fiscais em 21 meses (`_medir/auditar-marco.js`).

Para cada um dos 248, busca em **todos os meses** com regra deliberadamente mais
frouxa que a do motor (bastam 2 sinais). Se essa busca não acha nada, não há papel.

### 14.1. Os 248 são majoritariamente reais

| | |
|---|---|
| sem documento (painel) | 248 |
| **sem candidato em 4.238 PDFs** | **229 (92,3%)** |
| com candidato de 2+ sinais | 19 |
| ...destes, erro real (valor **e** número exatos) | **10** |
| ...coincidência de valor, fornecedor diferente | 9 |

Os 9 restantes o motor acertou em recusar (RAFAEL HAAS × MARANHAO, LUIZ EVALDO ×
LUIZ FELIPE — valor redondo colidindo, o erro que §10.4 mediu).

O número correto de março é **~238, não 248**. Os 229 sem candidato são consistentes
com PROGRESSO §8: a pasta tem 924 arquivos `NNN.DOC` para 628 lançamentos fiscais, e
boa parte do que a planilha lança nunca vira papel arquivado.

### 14.2. Causa (a) — a janela era curta. **Aplicado**

4 documentos da MAQNELSON de março estavam arquivados em **junho** (+3), e 3 casos
em agosto (+5). A janela `[-1,+1,+2]` de §10.9 foi escolhida sobre uma distribuição
que só olhou até +2 — esses casos estavam fora da amostra.

Remedido em jan–jun/2026, com o critério de sempre:

| janela | pares | cobertura | 2º campo | veredito |
|---|---|---|---|---|
| `[-1,+1,+2]` (era) | 2.014 | 65,9% | 91,3% | — |
| **`[-1,+1..+3]`** | **2.026** | **66,3%** | **91,3%** | ✅ aplicada |
| `[-1,+1..+4]` | 2.030 | 66,4% | 91,1% | precisão cai |
| `[-1,+1..+5]` | 2.034 | 66,5% | 91,0% | precisão cai |
| `[-2,-1,+1..+3]` | 2.029 | 66,4% | 91,2% | precisão cai |

**+3 rende 12 pares com a confirmação por 2º campo intacta.** De +4 em diante cada
offset rende ~4 pares e custa 0,18pp — cobertura comprada com par errado, que o
critério de §10 rejeita. Ampliar para trás (−2) também custa: o papel é arquivado
**depois** do lançamento, não antes (a mesma assimetria de §10.9).

Confirmado na rota de produção (`_medir/verificar.js`): 2.026 conferidos, 1.031 sem
documento.

### 14.3. Causa (b) — relatório: um sinal errado anula dois certos

O outro grupo tem **valor exato e número exato**, mas o nome do arquivo traz outro
fornecedor:

    KUHNEN E CHAVES  NF 12040  R$ 1.721,40  ×  017.DOC- 1721,40 ... TORNEARIA . NF 12040
    V M CARNEIRO     NF 1639   R$ 2.331,20  ×  033.DOC- 2331,20 ... VERIDYANA. NFS 1639
    C & F COMERCIO   NF 11027  R$   234,90  ×  003.DOC- 234,90 ... CEF . NF 11027

**Tamanho:** 27 casos em jan–jun/2026 (1 / 3 / 7 / 6 / 6 / 4). Nenhum deles disputa
documento com outro lançamento — os 27 documentos estão livres.

**Por que falha.** `casa()` tem dois caminhos: (número **E** entidade), ou valor
sozinho com veto de janela de 15 dias. Um par com número e valor exatos não se
encaixa no primeiro (a entidade não bate) e cai no segundo, onde o veto de data o
mata — o documento costuma estar na pasta do mês seguinte, >15 dias depois. Ou seja:
**o sinal que falta invalida os dois que sobram.** É o mesmo modo de falha de §13
(piso de dígitos) por outro caminho.

#### A coluna FANTASIA não resolve — medido

A planilha tem `FANTASIA` e ela **já está em uso**: `lancamentoDaPlanilha` funde os
tokens dela com os de `ENTIDADE` desde §10. A cobertura é ótima — 3.011 de 3.057
lançamentos (98,5%), 2.687 deles com fantasia diferente da razão social.

Mas nos 27 casos do grupo (b):

| | |
|---|---|
| FANTASIA vazia | 0 |
| FANTASIA idêntica à ENTIDADE | 2 |
| **FANTASIA diferente, mas não casa com o arquivo** | **25** |
| FANTASIA resolveria (estaria em uso e falhou) | **0** |

A fantasia é o nome comercial do **fornecedor**; o nome no arquivo é outra coisa:

    KUHNEN E CHAVES  fant "KUHNEN E CHAVES LTDA"   arq "TORNEARIA ZAFENATE"
    V M CARNEIRO     fant "FR GUINCHO"             arq "VERIDYANA MARGRAF"
    CELIA CORREIA    fant "HOTEL MENEZES"          arq "GOMES E SAVACINSK"
    INOVA AGRICOLA   fant "INOVA AGRICOLA PECAS"   arq "THYAGO FAUSTINO"
    WERNER & CIA     fant "COMETA PECAS AGRICOLAS" arq "WENER"

São nome do sócio, nome do estabelecimento, ou o nome de quem emitiu o boleto — o
arquivista escreve quem ele reconhece no papel, que não é nenhuma das duas colunas.
**Nenhuma coluna da planilha cobre isso**, porque a informação não está na planilha.

#### A correção que funciona: (número E valor) como terceiro caminho

Se a entidade não pode ser suprida, a saída é não depender dela quando os outros
dois sinais concordam:

| variante | pares | cobertura | sem doc. | 2º campo | contraditos |
|---|---|---|---|---|---|
| produção — (nº E ent) OU valor | 2.026 | 66,3% | 1.031 | 91,3% | 130 |
| **+ (nº E valor) como 3º caminho** | **2.053** | **67,2%** | **1.004** | **91,5%** | 131 |

Sobe cobertura **e** precisão junto — o mesmo padrão sem trade-off de §12 e §13.

Par a par: **27 ganhos, 0 perdas, 1 troca** — e a troca é uma melhora (GM MANUTENÇÃO
NF 28 sai de um recibo do SIDNEY para `031.DOC- ... MUNDI SECURITIZADORA. NFS 28`).
Estável em 4 sementes de embaralhamento (2.053 em todas). A nova via responde por 84
pares, absorvendo 57 que antes vinham do caminho fraco (`valor` cai de 232 para 175)
— ou seja, além dos 27 novos, ela **troca 57 pares frágeis por pares de dois sinais**.

O veto de janela não se aplica a essa via, e é o ponto: ele existe para o par
sustentado só por valor. Com o número junto, a data deixa de ser a única defesa.

**Status: medido e aprovado, não aplicado** — aguardando decisão, já que muda a
regra de casamento e não só uma constante.

## 15. Auditoria de fevereiro (03/09/2026) — e um defeito de indexação

Mesmo método de §14, agora sobre 02/2026 (`_medir/auditar-marco.js 02.2026`), já com
a janela `[-1,+1..+3]` aplicada.

### 15.1. Resultado

| | |
|---|---|
| lançamentos que deveriam ter documento | 479 |
| com documento nesta pasta | 198 |
| com documento em pasta vizinha | 118 |
| **sem documento** | **163** |
| **sem candidato em 4.238 PDFs** | **154 (94,5%)** |
| com candidato de 2+ sinais | 9 |

A proporção repete março (92,3%): **o painel está certo na esmagadora maioria**.
Dos 9 candidatos, 4 são do grupo (b) já descrito (CELIA/GOMES E SAVACINSK NF 157,
INOVA/THYAGO FAUSTINO NF 14555 e 14474), 4 são coincidência de valor que o motor
acertou em recusar (J A FERREIRA × CEST, VINICIUS RC 902671 × RC 901745 — número
diferente, MACPONTA NF 2391 × um *Pedido/Proposta*, que não é a nota), e 1 revelou
um defeito novo.

### 15.2. O defeito: dia/mês trocado no nome joga o documento para outro mês

    .../2026.02.EXTRATOS CONTABILIDADE/SANTANDER/2026.02.09/
        045.DOC- 1824,00-2026.09.02.ARPSEG . RC 902308+ AUT.pdf

O arquivo está **fisicamente na pasta de fevereiro, dia 09**. O nome traz
"2026.09.02" — dia e mês trocados na digitação. Como `contarNaPasta` decidia o mês
por `mesDoNome(e.name) || mesDaPasta(rel)`, **o nome ganhava** e o documento era
indexado em SETEMBRO: 7 meses de distância, fora de qualquer janela. O lançamento
de fevereiro (ARPSEG, R$ 1.824,00, RC 902308 — valor, número **e** fornecedor
batendo) aparecia como "sem documento" com o papel arquivado no lugar certo.

Tamanho do problema em todo o arquivo permanente:

| | |
|---|---|
| arquivos fiscais indexados | 4.238 |
| **mês do nome ≠ mês da pasta** | **144** |
| ...com dia/mês visivelmente trocado | 10 |
| ...a mais de 3 meses de distância (fora de qualquer janela) | **37** |

A cauda é longa: 34 arquivos a −12 meses (ano digitado errado), 5 a +7, 2 a +10.

### 15.3. Correção aplicada — a pasta tem precedência

A subpasta é criada pelo **processo de arquivamento**; o nome é digitado à mão pelo
arquivista — a mesma fonte de erro que §12 mediu no emitente e §13 no número. Quando
discordam, a pasta é a evidência mais forte.

`mesDoDocumento(nome, rel)` = `mesDaPasta(rel) || mesDoNome(nome)`, usada nos **dois**
pontos de decisão de `comparar-notas.js` (varredura do disco e leitura do relatório).

| variante | pares | cobertura | 2º campo |
|---|---|---|---|
| nome tem precedência (era) | 2.026 | 66,3% | 91,3% |
| **pasta tem precedência** | **2.031** | **66,4%** | **91,3%** |
| nome + (nº E valor) de §14.3 | 2.053 | 67,2% | 91,5% |
| pasta + (nº E valor) | 2.058 | 67,3% | 91,5% |

+5 pares com a confirmação por 2º campo **inalterada**. Confirmado na rota de
produção (`_medir/verificar.js`): 2.031 conferidos, 1.026 sem documento. Fevereiro:
163 → 162; junho: 176 → 172.

Os dois ganhos são independentes e somam: com a via (nº E valor) de §14.3 ainda
pendente de decisão, o total iria a 2.058 (67,3%).

> **Nota para quem for reprocessar:** `process-folder.js` continua decidindo o mês
> pelo nome na hora de GRAVAR. Esta correção age na leitura, então vale para os
> relatórios já gravados; alinhar o gravador é trabalho separado e ainda em aberto.

## 16. A correção da data na EXTRAÇÃO (03/09/2026)

§15 corrigiu a **leitura** (`comparar-notas.js`), mas o gravador continuava
decidindo a data pelo nome — os relatórios novos nasceriam com o mesmo defeito.
Esta seção fecha a outra ponta.

### 16.1. Por que "a pasta sempre ganha" seria errado aqui

A leitura só precisa do MÊS; o gravador precisa do DIA, e aí a resposta muda.
Medido em `_medir/dia-nome-vs-pasta.js` sobre os 3.997 PDFs que têm data no nome
**e** na subpasta:

| | |
|---|---|
| data idêntica nos dois | 3.209 |
| **dia difere, mês igual** | **644** |
| mês difere | 144 |

Os 644 são o caso comum: o documento é de dia 06 e foi arquivado dia 05. **O nome
tem o dia certo** — é a data do documento, que é o que a conferência quer; a pasta
é a data de arquivamento. Trocar tudo pela pasta perderia esses 644 dias.

### 16.2. As 144 divergências de mês, por causa

`_medir/classificar-divergencia.js`:

| causa | n | veredito |
|---|---|---|
| dia/mês trocado (`2026.09.02` na pasta `02.09`) | 10 | erro de digitação → corrigir |
| **ano errado**, mês igual | 34 | erro de digitação → corrigir |
| documento de mês anterior, ≤3 meses | 63 | **legítimo** → não mexer |
| resto (vencimento futuro, conta antiga) | 37 | ambíguo → não mexer |

**63 dos 144 são conta antiga paga agora** — CEMIG de dezembro arquivada em
janeiro, apólice HDI de outubro arquivada em janeiro. Nesses o nome está certo e a
pasta é só quando o papel chegou. Uma regra cega estragaria os 63 para consertar 44.

### 16.3. A correção: cirúrgica, só sobre assinatura de erro

`consertarDataPelaPasta(diaNome, diaPasta)` em `process-folder.js`. O nome mantém a
precedência; a subpasta só intervém quando **prova** que houve engano de digitação:

- **(a)** desinverter dia/mês no nome dá exatamente a data da pasta → usa a pasta;
- **(b)** o mês do nome bate com o da pasta e só o **ano** difere → corrige só o ano,
  **preservando o dia do nome**.

A regra (b) não exige o dia idêntico, e isso importa: a ESSOR `2505` é uma parcela
mensal arquivada com "2025." de janeiro a maio de 2026 e com "2026." em junho — em
março o nome diz dia 06 e a pasta é dia 05. Exigir dia igual deixaria esse caso
escapar (foi o que a primeira versão fez: 43 de 44).

Toda correção sai em log (`data corrigida pela subpasta: "..." 02.09.2026 →
09.02.2026`), para o erro de digitação ficar visível a quem arquiva.

### 16.4. Verificação

`_medir/testar-conserto.js` roda a função extraída do `process-folder.js` real
(não uma cópia) contra os 4.238 PDFs:

| | |
|---|---|
| **corrigidos** | **44** |
| intocados, mês difere (legítimos) | 100 |
| intocados, só o dia difere | 644 |

As duas garantias valem: corrige as 44 com assinatura de erro, e não toca em
nenhum dos 744 casos em que o nome está certo.

> **Efeito prático:** vale para o que for processado daqui em diante. Os relatórios
> já gravados continuam com a data antiga — a correção de §15, que age na leitura,
> é que cobre esses. As duas juntas fecham as duas pontas.

### 16.5. As duas garantias, verificadas

Pedido explícito do usuário: corrigir **sem renomear arquivo** e **sem prejudicar a
acurácia geral**. As duas foram verificadas, não presumidas.

**(1) Nenhum arquivo é tocado.** `process-folder.js` não tem nenhuma chamada de
escrita no sistema de arquivos — nada de `rename`, `unlink`, `writeFile` ou
`copyFile`. O conserto age só sobre a variável `pdf.day` em memória, que decide sob
qual PERIODO a linha é gravada no banco. O PDF no arquivo permanente continua com o
nome que o arquivista deu, inclusive a data errada; quem foi ao disco procurar o
papel encontra exatamente o que sempre esteve lá.

**(2) A acurácia não muda.** `_medir/acuracia-conserto.js` reindexa os 4.238 PDFs
com a data já consertada e roda o pareamento completo:

| | pares | cobertura | sem doc. | 2º campo | contraditos |
|---|---|---|---|---|---|
| hoje (leitura §15 aplicada) | 2.031 | 66,4% | 1.026 | 91,3% | 130 |
| com o conserto do gravador | 2.031 | 66,4% | 1.026 | 91,3% | 130 |

**Idêntico, período a período.** E é o resultado correto: os 100 documentos que
mudam de mês são exatamente aqueles que §15 já estava reposicionando na leitura. As
duas correções concordam — a de §15 conserta o que está gravado, a de §16 evita que
o defeito volte a nascer. Nenhuma das duas inventa casamento novo.

O ganho de §16 não aparece nesta tabela por construção: ele é sobre os relatórios
**futuros**, que sem ele nasceriam com o PERIODO errado e dependeriam da correção de
leitura para sempre.

## 17. A via (número E valor) — aplicada (03/09/2026)

A regra medida em §14.3 entrou em produção, em `routes/_pareamento.js` → `casa()`.

```js
if (numeroBate(l, d) && entidadeBate(l, d))
    return valorBate(l, d) ? 'numero+entidade+valor' : 'numero+entidade';
if (numeroBate(l, d) && valorBate(l, d))       // <- a via nova
    return 'numero+valor';
if (valorBate(l, d) && dentroDaJanela(l, d))
    return entidadeBate(l, d) ? 'valor+entidade' : 'valor';
```

O veto de janela não se aplica a ela de propósito: `JANELA_DIAS` existe para o par
sustentado **só** por valor. Com o número junto, a data deixa de ser a única defesa.

### Confirmado na rota de produção

`_medir/verificar.js` (caminho real, não a reimplementação do harness):

| período | conferidos | sem documento |
|---|---|---|
| 01/2026 | 329 | 147 |
| 02/2026 | 320 | 159 |
| 03/2026 | 391 | 237 |
| 04/2026 | 316 | 166 |
| 05/2026 | 374 | 122 |
| 06/2026 | 328 | 168 |
| **total** | **2.058 (67,3%)** | **999** |

Estável em 4 sementes de embaralhamento (2.058 em todas), 27 ganhos e **0 perdas**.

### O efeito acumulado das quatro correções desta rodada

| estado | pares | cobertura | 2º campo |
|---|---|---|---|
| antes de §14 (janela `[-1,+1,+2]`) | 2.014 | 65,9% | 91,3% |
| §14 — janela `[-1,+1..+3]` | 2.026 | 66,3% | 91,3% |
| §15 — pasta decide o mês na leitura | 2.031 | 66,4% | 91,3% |
| §16 — conserto da data na extração | 2.031 | 66,4% | 91,3% |
| **§17 — via (número E valor)** | **2.058** | **67,3%** | **91,5%** |

**+44 pares e +0,2pp de precisão**, sem uma única perda. Todas as quatro passaram no
mesmo critério: cobertura sobe e a confirmação por 2º campo não cai.

### Reauditoria de março

Rodando `_medir/auditar-marco.js 03.2026` de novo, agora com tudo aplicado:

| | antes | depois |
|---|---|---|
| sem documento | 248 | **237** |
| ...com candidato na pasta (suspeitos) | 19 | **8** |

Os 8 restantes são coincidência de valor com fornecedor diferente — o motor está
certo em recusá-los. **Março não tem mais nenhum falso "sem documento" conhecido.**

## 18. O que ainda dá para ganhar — medido (03/09/2026)

Pergunta do usuário depois de §17: existe mais alguma coisa que aumente a acurácia?
Medido, não estimado. O diagnóstico pós-§17 (`_medir/diagnostico.js`) divide os 999
"sem documento" em:

| causa | n |
|---|---|
| a regra recusou, tendo candidato óbvio | 22 |
| perdeu a disputa pelo documento | 1 |
| **sem candidato óbvio** | **976** |

### 18.1. As 22 recusas rendem quase nada

Lendo caso a caso aparecem dois padrões novos, ambos medidos
(`_medir/proximos-ganhos.js`):

**(A) número truncado no nome** — o arquivista corta o último dígito:

    BOBIG    planilha NF 21650  × arquivo "NF 2165"
    ELEKTRO  planilha NF 445181 × arquivo "FAT 44518"
    LOCALIZA planilha NF 104788 × arquivo "FAT 10478"

**(B) NF de 1 dígito**, ainda barrada por `MIN_DIGITOS_NUM = 2` (DARCI, "NFS 2").

| variante | pares | cobertura | 2º campo | Δ |
|---|---|---|---|---|
| produção (§17) | 2.058 | 67,3% | 91,5% | — |
| (A) prefixo truncado | 2.059 | 67,4% | 91,5% | +1 |
| (B) piso de 1 dígito | 2.060 | 67,4% | 91,5% | +2 |
| (A)+(B) | 2.061 | 67,4% | 91,5% | +3 |

**+3 pares no total.** Passam no critério (a precisão não cai), mas o ganho não paga
a superfície de colisão que um prefixo de número abre. Ficam registradas como
medidas e **não aplicadas** — o oposto de §13, onde o mesmo tipo de mudança rendia
+32.

**(C) abrir a janela do caminho fraco** foi remedida e continua reprovada, agora com
margem maior: 30 dias traz +69 pares mas derruba a precisão 2,36pp; 60 dias, +135
pares por −4,95pp. É cobertura comprada com par errado.

### 18.2. O teto é estrutural, não de regra

`_medir/teto.js` pergunta, para cada um dos 999, se existe **algum** PDF no arquivo
inteiro (4.238 documentos, todos os meses) com sinal concordante:

| | n | % |
|---|---|---|
| com 2+ sinais em algum PDF | 32 | 3,2% |
| ...documento livre | 30 | |
| ...documento já usado por outro lançamento | 2 | |
| com 1 sinal só (fraco demais para casar) | 833 | 83,4% |
| **nenhum sinal em 4.238 PDFs** | **134** | 13,4% |

**Só 30 lançamentos têm documento livre com dois sinais concordando.** Esse é o teto
real do que qualquer regra nova poderia recuperar: 30 pares, 1,0 pp de cobertura.

Os 833 de um sinal só são o caso que §10.4 já mediu: casar por valor sozinho erra em
25% das vezes. Recuperá-los exigiria aceitar o caminho que a medição reprovou.

### 18.3. Onde está o ganho de verdade

Não é no motor. As três frentes, em ordem de tamanho:

1. **O papel não está no arquivo** (§8): a pasta tem 924 `NNN.DOC` para 628
   lançamentos fiscais em março. Nenhuma regra inventa documento que não existe.
   Os 134 sem sinal nenhum somam R$ 150.758 — e 84 deles são de menos de R$ 100,
   coerente com "despesa miúda não é arquivada".
2. **A qualidade do nome do arquivo** — número truncado, fornecedor trocado
   ("TORNEARIA" por KUHNEN), data com dia/mês invertido (§16). Todos os defeitos
   desta rodada nasceram de digitação manual. Um campo obrigatório de NF no momento
   do arquivamento vale mais que qualquer heurística.
3. **Reprocessar os períodos** para a chave de acesso e a linha digitável (§10, §11)
   passarem a existir nos relatórios. Continua pendente desde 14/08 — é a única
   frente que traz evidência *nova* em vez de espremer a existente.

> **Conclusão honesta:** o motor está perto do teto do que os dados atuais permitem.
> Foram +44 pares nesta rodada (2.014 → 2.058) sem perder precisão; o que resta
> mensurável são 30 pares. O próximo salto real depende de dado novo — reprocessamento
> ou disciplina de arquivamento —, não de regra nova.

## 19. O extrator como fonte primária (03/09/2026)

**Correção de premissa, apontada pelo usuário:** todas as informações do documento
(exceto a data) deviam sair primariamente do EXTRATOR, e só depois do nome do
arquivo. O código fazia o contrário — `enriquecerComOcr` deixava o nome mandar e o
extrator só preenchia buraco.

Isso reenquadra §18: eu havia concluído "o teto é estrutural", mas medindo a fonte
errada. O piso de 1 dígito (§18.1, a variante B) também foi aplicado aqui.

### 19.1. Com que frequência as duas fontes discordam

Nos 4.228 documentos dos 6 períodos:

| | |
|---|---|
| número no nome | 3.681 |
| número no extrator | 2.414 |
| nos dois | 2.149 |
| ...idênticos | 1.626 |
| **...diferentes** | **523** |
| só no extrator | 265 |

523 documentos com duas respostas para "qual é o número da nota".

### 19.2. Quem acerta quando discordam

Contando, nos pares já casados, qual dos dois números bate com a planilha:

| | |
|---|---|
| o número do NOME acerta | 231 |
| o número do EXTRATOR acerta | 44 |

À primeira vista o nome ganha — mas essa contagem é **enviesada**: ela só enxerga os
pares que o motor atual conseguiu casar, e o motor atual casa pelo nome. É a
pergunta errada. A pergunta certa é o que muda quando se inverte.

### 19.3. O que a inversão faz, par a par

| | nome primeiro | extrator primeiro |
|---|---|---|
| pares | 2.060 | 2.059 |
| 2º campo | 91,50% | **91,84%** |
| contraditos por CNPJ | 131 | **125** |
| pares fracos | 172 | **164** |

−1 par líquido, mas **10 ganhos, 11 perdas e 50 trocas**. As trocas são o que
importa, e elas são majoritariamente melhora — medindo cada uma pela força do par
com evidência bruta (`_medir/qualidade-trocas.js`):

| | |
|---|---|
| documento novo é MAIS forte | **32** |
| documento novo é MENOS forte | 4 |
| empate | 14 |

O caso limpo é o **BIOS NETWORKS**: uma série de faturas de valor idêntico
(R$ 75, R$ 95, R$ 125) em que só o número distingue uma da outra.

    planilha NF 245924  nome "FT 245923"  extrator 245924   <- nome erra por 1
    planilha NF 252287  nome "FT 245650"  extrator 252287   <- nome traz outra nota
    planilha NF 252302  nome "FT 245719"  extrator 252302

O motor casava a fatura errada, com fornecedor e valor certos — erro invisível para
qualquer métrica agregada. Com o extrator na frente, cada uma cai na sua.

### 19.4. As perdas, e como foram recuperadas

Das 11 perdas, 6 eram pares fracos (1 sinal) e 5 eram fortes. As fortes tinham causa
comum: **DARCI FERREIRA "NFS 2"**, **NASCIMENTO** — o extrator sobrescrevia com um
número pior e o do nome, que acertava, era descartado.

A correção não foi escolher uma fonte, foi **parar de descartar a outra**:

- o número do nome vira `numeroAlt`, que `numeroBate` já testava;
- o valor do nome vira `valorAlt`, e `valorBate` passa a aceitar os dois. As duas
  leituras divergem **legitimamente** numa parcela: o nome traz o valor PAGO
  (copiado do comprovante) e o extrator o valor da NOTA.

| variante | pares | cobertura | 2º campo |
|---|---|---|---|
| nome primeiro (era) | 2.060 | 67,4% | 91,50% |
| extrator primeiro, descartando o nome | 2.059 | 67,4% | 91,84% |
| **extrator primeiro + nome como alternativa** | **2.066** | **67,6%** | 91,48% |

### 19.5. Resultado na rota de produção

`_medir/verificar.js`: **2.068 conferidos (67,6%), 989 sem documento.**

| período | conferidos | sem documento |
|---|---|---|
| 01/2026 | 330 | 146 |
| 02/2026 | 322 | 157 |
| 03/2026 | 391 | 237 |
| 04/2026 | 321 | 161 |
| 05/2026 | 376 | 120 |
| 06/2026 | 328 | 168 |

Estável em 4 sementes de embaralhamento. **A data ficou de fora da inversão** de
propósito: ela não descreve o documento, posiciona-o no mês certo para a busca
(§15/§16) — `dtEmissao` do OCR é a data de emissão, que é outra coisa.

### 19.6. Acumulado da rodada

| estado | pares | cobertura | 2º campo |
|---|---|---|---|
| início (janela `[-1,+1,+2]`) | 2.014 | 65,9% | 91,3% |
| §14 janela `[-1,+1..+3]` | 2.026 | 66,3% | 91,3% |
| §15 pasta decide o mês | 2.031 | 66,4% | 91,3% |
| §17 via (número E valor) | 2.058 | 67,3% | 91,5% |
| §18 piso de 1 dígito | 2.060 | 67,4% | 91,5% |
| **§19 extrator como fonte primária** | **2.068** | **67,6%** | 91,5% |

**+54 pares na rodada**, e — o que não aparece na tabela — 32 pares que já existiam
passaram a apontar para o documento certo.

> **Correção ao §18:** a conclusão "o motor está perto do teto, restam 30 pares"
> estava certa para a fonte que ele lia. Com o extrator na frente, o teto medido
> subiu para 49 lançamentos com documento livre e 2+ sinais. A lição de §13 se
> repete: a métrica agregada não viu o erro do BIOS NETWORKS porque ele não muda
> contagem nenhuma — troca o documento, não o número de pares.

---

## 20. O veto de data nas pastas vizinhas (08/09/2026)

**Origem:** o usuário mostrou o painel de 02/2026 com `MACPONTA NF 2391
R$ 1.320.000` em "OS QUE FALTAM", e informou que o PDF estava em
`W:\2026.01...\SANTANDER\2026.01.19`. Insistiu duas vezes que o número não mudava —
e estava certo.

### 20.1. Erro meu de método, antes do diagnóstico

Afirmei que o par funcionava e que o print estava velho. **Estava errado.** Meu
script de teste montava o documento só com `documentoDoArquivo`, sem
`enriquecerComOcr`, e o lançamento com `dtEmissao: null`. Sem os dois o documento
fica **sem data**, e `dentroDaJanela` devolve `true` por ausência de evidência: o par
passava no teste e falhava na rota.

O veto de janela é o único ponto do motor que depende de um campo que **só o OCR
preenche**. Um harness que pula o enriquecimento não é o motor — é um motor mais
permissivo, e erra sempre para o mesmo lado. `_medir/_t5.js` ganhou um aviso no
cabeçalho; para conferir um caso como o painel o vê, usar `_medir/_rota.js` (chama o
handler real) ou `_medir/_variantes.js` (pipeline completo).

### 20.2. A causa real

| passo | valor |
|---|---|
| nome do arquivo | `031.DOC- 1320000,00-2026.01-19- MACPONTA.pdf` |
| `dataDoNome` | `null` — o nome traz `2026.01-19`, com **hífen** no lugar do ponto |
| data que o OCR preenche | 19/01/2026 |
| lançamento | 11/02/2026 |
| distância | **18 dias** |
| via do par | `valor+entidade` (nenhum dos dois PDFs traz o número da NF) |
| `JANELA_DIAS` | 15 → **18 > 15, vetado** |

### 20.3. As variantes medidas (jan–jun/2026, pipeline completo)

| variante | pares | 2º campo | fracos | MACPONTA |
|---|---|---|---|---|
| A) atual, veto de 15d | 2.072 | 91,5% | 177 | não acha |
| B) janela 20d | 2.095 | 90,8% | 193 | acha |
| C) janela 30d | 2.155 | 89,0% | 237 | acha |
| E) sem janela nenhuma | 2.301 | **83,7%** | 374 | acha |
| H) sem veto se a entidade bate | 2.106 | 91,7% | 175 | acha |

Alargar a janela como número (B–E) compra cobertura com precisão — o critério de §10
rejeita. H domina: mais pares **e** mais precisão, e os 37 ganhos têm todos **valor
exato** (0 parcelas, 0 divergentes), todos de força 2.

### 20.4. Mas H troca 6 pares por piores — e a pasta explica por quê

H parece aprovado pelo agregado, e não está: perde 3 pares e **troca 15 de
documento, 6 deles para pior** (força 3 → 2). Indo aos arquivos no disco, o desenho é
sempre o mesmo:

| lançamento | documento de A (f3) | documento de H (f2) |
|---|---|---|
| LOCALIZA NF 315637 | `FAT 315637` em **04.2026** | `FAT 307515` em 03.2026 |
| ALGAR RCB 543346 | `RCB 543346` em **06.2026** | `RC 730287` em 05.2026 |
| AGROLUB NF 43205 | `NF43205` em 04.2026 (dia 09) | `NF 42942` em 04.2026 (dia 29) |

O documento certo — número idêntico — está na pasta **+1**; o pior está no mês
corrente. Como `conferirPeriodo` só manda os **pendentes** para a passada vizinha,
afrouxar o veto no mês faz o lançamento fechar cedo com o documento pior, e o melhor
**fica livre, sem dono nenhum** (confirmado: em todos os 5 casos ninguém o pegou).

Testei três formas de corrigir pela ordem — relaxados por último (K), relaxado nunca
desbanca estrito (L), relaxamento só para quem ficaria sem par (M). **As três dão o
mesmo resultado de H**, porque o problema não é a ordem dentro de uma passada: é a
separação entre as duas passadas.

### 20.5. A regra aplicada

Relaxar o veto **só na passada das pastas vizinhas**. Ali a distância de data é
estrutural — o papel é arquivado quando chega, a planilha lança no pagamento — então
a data diz pouco, e valor + entidade já são dois sinais. O mês corrente segue com a
janela de 15 dias, intacto.

| variante | pares | 2º campo | piora | MACPONTA |
|---|---|---|---|---|
| A) atual | 2.072 | 91,5% | — | não acha |
| H) relaxa em toda passada | 2.106 | 91,7% | **6** | acha |
| **N) relaxa só nas vizinhas** | **2.104** | **91,7%** | **0** | acha |

Estável em 3 sementes de embaralhamento (2.104 nas três). Custa 3 pares, todos de
valor muito divergente casados só por número+entidade — AGRIPONTA NF 1650 R$ 6.800 ×
documento de R$ 3.084,36; COMERCIAL IVAIPORÁ NF 141920 R$ 2.396,70 × documento de
R$ 34,06.

`dentroDaJanela(l, d, entidadeDispensa)` e `casa(l, d, entidadeDispensaJanela)`
ganharam o parâmetro; `conferirPeriodo` passa `true` só na chamada de `parear` das
vizinhas.

### 20.6. Resultado na rota de produção

| período | conferidos | sem documento |
|---|---|---|
| 01/2026 | 334 | 142 |
| 02/2026 | 325 | **154** (era 157) |
| 03/2026 | 399 | 229 |
| 04/2026 | 326 | 156 |
| 05/2026 | 386 | 110 |
| 06/2026 | 334 | 162 |

Total **2.110 pares** por `_medir/_variantes.js`, precisão 91,5%. A MACPONTA saiu da
lista de faltantes de 02/2026 — era o maior valor dela.

### 20.7. Também nesta rodada (aditivo, não muda par nenhum)

Duas mudanças no lado dos **documentos**, medidas com o invariante de que
`pares`/`2º campo`/`fracos` não podem mudar:

- **Maços de arquivamento** (`maco` em `documentoDoArquivo`, agrupamento no fim de
  `parear`): papéis do mesmo pagamento — mesmo prefixo `NNN`, mesma pasta-dia e
  **mesmo valor** — deixam de contar como documento órfão. O valor é obrigatório: sem
  ele, o maço 059 de 04/2026 juntava quatro apólices BRADESCO de valores diferentes
  (R$ 780,43 / 1.363,63 / 570,17 / 684,63), que são pagamentos distintos. Universo
  real: dos 4.290 documentos fiscais, **20 maços com 2+ documentos, só 7 com 2+ de
  mesmo valor** — é raro.
- **Empates marcados**: quando 2+ documentos disputam o mesmo lançamento com força
  igual, o par recebe `empatado` e vai para uma lista de conferência humana. Parcelas
  ficam de fora reusando `razaoParcela` (50 → 35 empates em 02/2026: SAVANA NF 162111
  de R$ 16.000 tinha 4 documentos de R$ 4.000, que é carnê, não ambiguidade).

Não automatizei a escolha entre os empatados, e isso foi medido: preferir o documento
"sem marcador de acessório" (`+ AUT`, `+ PV`, PEDIDO — 903 de 4.290 arquivos)
**reprova**, porque `+ AUT` quer dizer "nota **mais** autorização anexa". Dos 61 casos
com alternativa, os pares existentes estavam certos e as alternativas eram colisão de
valor redondo (R$ 1.500 da GRÁFICA EXECUTIVA).

### 20.8. Outras hipóteses medidas e reprovadas

| hipótese | resultado | veredito |
|---|---|---|
| Ordem de compra como chave (`LANC_ORIG` × `Ordem de Compra` do OCR) | 88,6% dos lançamentos e 57,6% dos documentos têm OC | **reprovada** — a OC é agrupador de compra, 1 OC → N notas: OC 901783 apontava 4 NFs para o mesmo PDF de R$ 21.508,13 |
| Ignorar o número do OCR quando é igual à OC (74 casos nocivos: SANESUL, CEMIG, COPASA, ELEKTRO) | 2.079 → 2.078 pares, precisão idêntica | **reprovada por indiferença** — `casa()` nunca usa o número sozinho e `numeroAlt` guarda o do nome |
| Regra dedicada para "gêmeos" (mesmo dia, prefixo e valor) | 7 grupos em toda a base | **reprovada por volume** |
| `Natureza da operação` do OCR como sinal de devolução | 0 de 103 valores com DEVOL/RETORN/ESTORN | **inexistente** — nem no OCR nem na planilha (`NAT_OP` só tem COMPRA/AQUISIÇÃO) |

### 20.9. Nota operacional

O servidor carrega os módulos na inicialização: **reiniciar** para a mudança aparecer
na tela. E `TTL_PASTA_MS = 60s` — um PDF arquivado agora leva até um minuto para
entrar na contagem.

---

## 21. Revisão de código do extrator (08/09/2026) — dois defeitos na leitura do nome

Revisão dirigida de `_pareamento.js` e `comparar-notas.js`, procurando defeito de
código e não regra a ajustar. Os dois achados estão na **extração a partir do nome
do arquivo** — a camada mais antiga do módulo, que nunca tinha sido auditada contra
o acervo inteiro.

### 21.1. A data só aceitava ponto como separador — 67 documentos sem data

`dataDoNome` casava `YYYY.MM.DD` e `DD.MM.YYYY`, com ponto nos dois separadores.
Quem arquiva digita à mão e usa hífen também. Varrendo os 4.238 documentos fiscais
de jan–jun/2026, **241 (5,7%) não tinham data legível**, assim distribuídos:

| padrão | n | exemplo |
|---|---|---|
| sem data alguma no nome | 163 | `049.DOC- 23053,79.MARCOS CONSORCIOS CAIXA.pdf` |
| `YYYY-MM-DD` (tudo hífen) | 63 | `014.DOC- 43844,14-2026-01-07-ERICLEIA...` |
| só ano.mês, sem dia | 11 | `017.DOC- 1484,46-2026.02.GV CLINICAS...` |
| misto `YYYY.MM-DD` | 2 | `031.DOC- 1320000,00-2026.01-19- MACPONTA.pdf` |
| `DD-MM-YYYY` (tudo hífen) | 2 | `...Extrato-Completo-001153-167-_21-07-2026.pdf` |

**Ficar sem data não é neutro.** `distanciaDias` devolve `null` e `dentroDaJanela`
então retorna `true` incondicionalmente: o veto de 15 dias **desliga em silêncio**
justamente para esses arquivos. Era o caso dos dois papéis do maço MACPONTA
(R$ 1,32 milhão), que podiam casar por valor com lançamento de qualquer mês.

Aceitar `[.\-]` nos dois separadores recupera os 67 com data em hífen. Os 163 sem
data nenhuma não têm conserto aqui — para eles a data segue vindo do OCR
(`dtEmissao`) ou fica nula.

### 21.2. Valor com milhar e sem centavos lia truncado — defensivo, 0 casos hoje

A terceira alternativa de `valorDoNome` era `(\d+)`, que **para no primeiro ponto**:

    005.DOC- 12.500 -2026.03.10.ACME.pdf       →     12   (esperado 12.500)
    006.DOC- 1.320.000 -2026.03.10.X.pdf       →      1   (esperado 1.320.000)

O estrago não seria perder o par, seria **casar o errado**: o documento entra no
pareamento com valor falso e pequeno e colide com qualquer lançamento daquele
valor. Por ser pequeno, escaparia também de `divergenciasDeValor`, que ordena pela
diferença absoluta — o par errado ficaria invisível nas duas telas.

**Medido: nenhum dos 4.238 documentos usa esse formato.** O conserto move zero par
hoje e fica pelo custo assimétrico (uma alternativa de regex contra um modo de
falha silencioso). Registrado aqui para não ser "otimizado" de volta por parecer
código morto.

### 21.3. Efeito medido — jan–jun/2026, caminho de produção

Medido com `_medir/verificar-cache.js` (novo): mesmo caminho de `verificar.js`
— `documentoDoArquivo` + `enriquecerComOcr` + `conferirPeriodo` — mas lendo o
índice do OCR de `.cache/ocr.json`, para medir sem depender do SQL.

| | antes | depois |
|---|---|---|
| conferidos | 2.100 | **2.099** |
| confirmados por 2º campo | 1.927 (91,8%) | **1.927 (91,8%)** |
| fracos (1 sinal) | 173 | **172** |
| via `valor` (a mais frágil) | 173 | **172** |

O total cai 1, e **o par perdido é falso**:

    06.2026  NF 886  ATRIO EMPREENDIMENTOS HOTELEIROS  R$ 140
        × 007.DOC- 140,00-2026-08-28- BET CARGAS- NF73903-AUT.pdf   via=valor  força=1

ATRIO (hotelaria) casada com documento da BET CARGAS, NF 886 × NF 73903, unidas só
pelo valor redondo de R$ 140. Com a data `2026-08-28` agora legível, a distância é
de **74 dias** e o veto de janela — que existe exatamente para isso — recusa o par.

Outros **dois pares trocaram de documento, ambos para melhor**, pelo desempate por
distância de data que só agora enxerga essas datas:

| lançamento | antes | depois |
|---|---|---|
| COMERCIAL IVAIPORÃ NF 138750 (força 3) | doc de 20/05 | **doc de 15/05** |
| MONT KOYA (força 2, lanç. de 04/2026) | doc de 29/06 | **doc de 30/05** |

Nenhum par de força 2+ foi perdido. É o mesmo critério de §10: cobertura que cai
trocando par fraco por recusa correta não é perda.

---

## 22. Os três pontos restantes da revisão (08/09/2026)

Continuação de §21. Dos três, **um era defeito real, um não existia, e um era
fragilidade sem dano medido**. O que mudou a conclusão em dois deles foi medir
antes de consertar.

### 22.1. A data do pareamento vinha só do nome — corrigido

§15 corrigiu o **mês** para vir da subpasta (`mesDoDocumento`, na rota), mas a
**data** usada pelo pareamento continuou saindo só do nome. O veto de janela
rodava contra uma data que a própria rota já sabia estar errada.

O conserto **não** é inverter a precedência, e a medição é que diz por quê. Dos
4.238 documentos, todos têm data na pasta e 4.064 no nome; os 794 em que discordam
são duas populações que não se tocam:

| \|nome − pasta\| | n | leitura |
|---|---|---|
| 0-2 dias | 616 | **legítimo** — a pasta é o dia do pagamento, o nome é a data do documento |
| 3-30 dias | 81 | legítimo, prazo de boleto |
| 31-60 dias | 13 | — |
| 61-90 dias | 7 | — |
| 91+ dias | 77 | **erro de digitação**: ano trocado (nome `2025.01.05` na pasta `2026.01.05`), dia e mês idênticos |

Então `dataDoDocumento` usa **o nome, com a pasta como reserva e como corretor**:
a pasta entra quando o nome não traz data (174 documentos, que hoje ficam sem data
e portanto **sem veto de janela**) e quando a discordância passa de 60 dias (os 77
do ano trocado). O limiar de 60 fica no vale vazio entre as duas populações.

Inverter a precedência inteira pioraria ~700 casos para consertar 77.

### 22.2. O `Math.abs` do valor NÃO é bug — hipótese reprovada

A revisão levantou que `lancamentoDaPlanilha` faz `Math.abs(valor)`, e que um
estorno negativo casaria com uma despesa positiva. **Medido: 3.034 dos 3.057
lançamentos (99,2%) são negativos.** Não é estorno — é a convenção de sinal da
planilha, em que despesa a pagar é lançada com sinal negativo enquanto o documento
traz o valor absoluto. Os 23 positivos são todos lançamento de conta bancária
(`CC.LAR.SAN.PR.8875.CORRENTE`), não fornecedor.

Tirar o `abs` zeraria o pareamento. Comentário deixado no código para o próximo
que passar por ali não "consertar" isso.

### 22.3. O índice do OCR era chaveado só pelo nome — corrigido

`ocrPorArquivo` era indexado por `arquivoBase(arquivo)`, e a rota consultava
`ocrPorArquivo[a.nome]`. Dois PDFs homônimos em pastas diferentes recebiam o mesmo
OCR — e como o extrator hoje tem **precedência** sobre o nome (§19), um OCR trocado
sobrescreve número e valor bons.

Medido: **6 nomes em 16 documentos (0,4%)**, todos documento recorrente arquivado
todo mês — seguro prestamista da SICRED, endosso HDI, tarifa do Santander. Nesses
o OCR compartilhado até é o certo, mas por sorte, não por construção.

O índice passa a ter **duas chaves**: `pasta|arquivo` (precisa) e o nome sozinho
(reserva). `ocrDoDocumento` prefere a composta. A reserva mantém compatibilidade
com CSV gravado antes da coluna `pasta` — verificado: com índice no esquema antigo
o resultado é idêntico ao anterior à mudança.

### 22.4. Efeito acumulado — jan–jun/2026, caminho de produção

| | §21 (antes) | +22.1 | +22.3 (final) |
|---|---|---|---|
| conferidos | 2.099 | 2.092 | **2.091** |
| confirmados por 2º campo | 1.927 (91,8%) | 1.927 (92,1%) | **1.925 (92,1%)** |
| fracos (1 sinal) | 173 | 165 | **166** |

A cobertura cai 8 e **a precisão sobe 0,3pp**. As perdas são quase todas de pares
de força 1 que a inspeção mostra falsos — "7 ESTETICA AUTOMOTIVA" × documento da
IMOBILIARIA, "M D SABOIA BORRACHARIA" × `pgto EVA - LARSIL`, "POSTO ARCO IRIS" ×
documento da EDINA: nenhuma entidade em comum, só valor redondo coincidindo. É o
critério de §10 — cobertura comprada com par errado não conta.

Duas trocas de 22.3 são melhora direta: **FIG TELECOM NF 631501 (R$ 139,90)** sai
de um documento de R$ 119,90 para o de R$ 139,90, valor exato; **ADS
DISTRIBUIDORA** sai de um documento de 29/06 para o de 29/05, mais perto do
lançamento.

### 22.5. Achado colateral: a ordem das duas passadas (§18) continua custando

Ao investigar as trocas de 22.1 reencontramos o defeito que §18 já descreve, agora
com um caso limpo. **LOCALIZA FLEET NF 315637, R$ 68.748,78, lançamento de
03/2026:**

| documento | pasta | sinais | força |
|---|---|---|---|
| `063.DOC- ... FAT 315637 + BOL.pdf` | 04/2026 | número + entidade + valor | **3** |
| `060.DOC- ... FAT 307515.pdf` | 03/2026 | entidade + valor | 2 |

O documento **certo** (número idêntico) está na pasta vizinha; o pior, no mês
corrente. Como a passada do mês roda primeiro e só os pendentes vão às vizinhas, o
lançamento fecha com o de força 2 e o de força 3 nunca é considerado. Verificado:
`parear` com os dois candidatos na MESMA passada escolhe o certo — a ordenação por
força já resolve, o que falta é ela poder ver os dois.

Isso **não** foi consertado aqui: é mudança de desenho (uma passada só, com os
documentos do mês e das vizinhas juntos e o offset como desempate), e precisa de
medição própria — o risco é um documento do mês ser consumido por lançamento de
outro mês, que é exatamente o que a separação em duas passadas protege (§10.9).
Fica registrado com o caso reprodutível.

### 22.6. Ferramentas novas

- `_medir/verificar-cache.js` — igual a `verificar.js` (caminho de produção), mas
  lê o índice do OCR de `.cache/ocr.json` em vez do SQL. É o medidor a usar quando
  o banco não alcança.
- `_medir/ocr-cache.js` — regrava `.cache/ocr.json` com o `contarNoCsv` **de
  produção**. Rode-o quando o esquema do índice mudar; foi o caso em 22.3.
