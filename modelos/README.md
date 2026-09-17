# Modelos de teste

Cópias marcadas de contratos reais, usadas para verificar a geração de
documentos de ponta a ponta. Não são modelos de produção: o escritório envia os
seus pela plataforma.

- `contrato-de-locacao-marcado.docx` — cópia do modelo que o usuário forneceu
  em 2026-09-17, com cada valor substituído por um campo de
  `GET /v1/contracts/{id}/document-fields`. O original não foi alterado.

O texto usa os campos de concordância onde a redação exige: `{{.locador_do}}`
("do locador", "da locadora"), `{{.locatario_ao}}`, `{{.locatario_termo_inicio}}`
no início de frase e `{{.locatario_o}}` na terminação de palavras que concordam
com a parte ("obrigad{{.locatario_o}}"). O cabeçalho das qualificações vem
inteiro de `{{.locador_qualificacao}}` e `{{.locatario_qualificacao}}`.

O modelo original não tinha cláusula de foro. Ela foi acrescentada ao parágrafo
de fechamento com `{{.foro}}`, que é o que permite a execução judicial.

A marcação foi feita parágrafo a parágrafo. O Word divide um texto em vários
runs, então quase todo parágrafo alterado foi reescrito num run só: a formatação
do parágrafo e a do primeiro run permanecem, e uma ênfase no meio de um
parágrafo alterado não.
