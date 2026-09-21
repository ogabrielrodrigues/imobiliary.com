# Repasse ao proprietário

Planejado com o usuário em 2026-09-21, em quatro rodadas. Fica fora do
`PLANO.md` original ("Fase posterior a esta implantação") e começa depois da
fase 8.

---

## 1. Decisões

| Tema | Decisão |
|---|---|
| Multa e juros | Do proprietário, integral, sem taxa (coerente com a regra de 2026-09-16: a taxa nunca incide sobre a multa). |
| Cobranças junto do aluguel | Cada cobrança diz o destino: **proprietário** (entra no repasse) ou **terceiro** (o escritório paga, fora do repasse). |
| Transferência | Só registrar o repasse feito. Sem integração bancária, sem credencial de banco. |
| Ritmo | Saldo a repassar por beneficiário; o escritório registra um repasse quando transferir, cobrindo o que estava pendente. |
| Lançamentos | Débitos e créditos avulsos no saldo, com descrição, data e imóvel opcional. |
| Prestação de contas (CC art. 668) | Tela do repasse, demonstrativo pelo Docs campo a campo, e recibo para imprimir. |
| Estorno de aluguel já repassado | Recusado até o repasse ser desfeito. |
| Beneficiário | Os **locadores do contrato**. Se os locadores são exatamente os proprietários do imóvel, valem as cotas do imóvel no dia do recebimento; se não (usufrutuário, um só condômino), o contrato guarda a cota de cada locador. |
| Administrador | O escritório diz se administra como pessoa física (autônomo: CPF, CRECI) ou jurídica (CNPJ, CRECI). |
| Recibo da taxa | Para cada repasse, um recibo da taxa de administração em nome do proprietário: é o documento do autônomo, que não emite nota. |
| IRRF retido pelo locatário | Registrado no pagamento do aluguel. O aluguel conta como pago inteiro; o repasse desconta o IRRF e o demonstrativo mostra a retenção. |
| Recibo impresso | Versão para impressão na plataforma (A4, impressão do navegador, que também salva em PDF). Sem biblioteca nova. |
| Base da taxa | **Aluguel mais as cobranças com destino proprietário.** O que o escritório só repassa a terceiro não paga taxa. Substitui a regra de 2026-09-16 (taxa sobre todas as cobranças), inclusive no dashboard. |
| Valor recebido | **Calculado**: aluguel + cobranças + multa − IRRF. Deixa de ser digitado; um desconto é dado na multa. |
| Recebimentos anteriores | Entram no livro como pendentes; o escritório registra, com a data real, os repasses que já fez. |
| Demonstrativo no Docs | Detalha até 10 imóveis; acima disso, só os totais. |

Fora deste plano, anotado para depois: arquivo da DIMOB, relatório mensal de
taxas para o carnê-leão, nota fiscal de serviço, e os efeitos da reforma
tributária (IBS/CBS) sobre locação. Tudo isso pede um contador na conversa.

---

## 2. O livro do proprietário

O centro do desenho é um **livro de lançamentos** por beneficiário. Tudo o que o
escritório deve a uma pessoa, ou desconta dela, é uma linha com sinal. O saldo
a repassar é a soma das linhas ainda sem repasse. Um repasse é um conjunto de
linhas fechado numa data.

Linhas nunca são editadas. Corrige-se com outra linha, ou desfazendo o que as
criou enquanto nada foi repassado.

### 2.1 O que um aluguel recebido lança

Quando um aluguel é pago, na mesma transação, para cada locador *L* com cota *s*:

| Linha | Sinal | Valor |
|---|---|---|
| Aluguel | + | `rent_amount × s` |
| Multa e juros | + | `late_fee × s` |
| Cobrança com destino proprietário | + | `amount × s`, uma linha por cobrança |
| Taxa de administração | − | `taxa × s` |
| IRRF retido pelo locatário | − | `irrf × s` |

- `taxa = round((rent_amount + cobranças com destino proprietário) × admin_fee)`.
  O dashboard passa a usar a mesma conta, lida das linhas `admin_fee` do livro
  em vez de recalculada em SQL, para as duas nunca divergirem.
- **Cada componente é dividido pelas cotas com o resto no último locador**, de
  modo que a soma das partes é exatamente o todo, ao centavo. É a regra que
  `splitEvenly` já usa na tela do imóvel.
- A cota vem das cotas do imóvel **no dia do recebimento** quando os locadores
  são exatamente os proprietários; do contrato, quando não. Mudar as cotas do
  imóvel depois não muda o que já foi lançado.
- Cobrança com destino terceiro não lança nada: o dinheiro entrou e sai para o
  condomínio ou a concessionária. Ela aparece no demonstrativo como
  informação.

### 2.2 Lançamentos avulsos

Débito ou crédito digitado pelo escritório: pessoa, valor, descrição (até 120),
data, imóvel opcional. Excluível enquanto não estiver num repasse.

### 2.3 Repasse

- O escritório escolhe o beneficiário, a data da transferência e as linhas
  pendentes que entram (todas marcadas por padrão). Forma (PIX, TED, dinheiro)
  e observação são opcionais.
