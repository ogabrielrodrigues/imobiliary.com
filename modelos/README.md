# Modelos de teste

Cópias marcadas de contratos reais, usadas para verificar a geração de
documentos de ponta a ponta. Não são modelos de produção: o escritório envia os
seus pela plataforma.

- `contrato-de-locacao-marcado.docx` — cópia do modelo que o usuário forneceu
  em 2026-09-17, com cada valor substituído por um campo de
  `GET /v1/contracts/{id}/document-fields`. O original não foi alterado.
- `demonstrativo-de-repasse-marcado.docx`: um demonstrativo de repasse escrito
  aqui (não vem de um modelo do usuário), com os campos de
  `GET /v1/payouts/{id}/document-fields`: o repasse, o proprietário, o
  administrador, os totais e o imóvel 1, e um recibo para o proprietário
  assinar. Para usar, envie no Imobiliary Docs como modelo e escolha-o em
  **Gerar documento** na tela do repasse. O Docs não tem blocos que se
  repetem, então um proprietário com mais imóveis pede linhas para
  `imovel_2_...` em diante; a linha de um imóvel que não existe sai vazia.

O texto usa os campos de concordância onde a redação exige: `{{.locador_do}}`
("do locador", "da locadora"), `{{.locatario_ao}}`, `{{.locatario_termo_inicio}}`
no início de frase e `{{.locatario_o}}` na terminação de palavras que concordam
com a parte ("obrigad{{.locatario_o}}").

As qualificações são escritas campo a campo, na redação do próprio modelo:
`{{.locador_1_nome}}, {{.locador_1_nacionalidade}}, {{.locador_1_estado_civil}}`
e assim por diante, com `portador{{.locador_1_a}}`, `inscrit{{.locador_1_o}}` e
`domiciliad{{.locador_1_o}}` concordando com cada pessoa. O original dizia
"cédula de identidade RG n.º ... SSP/SP"; a cópia diz "Carteira de Identidade
Nacional (CIN) n.º", que usa o número do CPF. As assinaturas usam
`{{.locador_1_nome}}` e `{{.locatario_1_nome}}`: o modelo é para um locador e um
locatário. Até 2026-09-21 o cabeçalho vinha pronto de `{{.locador_qualificacao}}`.

O modelo original não tinha cláusula de foro. Ela foi acrescentada ao parágrafo
de fechamento com `{{.foro}}`, que é o que permite a execução judicial.

A marcação foi feita parágrafo a parágrafo. O Word divide um texto em vários
runs, então quase todo parágrafo alterado foi reescrito num run só: a formatação
do parágrafo e a do primeiro run permanecem, e uma ênfase no meio de um
parágrafo alterado não.
