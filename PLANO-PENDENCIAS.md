# Pendências: modelo de demonstrativo, pagamento parcial, carnê-leão e anonimização

Decidido com o usuário em 2026-09-21. Complementa `PLANO.md` e
`PLANO-REPASSE.md`; onde este plano muda uma regra deles, diz qual.

Decisões:

| Tema | Decisão |
|---|---|
| Pagamento parcial, imputação | Primeiro juros e multa vencidos (CC art. 354), depois o principal, dividido proporcionalmente entre aluguel e cobranças. |
| Saldo depois de um parcial | Continua correndo juros sobre o principal que falta. A multa é cobrada uma vez, sobre o valor em atraso. |
| Fiscal | Só o relatório para carnê-leão. DIMOB e nota da taxa ficam de fora. |
| Anonimização | A plataforma sugere, o escritório confirma. Nada é anonimizado sozinho. |

---

## 1. Modelo de demonstrativo de repasse (grupo 1)

O que depende do usuário (ver o repasse, cadastrar o administrador, enviar os
modelos no Docs) continua com ele. A parte que cabe aqui:

- `modelos/demonstrativo-de-repasse-marcado.docx`: um demonstrativo com os
  campos da seção 9 de `campos.md` (repasse, proprietário, administrador,
  totais, imóveis 1 a 3 como exemplo), escrito com o gravador de
  `packages/docx`, para que o Word e o Docs o leiam como qualquer modelo.
- Conferência: o motor do docgen preenche o modelo com os campos de um repasse
  de teste, e o Word lê o resultado de volta.
- `modelos/README.md` diz o que o arquivo é e como enviá-lo no Docs.

## 2. Pagamento parcial

### 2.1 Modelo

- Nova tabela `rent_payments(id, organization_id, rent_id, paid_on, amount,
  interest, penalty, principal, income_tax, created_by, created_at)`, com RLS
  e `RESTRICT` para o escritório. `amount = interest + penalty + principal −
  income_tax`, conferido por `CHECK`.
- `rents` guarda o resumo, mantido na mesma transação: `paid_on` é o dia em
  que a parcela ficou quitada (nulo enquanto falta algo), `amount_paid` a
  soma recebida, `late_fee` a soma de juros e multa cobrados,
  `income_tax_withheld` a soma retida. Assim o status, os filtros e o
  dashboard atuais continuam valendo para a parcela quitada.
- `owner_entries` ganha `payment_id` (obrigatório nas linhas de aluguel), e as
  linhas de cada pagamento são escritas por ele.
- Migração: cada aluguel já pago vira um pagamento único com os valores que
  tem, e as linhas existentes passam a apontar para ele.

### 2.2 Regras (`domain`)

- **Principal** da parcela: aluguel mais cobranças.
- **Multa**: uma vez, a taxa de multa sobre o principal em aberto no dia
  seguinte ao vencimento. Um parcial antes do vencimento reduz essa base.
- **Juros**: taxa mensal pró-rata em mês de 30 dias, sobre o principal em
  aberto, dia a dia, desde o vencimento ou o último pagamento. Nunca sobre
  juros ou multa em aberto (sem anatocismo).
- **Imputação** de cada pagamento: juros vencidos, depois multa, depois
  principal. Encargo não pago fica pendente, sem render juros.
- **Principal dividido** proporcionalmente entre aluguel e cada cobrança, com
  o resto na última parte, como o `Split`.
- **O escritório pode reduzir os encargos** de um pagamento (desconto), como
  hoje; nunca aumentá-los além do calculado.
- **Valor**: omitido, quita tudo o que falta (o comportamento atual, valor
  calculado). Informado, é um parcial; acima do que falta é 422.
- **IRRF**: informado por pagamento; a soma não passa do aluguel.
- **Mudança de regra**: `PLANO-REPASSE.md` dizia que enviar `amount_paid` é
  422. Agora o campo `amount` existe e significa um parcial.

### 2.3 Livro do proprietário

Cada pagamento escreve as linhas do que quitou: a parte de aluguel, a parte
de cada cobrança do proprietário, os juros e a multa (todos do proprietário),
menos a taxa de administração sobre aluguel e cobranças do proprietário
quitados nesse pagamento, e menos o IRRF. Cobranças de terceiros não geram
linha. O proprietário recebe cada parcial no próximo repasse.

### 2.4 Estorno e alterações

- Estorna-se só o último pagamento, recusado se alguma linha dele estiver num
  repasse (como hoje, a mensagem diz qual).
- Cobranças mudam só enquanto a parcela não tem pagamento, porque a divisão
  do principal depende delas. O destino de uma cobrança pode mudar enquanto
  nenhuma linha estiver num repasse; as linhas de todos os pagamentos são
  reescritas.