- O total tem de ser maior que zero. Um saldo negativo (débitos maiores que
  créditos) espera o próximo recebimento.
- Numeração sequencial por escritório e ano, para o recibo: `2026/0001`.
- **Desfazer** devolve as linhas ao saldo pendente. É auditado e serve para o
  repasse registrado por engano ou devolvido.
- Duas pessoas registrando repasse das mesmas linhas ao mesmo tempo: a segunda
  recebe 409 (`UPDATE ... WHERE payout_id IS NULL` e a contagem tem de bater).

### 2.4 Estorno de aluguel

O estorno de um aluguel apaga as linhas que ele lançou. Se alguma delas está num
repasse, o estorno é recusado com 422 em `payment` e a mensagem diz qual
repasse desfazer. Conferido com `FOR UPDATE` na mesma transação.

---

## 3. Modelo de dados (migração 0012)

- `organizations`: `administrator_kind` (`individual`|`company`, nulo até ser
  informado), `administrator_document` (CPF ou CNPJ; **cifrado** como os
  documentos de pessoas, porque o CPF do autônomo é dado pessoal),
  `administrator_creci` (texto curto).
- `contract_parties.share` (milionésimos, nulo): preenchido só para locadores
  quando eles não coincidem com os proprietários. Um gatilho diferido confere
  que, quando existe, soma 100% por contrato.
- `rent_charges.destination` (`owner`|`third_party`). Os existentes recebem
  `third_party`: não cria dívida que o escritório não reconheceu. A tela sugere
  um destino por tipo ao lançar (IPTU ao proprietário; condomínio, água e luz a
  terceiro), e o escritório troca quando quiser.
- `rents.income_tax_withheld` (`bigint NOT NULL DEFAULT 0`). O pagamento
  deixa de aceitar `amount_paid`: ele é calculado e gravado, e a API responde
  422 se ele vier no corpo, para um cliente antigo não achar que foi aceito.
- `owner_entries`: `id`, `organization_id`, `person_id`, `kind` (`rent`,
  `late_fee`, `charge`, `admin_fee`, `income_tax`, `debit`, `credit`),
  `amount` (com sinal), `occurred_on`, `description`, `property_id`,
  `contract_id`, `rent_id`, `charge_id` (nulos conforme o tipo), `payout_id`
  (nulo = pendente), `created_by`, `created_at`. Índice parcial
  `(organization_id, person_id) WHERE payout_id IS NULL`.
- `payouts`: `id`, `organization_id`, `person_id`, `number` (único por
  escritório), `paid_on`, `total`, `method`, `note`, `created_by`,
  `created_at`.
- Tudo com `organization_id`, RLS forçada e `RESTRICT` para o escritório e para
  a pessoa (ninguém com lançamentos é excluído). As linhas de um aluguel caem
  com ele só pelo estorno, nunca por cascata.
- **Recebimentos anteriores:** a migração lança as linhas dos aluguéis já pagos,
  pendentes. O escritório registra, com a data real, os repasses que já fez
  fora da plataforma.
- Como as cobranças existentes recebem `third_party`, a taxa desses aluguéis
  antigos passa a ser só sobre o aluguel. O dashboard de um mês passado pode
  mostrar uma taxa menor que a de antes da migração; o escritório corrige o
  destino de uma cobrança antes de a migração rodar, se quiser outra base.

---

## 4. API

| Rota | O que faz |
|---|---|
| `GET /v1/payouts/balances` | Beneficiários com saldo pendente, com o total e a data da linha mais antiga. |
| `GET /v1/people/{id}/ledger?de=&ate=` | Linhas de uma pessoa (pendentes e repassadas) e os repasses do período. |
| `POST /v1/people/{id}/ledger` | Lançamento avulso. |
| `DELETE /v1/ledger/{entryID}` | Exclui um avulso pendente. |
| `POST /v1/payouts` | Registra um repasse: pessoa, data, linhas, forma, observação. |
| `GET /v1/payouts?pessoa=` | Repasses, mais novos primeiro, com cursor. |
| `GET /v1/payouts/{id}` | O repasse com as linhas agrupadas por imóvel e aluguel: é a tela e o recibo. |
| `DELETE /v1/payouts/{id}` | Desfaz. |
| `GET /v1/payouts/{id}/document-fields` | Campos do demonstrativo para o Docs (§6). |

Mudam: o pagamento aceita `income_tax_withheld`; a cobrança exige
`destination`; o contrato aceita `share` nos locadores; `PATCH
/v1/organization` aceita os dados do administrador (só admin); o dashboard ganha
"a repassar" (total e beneficiários) e "repassado no mês". OpenAPI 0.9.0,
referência republicada na mesma URL. Auditoria: `payout.created`,
`payout.undone`, `ledger.entry_created`, `ledger.entry_deleted`.

---

## 5. Web

- **/repasses**: beneficiários com saldo, do mais antigo ao mais novo, e o
  histórico de repasses. Entra na barra lateral depois de Aluguéis.
