# Campos para montar um documento

Este é o catálogo de tudo o que a plataforma sabe responder sobre um contrato.
A mesma lista, com busca e um clique para copiar cada marca, está publicada em
<https://claude.ai/artifact/3dsJQEkMPa9iHfdLpq1iGD>.
Você marca o seu modelo do Word com esses nomes e, ao gerar um documento a
partir de um contrato, cada marca vira o texto correspondente.

A marca tem esta forma, com o ponto antes do nome:

```
{{.locatario_1_nome}}
```

Regras da marca: só letras minúsculas sem acento, números e `_`; sem espaços,
sem pontos no meio, sem fórmulas. `{{.Locatario_Nome}}` e `{{.locatario.nome}}`
não são reconhecidos.

Onde usar: escreva o modelo no Word (ou no editor do Imobiliary Docs), envie-o
em **Imobiliary Docs › Modelos**, e ele passa a aparecer no contrato, em
**Gerar documento**. Na revisão você vê o documento já preenchido e pode
corrigir qualquer campo antes de gerar; o arquivo sai do seu modelo original,
com a formatação intacta.

Três coisas valem para todos os campos:

- **Campo vazio é campo vazio.** Se o cadastro não tem a profissão do locatário,
  `{{.locatario_1_profissao}}` sai em branco, e a revisão mostra o campo
  marcado para você preencher na hora.
- **Campo que a plataforma não conhece** (uma testemunha, por exemplo) também
  funciona: ele aparece na revisão como "campo que o contrato não responde",
  em branco, para você digitar.
- **Nada é inventado.** A plataforma nunca preenche um dado que não está
  cadastrado.

---

## 1. Contrato, escritório e foro

| Campo | Exemplo |
|---|---|
| `contrato_numero` | 2026/015 |
| `escritorio_nome` | Central Imóveis |
| `foro` | Bebedouro/SP |

`foro` vem da cidade do imóvel (Lei 8.245/91, art. 58, II) e é editável na
revisão. É o campo que sustenta a execução judicial, então vale ter uma
cláusula de eleição de foro no modelo.

## 2. Imóvel

| Campo | Exemplo |
|---|---|
| `imovel_endereco` | Rua das Flores, 120, apto 12, Centro, Bebedouro/SP, CEP 14700-000 |
| `imovel_logradouro` | Rua das Flores |
| `imovel_numero` | 120 |
| `imovel_complemento` | apto 12 |
| `imovel_bairro` | Centro |
| `imovel_cidade` | Bebedouro |
| `imovel_uf` | SP |
| `imovel_cep` | 14700-000 |
| `imovel_matricula` | 12.345 |
| `imovel_cartorio` | 1º CRI de Bebedouro |
| `imovel_iptu` | 01.02.003.0004 |
| `imovel_agua` | 998877 |
| `imovel_energia` | 4455667 |
| `imovel_proprietarios` | Maria da Conceição e João Pedro |

`imovel_proprietarios` lista quem é dono do imóvel no cadastro, que nem sempre
é quem assina como locador.

## 3. Valores

| Campo | Exemplo |
|---|---|
| `aluguel_valor` | R$ 1.600,00 |
| `aluguel_valor_numero` | 1.600,00 |
| `aluguel_extenso` | mil e seiscentos reais |
| `taxa_administracao` | 10% (dez por cento) |
| `taxa_administracao_numero` | 10 |
| `multa_atraso` | 10% (dez por cento) |
| `multa_atraso_numero` | 10 |
| `juros_atraso` | 2% (dois por cento) ao mês |
| `juros_atraso_numero` | 2 |

O aluguel é o **vigente**: se o contrato já teve reajuste, o documento sai com
o valor de hoje, não com o valor de abertura.

Use a versão `_numero` quando o seu texto já escreve o símbolo ou o por cento:
`R$ {{.aluguel_valor_numero}}` ou `{{.multa_atraso_numero}}%`.

## 4. Garantia

| Campo | Exemplo |
|---|---|
| `garantia_tipo` | caução em dinheiro |
| `garantia_texto` | Caução em dinheiro no valor de R$ 4.800,00 (quatro mil e oitocentos reais), correspondente a 03 (três) aluguéis. |
| `caucao_valor` | R$ 4.800,00 |
| `caucao_valor_numero` | 4.800,00 |
| `caucao_extenso` | quatro mil e oitocentos reais |
| `caucao_alugueis` | 03 (três) |