- Rescisão e reajuste tratam uma parcela com pagamento parcial como paga:
  não a removem nem mudam seu valor.

### 2.5 API

- `POST /v1/rents/{id}/payments` `{ paid_on, amount?, interest?, penalty?,
  income_tax }`: sem `amount`, quita.
- `POST /v1/rents/{id}/payments/preview`: o que falta num dia, dividido em
  principal, juros e multa.
- `DELETE /v1/rents/{id}/payments/{paymentID}`: estorna o último.
- `POST /v1/rents/{id}/payment` e `/reversal` continuam, como atalhos
  equivalentes, até o web deixar de usá-los; depois são removidos.
- O aluguel ganha `payments`, `outstanding` e `partially_paid`.
- Dashboard: "recebido no mês" soma os pagamentos pelo dia de cada um, e "em
  aberto" e "em atraso" usam o que falta, não o valor cheio.

### 2.6 Web

- O diálogo de pagamento ganha "Receber só uma parte", com o valor, e mostra a
  divisão (juros, multa, principal) antes de salvar.
- A página do aluguel lista os pagamentos, com "Estornar" no último.
- O selo "Parcial" nas listas; o valor em aberto no lugar do valor cheio.

## 3. Relatório para carnê-leão

Para o proprietário pessoa física, por ano, mês a mês, pelo dia em que o
escritório recebeu (regime de caixa). Separado pelo tipo de locatário, porque
aluguel pago por pessoa física entra no carnê-leão e o pago por empresa não
(a empresa retém e informa):

- aluguel recebido, e juros e multa recebidos;
- cobranças do proprietário recebidas, em coluna própria;
- taxa de administração descontada;
- IRRF retido por locatário empresa;
- débitos lançados, informativos.

O relatório não calcula imposto nem classifica o que é dedutível: ele traz os
números por linha, e o texto da tela diz que a apuração é do contador. Fonte:
o livro do proprietário.

- API: `GET /v1/people/{id}/income-report?year=2026`.
- Web: `/repasses/pessoa/$personId/carne-leao?ano=`, com versão para
  impressão (a folha clara dos recibos) e CSV para o contador.

## 4. Anonimização ao fim da guarda

### 4.1 Quem aparece como sugestão

Uma pessoa entra na lista quando tudo abaixo é verdade:

- não é proprietária de imóvel cadastrado;
- não é parte de contrato em vigor;
- o fim do último contrato dela (rescisão ou término) e o último lançamento
  no livro dela têm mais de cinco anos contados do primeiro dia do ano
  seguinte (CTN art. 173, I, o maior dos prazos de `PRIVACIDADE.md`);
- o saldo dela a repassar é zero;
- não é representante nem cônjuge vinculado a alguém que não entra na lista.

Pessoas sem vínculo algum não entram: essas o escritório já pode excluir.

### 4.2 O que acontece ao confirmar

- Nome vira "Pessoa anonimizada"; CPF, CNPJ, e-mail, telefone, nascimento,
  profissão e endereços são apagados; o índice cego sai, então o CPF pode ser
  cadastrado de novo como outra pessoa. `people.anonymized_at` marca o
  registro, e a restrição de CPF obrigatório passa a valer só para quem não
  foi anonimizado.
- Contratos, aluguéis e o livro ficam, apontando para o registro anonimizado:
  são números, sem dado pessoal.
- Auditoria `person.anonymized`, sem valores.
- Documentos gerados no Docs com referência `contract:<id>` ou `payout:<id>`
  dessa pessoa têm nomes dentro. A tela os lista e os exclui antes de
  anonimizar; o de um contrato em que outra parte ainda não entra na lista é
  mantido, e a tela diz por quê.

### 4.3 Onde

- API: `GET /v1/people/anonymization-candidates`, `POST
  /v1/people/{id}/anonymization`. Só administradores.
- Web: Ajustes › Escritório › "Guarda de dados", com a lista, o motivo de
  cada um e a confirmação.
- `PRIVACIDADE.md` e a política de privacidade descrevem o procedimento.

## 5. Ordem dos commits

1. Modelo de demonstrativo em `modelos/`.
2. Pagamento parcial: migração e domínio, com testes.
3. Pagamento parcial: API, livro e dashboard, integração e OpenAPI.
4. Pagamento parcial: web.
5. Carnê-leão: API e web.
6. Anonimização: migração, API e web.
7. `PRIVACIDADE.md`, referência publicada, `CLAUDE.md`.

Cada passo fecha com os testes verdes, verificação no navegador com dados de
teste apagados depois e `graphify update .`.