- **/repasses/pessoa/$personId**: linhas pendentes com caixas de seleção, o total
  ao vivo, "Registrar repasse" (diálogo com data, forma, observação) e
  "Lançar débito ou crédito".
- **/repasses/$payoutId**: o demonstrativo na tela, "Imprimir recibo de repasse",
  "Imprimir recibo da taxa", "Gerar documento" (modelo do Docs, como no
  contrato) e "Desfazer".
- **Impressão:** uma rota própria para cada recibo, com uma folha de estilo de
  impressão (A4, sem a barra lateral, em tons neutros qualquer que seja o tema).
  O botão abre a rota e chama a impressão do navegador.
  - Recibo de repasse: o escritório declara ter repassado o valor, com espaço
    para a assinatura do proprietário.
  - Recibo da taxa: o administrador declara ter recebido a taxa, com nome,
    CPF ou CNPJ e CRECI. Para pessoa jurídica, a tela lembra que a nota fiscal
    é emitida à parte.
- **Pagamento de aluguel:** campo "IRRF retido pelo locatário", aberto quando
  algum locatário é pessoa jurídica.
- **Cobrança:** "Destino: proprietário ou terceiro", sugerido pelo tipo.
- **Contrato, etapa Partes:** a cota de cada locador aparece quando os locadores
  não são exatamente os proprietários, com "Dividir igualmente" como no imóvel.
- **Ajustes › Escritório:** tipo de administrador, CPF ou CNPJ, CRECI.
- **Pessoa:** o registro mostra o saldo a repassar e leva ao livro.
- **Dashboard:** cartão "A repassar" e a linha "Repassado no mês".

---

## 6. Demonstrativo pelo Docs

O docgen não tem laço (`range`), então um documento não percorre uma lista de
tamanho variável. O demonstrativo por modelo leva:

- o repasse: `repasse_numero`, `repasse_data`, `repasse_data_extenso`,
  `repasse_total`, `repasse_total_extenso`, `repasse_forma`;
- o beneficiário campo a campo, com os mesmos 30 sufixos das partes:
  `proprietario_nome`, `proprietario_cpf`, `proprietario_o`…;
- o administrador: `administrador_nome`, `administrador_documento`,
  `administrador_creci`, `administrador_tipo`;
- os totais por natureza: `total_alugueis`, `total_multas`,
  `total_cobrancas`, `total_taxa`, `total_irrf`, `total_creditos`,
  `total_debitos`;
- por imóvel, numerado até 10: `imovel_1_endereco`, `imovel_1_aluguel`,
  `imovel_1_taxa`, `imovel_1_liquido`….

O detalhe linha a linha fica na tela e no recibo impresso. O documento vai para
o histórico com `reference payout:<id>`. `docs/campos.md` e a página publicada
ganham a seção nova, e o teste que exige cada campo documentado passa a cobrir
estes.

---

## 7. Etapas e commits

1. Migração 0012 e domínio: divisão pelas cotas com resto no último, as linhas
   de um recebimento, validação de repasse e de lançamento. Unitários.
2. Casos de uso, repositórios, HTTP, OpenAPI. Integração.
3. Administrador no escritório (API e Ajustes).
4. Web: destino da cobrança, IRRF no pagamento, cotas dos locadores.
5. Web: /repasses, livro da pessoa, demonstrativo, recibos, dashboard.
6. Campos do demonstrativo, catálogo e página publicada.
7. `PRIVACIDADE.md`, `CLAUDE.md`, referência republicada.

## 8. Verificação

- **Unitários:** a divisão sempre soma o todo (cotas desiguais, 3 locadores,
  valores de 1 centavo); a taxa sobre aluguel e cobranças; multa integral ao
  proprietário; IRRF debitado; cobrança a terceiro não lança nada.
- **Integração:** pagar lança as linhas certas para dois locadores; estornar
  sem repasse apaga as linhas; estornar depois do repasse é 422; desfazer e
  então estornar funciona; dois repasses simultâneos das mesmas linhas, um 409;
  cotas do imóvel alteradas depois não mudam linhas lançadas; RLS isola outro
  escritório; o papel da aplicação não altera linha já repassada.
- **Navegador**, com dados de teste criados e apagados, sem tocar nos registros
  do usuário: o fluxo inteiro, os dois recibos em pré-visualização de impressão,
  375px, e o demonstrativo gerado e aberto no Word.

## 9. Confirmado depois da primeira versão

Os quatro pontos que a primeira versão deixou em aberto foram decididos no
mesmo dia e estão na tabela do §1: valor recebido calculado, recebimentos
anteriores pendentes, taxa só sobre aluguel e cobranças do proprietário, e até
10 imóveis no demonstrativo.

## 10. Registro LGPD

`PRIVACIDADE.md` ganha: o livro do proprietário (valores por pessoa, finalidade
prestação de contas do mandato, CC arts. 667 a 674), o documento do
administrador autônomo (cifrado), e a guarda: registros financeiros mantidos
pelo prazo fiscal (5 anos, CTN art. 173), o que limita a exclusão pelo titular
como já faz o §6.3 do `PLANO.md`.