`garantia_tipo` é uma palavra (sem garantia, caução em dinheiro, fiança, seguro
fiança, cessão fiduciária de quotas de fundo de investimento) e `garantia_texto`
é a frase pronta. Os campos `caucao_*` só têm valor quando a garantia é caução.

## 5. Prazo e datas

| Campo | Exemplo |
|---|---|
| `prazo_meses` | 12 (doze) meses |
| `prazo_meses_numero` | 12 |
| `data_inicio` | 01/10/2026 |
| `data_inicio_extenso` | 1 de outubro de 2026 |
| `data_termino` | 30/09/2027 |
| `data_termino_extenso` | 30 de setembro de 2027 |
| `data_assinatura` | 01/10/2026 |
| `data_assinatura_extenso` | 1 de outubro de 2026 |
| `data_primeiro_reajuste` | 01/10/2027 |
| `data_rescisao` | 15/03/2027 |
| `hoje` | 17/09/2026 |
| `hoje_extenso` | 17 de setembro de 2026 |
| `vencimento_dia` | 10 (dez) |
| `vencimento_dia_numero` | 10 |
| `indice_reajuste` | IGP-M/FGV |
| `indice_reajuste_sigla` | IGP-M |
| `promissorias_quantidade` | 12 (doze) |
| `promissorias_periodo` | outubro/2026 a setembro/2027 |

`data_rescisao` só tem valor em contrato rescindido. `hoje` é o dia em que o
documento está sendo gerado, no fuso de São Paulo, útil no fecho ("Bebedouro/SP,
{{.hoje_extenso}}.").

## 6. As partes, como grupo

Cada papel (`locador`, `locatario`, `fiador`) responde estes campos sobre o
conjunto das pessoas naquele papel. Eles concordam em gênero e número com o que
está no cadastro de cada pessoa: sem gênero informado a redação fica neutra, e
uma empresa é feminina.

| Campo | Um locador homem | Duas locatárias | Sem gênero informado |
|---|---|---|---|
| `locador_nome` | João Pedro | Ana e Beatriz | Alex Souza |
| `locador_quantidade` | 1 | 2 | 1 |
| `locador_qualificacao` | João Pedro, brasileiro, casado..., residente e domiciliado à... | Ana..., e Beatriz... | Alex Souza, ... |
| `locador_titulo` | LOCADOR | LOCATÁRIAS | LOCADOR(A) |
| `locador_termo` | o locador | as locatárias | o(a) locador(a) |
| `locador_termo_inicio` | O locador | As locatárias | O(a) locador(a) |
| `locador_do` | do locador | das locatárias | do(a) locador(a) |
| `locador_ao` | ao locador | às locatárias | ao(à) locador(a) |
| `locador_no` | no locador | nas locatárias | no(a) locador(a) |
| `locador_pelo` | pelo locador | pelas locatárias | pelo(a) locador(a) |
| `locador_o` | o | as | o(a) |

Troque o prefixo para `locatario_` ou `fiador_` conforme o papel.

As contrações existem porque o português não aceita "de o locador". Escreva:

```
... de propriedade {{.locador_do}}, pago {{.locatario_pelo}} ...
```

E `_o` é a terminação de uma palavra que concorda com a parte, para não travar o
texto em um gênero:

```
... ficará {{.locatario_termo}} obrigad{{.locatario_o}} a ...
```

`locador_qualificacao` continua existindo: é o parágrafo inteiro, pronto. Use-o
quando o seu modelo quiser o texto corrido; use os campos da seção seguinte
quando quiser escrever a frase do seu jeito.

## 7. Cada parte, campo a campo

Aqui está o que a crítica ao parágrafo pronto resolveu. Cada pessoa de cada
papel tem o seu bloco, numerado na ordem em que está no contrato, de 1 a 4:

```
{{.locador_1_nome}}   {{.locador_2_nome}}   {{.locatario_1_cpf}}   {{.fiador_1_endereco}}
```

Os sufixos são sempre os mesmos:

| Sufixo | O que é | Exemplo |
|---|---|---|
| `nome` | nome da pessoa física ou razão social | Maria da Conceição |
| `qualificacao` | o parágrafo só desta pessoa | Maria da Conceição, brasileira, casada sob o regime da comunhão parcial de bens, professora, portadora da Carteira de Identidade Nacional (CIN) n.º 123.456.789-09, inscrita no CPF sob o n.º 123.456.789-09, residente e domiciliada à Rua das Flores, 120, Centro, Bebedouro/SP, CEP 14700-000 |
| `tipo` | Pessoa física ou Pessoa jurídica | Pessoa física |
| `cpf` | CPF formatado | 123.456.789-09 |
| `cin` | o mesmo número do CPF | 123.456.789-09 |
| `rg` | o mesmo número, para modelo antigo | 123.456.789-09 |
| `cnpj` | CNPJ formatado (pessoa jurídica) | 12.345.678/0001-95 |
| `nacionalidade` | como está no cadastro | brasileira |
| `estado_civil` | concordando com o gênero | casada |
| `regime_bens` | regime de bens, quando há | comunhão parcial de bens |
| `profissao` | ocupação | professora |
| `nascimento` | data de nascimento | 12/03/1980 |
| `email` | e-mail | maria@exemplo.com |
| `telefone` | telefone | (17) 99999-0000 |
| `nome_fantasia` | nome fantasia (pessoa jurídica) | Central Imóveis |
| `representante_nome` | quem representa a empresa | Carlos Gomes |
| `representante_cpf` | CPF de quem representa | 987.654.321-00 |
| `representante_qualificacao` | qualificação de quem representa | Carlos Gomes, brasileiro, ... |
| `conjuge_nome` | cônjuge cadastrado | João Pedro |
| `conjuge_cpf` | CPF do cônjuge | 111.222.333-44 |
| `endereco` | endereço em uma linha | Rua das Flores, 120, Centro, Bebedouro/SP, CEP 14700-000 |
| `endereco_logradouro` | | Rua das Flores |
| `endereco_numero` | | 120 |
| `endereco_complemento` | | apto 12 |
| `endereco_bairro` | | Centro |
| `endereco_cidade` | | Bebedouro |
| `endereco_uf` | | SP |
| `endereco_cep` | | 14700-000 |

Sobre o **CIN**: a Carteira de Identidade Nacional usa o número do CPF, então
`cpf`, `cin` e `rg` trazem o mesmo número. `rg` existe só para um modelo antigo
que ainda escreve "RG n.º"; em modelo novo, prefira `cin`.

Sobre o **cônjuge**: `conjuge_nome` e `conjuge_cpf` vêm do cadastro da pessoa.
Se o cônjuge também assina (fiador casado, por exemplo), cadastre-o como parte
do contrato: ele entra em `fiador_2_*` e na qualificação do papel.

Sobre a **quantidade**: são 4 blocos por papel. Um contrato com mais de quatro
locadores continua com todos em `locador_nome` e `locador_qualificacao`; os
blocos numerados cobrem os quatro primeiros.

## 8. Um exemplo curto

```
CONTRATO PARTICULAR DE LOCAÇÃO N.º {{.contrato_numero}}

LOCADOR: {{.locador_1_nome}}, {{.locador_1_nacionalidade}},
{{.locador_1_estado_civil}}, {{.locador_1_profissao}}, inscrito no CPF sob o
n.º {{.locador_1_cpf}}, residente à {{.locador_1_endereco}}.

LOCATÁRIO: {{.locatario_1_nome}}, {{.locatario_1_nacionalidade}},
{{.locatario_1_estado_civil}}, {{.locatario_1_profissao}}, inscrito no CPF sob
o n.º {{.locatario_1_cpf}}, residente à {{.locatario_1_endereco}}.

OBJETO: o imóvel situado à {{.imovel_endereco}}, matrícula
{{.imovel_matricula}} do {{.imovel_cartorio}}, de propriedade {{.locador_do}}.

ALUGUEL: {{.aluguel_valor}} ({{.aluguel_extenso}}), vencendo todo dia
{{.vencimento_dia_numero}}, reajustado anualmente pelo {{.indice_reajuste}}.

PRAZO: {{.prazo_meses}}, de {{.data_inicio}} a {{.data_termino}}.

GARANTIA: {{.garantia_texto}}

Em caso de atraso, ficará {{.locatario_termo}} obrigad{{.locatario_o}} ao
pagamento de multa de {{.multa_atraso}} e juros de {{.juros_atraso}}.

Fica eleito o foro da comarca de {{.foro}}.

{{.imovel_cidade}}/{{.imovel_uf}}, {{.hoje_extenso}}.
```

---

## Manutenção

A lista sai de `internal/usecase/documents.go` (`DocumentFieldNames`) e de
`internal/domain/person_fields.go` (`PersonFieldSuffixes`). Um teste compara
este arquivo com o código e falha quando um campo é acrescentado sem ser
documentado aqui. São 419 campos no total: 50 do contrato e do imóvel, mais 11
de grupo e 28 por parte, em 3 papéis e 4 posições.
