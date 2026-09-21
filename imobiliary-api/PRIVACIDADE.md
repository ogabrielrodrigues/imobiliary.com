# Registro das operações de tratamento de dados pessoais

Documento interno, mantido em cumprimento ao art. 37 da Lei n.º 13.709/2018
(LGPD), para a `imobiliary-api`. Descreve o que o serviço faz de fato: foi
escrito a partir do código e deve ser corrigido sempre que o código mudar.

**Última revisão:** 2026-09-17 (fase 7: documentos do contrato)

O que os titulares leem está em `web/src/routes/privacidade.tsx` e
`web/src/routes/termos.tsx`. Este registro e esses textos precisam continuar
dizendo a mesma coisa.

---

## Papéis

| Conjunto de dados | Papel da Imobiliary |
|---|---|
| Conta de quem usa a plataforma (nome, e-mail, senha, sessões, segundo fator) | **Controladora** |
| Registros de acesso (Marco Civil, art. 15) e trilha de auditoria | **Controladora** |
| Pessoas e imóveis cadastrados pelo escritório (proprietários, locatários, fiadores, representantes, endereços, matrículas) | **Operadora**; o controlador é o escritório |

Quem decide cadastrar o CPF de um locatário é o escritório. Um pedido de
titular sobre esses dados é encaminhado a ele, e a plataforma trata os dados
segundo as instruções dele (art. 39).

## Inventário

### Conta e escritório

| Dado | Onde | Forma | Retenção | Base legal |
|---|---|---|---|---|
| Nome e e-mail da conta | `users` | texto | até a exclusão da conta | execução de contrato (art. 7º, V) |
| Senha | `users.password_hash` | argon2id | idem | idem |
| Aceite dos termos | `users.terms_version`, `terms_accepted_at` | texto | idem | comprovação (art. 37) |
| Segredo do segundo fator | `user_totp.secret` | **cifrado** (AES-256-GCM, contexto de tabela, coluna e linha) | até desativar ou excluir a conta | segurança (art. 46) |
| Códigos de recuperação | `recovery_codes.code_hash` | digest, nunca o código | idem | idem |
| Sessões | `refresh_tokens.token_hash` | digest | até expirar (30 dias), expurgo horário | execução de contrato |
| Links de redefinição e convites | `password_resets`, `invitations` | digest do segredo; convite guarda o e-mail convidado | 30 min e 7 dias; redefinições expiradas são expurgadas | execução de contrato |
| Nome do escritório, papéis | `organizations`, `memberships` | texto | até a exclusão | execução de contrato |
| Administrador dos aluguéis: tipo, CPF ou CNPJ, CRECI | `organizations.administrator_*` | documento **cifrado** (tabela, coluna e escritório); tipo e CRECI em texto | até o escritório mudar ou ser excluído | execução de contrato: é quem assina os recibos entregues aos proprietários |

### Registros

| Dado | Onde | Forma | Retenção | Base legal |
|---|---|---|---|---|
| Registros de acesso: evento, IP, porta, data e hora | `access_records` | texto | **6 meses**, expurgo horário | obrigação legal (art. 7º, II; Marco Civil art. 15) |
| E-mail de conta excluída | `closed_accounts.email` | **cifrado** | 6 meses após a exclusão | obrigação legal, para que os registros de acesso ainda identifiquem alguém |
| Trilha de auditoria: quem, o quê, quando, IP, **nomes** dos campos alterados | `audit_events` | texto, sem valores | sem prazo automático (lacuna) | legítimo interesse do escritório e comprovação (art. 7º, IX; art. 37) |

A aplicação não pode alterar nem apagar a trilha: a migração revoga `UPDATE` e
`DELETE` do papel `imobiliary_app`.

### Pessoas e endereços (dados do escritório)

| Dado | Onde | Forma | Retenção |
|---|---|---|---|
| Nome completo ou razão social | `people.name` | **texto puro**, para permitir busca | até o escritório excluir a pessoa |
| E-mail, telefone | `people.email`, `people.phone` | **cifrados** | idem |
| CPF | `individuals.cpf` | **cifrado**, com índice cego HMAC por escritório | idem |
| CNPJ | `companies.cnpj` | **cifrado**, com índice cego HMAC por escritório | idem |
| Data de nascimento | `individuals.birth_date` | **cifrada** | idem |
| Nacionalidade, estado civil, regime de bens, profissão, cônjuge | `individuals` | texto | idem |
| Gênero | `individuals.gender` | texto, opcional | idem |
| Nome fantasia, representantes | `companies`, `company_representatives` | texto | idem |
| Endereços | `addresses`, `person_addresses` | **texto puro** | idem |

### Imóveis (dados do escritório)

| Dado | Onde | Forma | Retenção |
|---|---|---|---|
| Endereço do imóvel | `addresses`, ligado a `properties` | texto puro, pesquisável | até o escritório excluir o imóvel |
| Matrícula, cartório, inscrição do IPTU | `properties` | texto puro | idem |
| Códigos de água e energia | `properties` | texto puro | idem |
| Proprietários e suas partes | `property_owners` | identificador da pessoa e percentual | idem |

Isoladamente não são dados pessoais, mas ligados aos proprietários revelam
patrimônio de pessoas físicas, por isso seguem o mesmo isolamento por
escritório e a mesma auditoria sem valores. A soma das partes em 100% é
conferida também pelo banco, na confirmação da transação.

A base legal desses dados é do escritório, não da Imobiliary. Na prática são
execução de contrato de locação e procedimentos preliminares (art. 7º, V) e
exercício regular de direitos (art. 7º, VI).

### Contratos e aluguéis (dados do escritório)

| Dado | Onde | Forma | Retenção |
|---|---|---|---|
| Termos do contrato: número, valores, taxas, datas, índice, garantia | `contracts` | texto puro e inteiros | até o escritório excluir o contrato |
| Partes e seus papéis (locador, locatário, fiador, cônjuge do fiador) | `contract_parties` | identificador da pessoa e papel | idem |
| Ciência dos avisos legais: código, quem deu e quando | `contract_acknowledgments` e `audit_events` | texto puro | idem na tabela; a auditoria permanece |
| Parcelas: vencimento, valor, pagamento | `rents` | inteiros e datas | idem |
| Pagamentos, inteiros ou parciais: data, valor recebido, multa e juros quitados ou dispensados, parte do aluguel e cobranças, IRRF | `rent_payments`, com as somas em `rents` | inteiros e datas | idem; um estorno apaga o último pagamento e fica na auditoria |
| Cobranças junto do aluguel: tipo, descrição, valor, destino (proprietário ou terceiro) | `rent_charges` | texto puro e inteiros | idem |
| IRRF retido pelo locatário pessoa jurídica | `rent_payments.income_tax`, somado em `rents.income_tax_withheld` | inteiro | idem |
| Cotas de locadores que não são exatamente os proprietários | `contract_parties.share` | inteiro | idem |
| Reajustes: data, índice, alíquota, aluguel anterior e novo, ciência do aviso de prazo | `amendments` | inteiros, datas e o usuário que deu a ciência | idem |

Revelam a situação financeira e as garantias de pessoas físicas. Contrato com
aluguel pago não pode ser excluído, só rescindido: o registro do pagamento é
prova e as pretensões de aluguel prescrevem em três anos (CC art. 206, § 3º, I).
Quem deu ciência de um aviso fica registrado mesmo que a conta seja fechada
depois; nesse caso a coluna perde o vínculo com o usuário e a auditoria mantém
o evento sem valores.

### Repasse ao proprietário (dados do escritório)

| Dado | Onde | Forma | Retenção |
|---|---|---|---|
| Livro do proprietário: para cada locador, sua parte de cada aluguel recebido, da multa, das cobranças dele, da taxa e do IRRF; débitos e créditos digitados com descrição | `owner_entries` | inteiros com sinal, datas, texto da descrição | **prazo fiscal** (ver abaixo) |
| Repasses: beneficiário, número, data, total, forma, observação | `payouts` | texto puro e inteiros | idem |
| Numeração dos repasses | `payout_numbers` | inteiros | idem |

Finalidade: a prestação de contas do mandato de administração (CC arts. 667 a
674, em especial o art. 668) e a comprovação do que foi repassado. A
plataforma não movimenta dinheiro nem guarda dado bancário: o repasse é o
registro de uma transferência que o escritório já fez.

Retenção: registros financeiros ficam pelo prazo em que o fisco pode exigi-los,
**5 anos** contados do primeiro dia do ano seguinte (CTN art. 173, I), e a
pretensão de prestação de contas tem prazo próprio. Uma linha já repassada não
é editada nem excluída pelo papel da aplicação (só a ligação com o repasse
muda, e só por desfazer o repasse); uma pessoa com linhas não é excluída
(`RESTRICT`). Ao fim do prazo a pessoa pode ser anonimizada (ver "Fim da
guarda"); as linhas ficam, sem ninguém identificável.

O relatório para carnê-leão (`GET /v1/people/{id}/income-report`) só soma
essas linhas por mês para o proprietário pessoa física; não cria dado novo.
A planilha que a tela gera é baixada pelo escritório e sai da plataforma com
ele, como qualquer documento que ele imprime.

A descrição de um débito ou crédito é texto livre digitado pelo escritório
("Conserto do chuveiro"); a tela não pede e o escritório não deve pôr ali dado
de saúde ou outro dado sensível.

**Finalidade do gênero:** apenas a concordância gramatical no texto do contrato
("o locatário", "a locatária"). O campo é opcional e não é usado para mais nada.

**Índice cego:** o HMAC recebe o identificador do escritório junto com o
documento. O mesmo CPF cadastrado por dois escritórios gera índices diferentes,
então a coluna não permite cruzar pessoas entre escritórios.

## Fim da guarda: anonimização

Uma pessoa passa a ser sugerida para anonimização quando não é proprietária de
imóvel cadastrado, não é parte de contrato em vigor, não tem lançamento
esperando repasse, e o fim do último contrato, o último lançamento e o último
repasse dela passaram dos 5 anos fiscais contados do ano seguinte. Quem é
cônjuge ou representante de alguém que não passou fica, porque o outro
cadastro ainda precisa dele. A lista fica em Ajustes › Escritório; **nada é
anonimizado sozinho**: um administrador confirma cada pessoa, porque o
escritório é o controlador e pode ter motivo para guardar mais (um processo
em curso, por exemplo, art. 16, II).

Ao confirmar, o nome vira "Pessoa anonimizada" e somem CPF ou CNPJ e seu
índice cego, e-mail, telefone, nascimento, nacionalidade, profissão, estado
civil, regime de bens, gênero, nome fantasia, endereços e vínculos de
representante e de cônjuge (`POST /v1/people/{id}/anonymization`, migração
0016). O cadastro fica, marcado em `people.anonymized_at`, para que contratos,
aluguéis, livro e repasses continuem consistentes; ele não é mais editado. Os
documentos gerados no Docs para os repasses da pessoa, e para os contratos
cujas outras partes também saem, são excluídos antes; os de um contrato que
nomeia alguém ainda cadastrado ficam, e a tela diz quantos. A auditoria
registra `person.anonymized`, sem valores.

## Isolamento entre escritórios

Toda consulta a pessoas, endereços e imóveis acontece numa transação que fixa o
escritório (`set_config('app.organization_id', ..., true)`), e as tabelas têm
row-level security **forçada**, inclusive para o dono das tabelas. Uma consulta
fora desse escopo não enxerga nenhuma linha. Os repositórios não filtram por
escritório de outra forma, e os testes de integração rodam como dono das
tabelas; por isso uma política ausente derruba um teste
(`TestOfficesCannotSeeEachOthersPeople`).

Qualquer membro do escritório, administrador ou não, lê e altera as pessoas e os
imóveis.

## Documentos gerados a partir de um contrato ou de um repasse

`GET /v1/contracts/{id}/document-fields` monta, a partir do que já está
cadastrado, o texto com que um modelo de locação é preenchido: a qualificação
de cada parte (nome, nacionalidade, estado civil, profissão, CPF — repetido
como CIN — e endereço), os valores por extenso, a garantia, as datas e o foro.
**Nada é gravado**: é leitura do contrato, das pessoas e do imóvel, montada na
resposta. O gênero registrado em cada pessoa serve só para a concordância do
texto; sem ele, a redação fica neutra ("locatário(a)").

`GET /v1/payouts/{id}/document-fields` faz o mesmo para um demonstrativo de
repasse: o repasse, o proprietário campo a campo, o administrador e os totais
por imóvel. Também não grava nada. O documento fica no serviço de documentos com
a referência `payout:<id>`.

Quem gera o documento é o serviço de documentos (`docgen-api`), e é para lá que
esses valores vão, por ordem do escritório. Ele tem registro próprio, em
`docgen-api/PRIVACIDADE.md`, onde constam a retenção e a ausência de cifragem em
repouso.

`POST /v1/sessions/docgen-token` emite, para a sessão, um token Ed25519 de cinco
minutos com público `docgen`. Ele carrega o identificador do usuário, o do
escritório, o nome do escritório, o e-mail, o nome e o papel, para que o serviço
de documentos saiba a quem pertence o que recebe. Não é gravado aqui, e esta API
recusa o próprio token, cujo público não é o dela.

## Compartilhamento e transferência internacional

| Destinatário | O que recebe | Quando |
|---|---|---|
| Resend (EUA) | e-mail e primeiro nome **da conta** | avisos de segurança, links de redefinição e convites |
| Serviço de documentos (mesmo controlador, servidor próprio) | os valores do documento e a identificação do escritório | quando o escritório gera um documento a partir de um contrato ou de um repasse |

Nenhum dado de pessoa cadastrada pelo escritório sai para terceiro. O envio ao
Resend é transferência internacional (art. 33) e ainda **não tem contrato de
tratamento assinado** (ver lacunas). O serviço de documentos é da mesma
controladora e fica na mesma infraestrutura, então não há transferência
internacional nesse caminho.

## Direitos do titular (art. 18)

| Direito | Da conta | De pessoa cadastrada |
|---|---|---|
| Confirmação e acesso (II) | `GET /v1/me/export`, em Ajustes, Meus dados | pelo escritório, que lê o cadastro |
| Correção (III) | alteração de nome ainda não existe (lacuna) | pelo escritório, `PUT /v1/people/{id}` |
| Eliminação (VI) | `POST /v1/me/deletion`, com a senha | pelo escritório, `DELETE /v1/people/{id}`; com vínculo, a anonimização ao fim da guarda |
| Anonimização (IV) | não se aplica | ao fim da guarda, confirmada por um administrador |
| Portabilidade (V) | o mesmo JSON da exportação | não há exportação de pessoas (lacuna) |

**Limites da eliminação:**

- Registros de acesso e o e-mail cifrado da conta excluída ficam 6 meses
  (art. 16, I).
- A trilha de auditoria fica, sem apontar para a conta.
- Um escritório só é apagado junto com a conta do seu único membro se **não
  tiver pessoas cadastradas**. O vínculo das pessoas com o escritório é
  `RESTRICT` no banco, e a exclusão da conta é recusada com
  `organization_data`. Decisão do usuário em 2026-09-16: nada do que o
  escritório cadastrou desaparece como efeito colateral.
- Uma pessoa ligada a outro registro (representante de empresa ou proprietário de imóvel hoje; contrato
  nas próximas fases) não pode ser excluída enquanto o vínculo existir.

## Medidas de segurança (art. 46)

- Campos sensíveis cifrados com AES-256-GCM, chaves versionadas
  (`IMOBILIARY_FIELD_KEYS`) e dados autenticados de tabela, coluna e linha: um
  valor copiado para outra linha não abre.
- Senhas com argon2id; segundo fator obrigatório para administradores.
- Tokens de acesso Ed25519 de 15 minutos, com o vínculo relido a cada
  requisição; refresh com rotação e revogação da cadeia em reuso.
- Row-level security forçada nas tabelas do escritório.
- Edição com controle de versão (`If-Match`), para que uma alteração
  concorrente não sobrescreva outra em silêncio.
- Logs operacionais com redação por nome de atributo; a rota registrada é o
  modelo, nunca o caminho com identificadores.
- Serviço escutando só em loopback; TLS no proxy à frente (requisito de
  implantação).

## Lacunas conhecidas

- **Sem contrato de tratamento com o Resend.** Assinar, com as cláusulas-padrão
  da ANPD, antes de operar com dados reais.
- **Nomes e endereços em texto puro.** Precisam ser pesquisáveis; ficam
  protegidos por isolamento e controle de acesso, não por cifra.
- **Sem prazo automático** para a trilha de auditoria. Pessoas de contratos
  encerrados são sugeridas para anonimização ao fim da guarda, mas só um
  administrador confirma; um escritório que nunca olha a lista guarda os dados
  além do prazo.
- **O livro do proprietário e os repasses não são apagados** ao fim dos 5
  anos: ficam sem identificação depois da anonimização da pessoa, com os
  valores.
- **Documentos no Docs de um contrato com partes ainda cadastradas** ficam
  depois que uma delas é anonimizada, porque nomeiam as outras. Excluí-los é
  decisão do escritório, na tela do contrato.
- **Obrigações fiscais fora da plataforma:** DIMOB e nota fiscal da taxa
  ainda não são gerados. O relatório para carnê-leão soma o livro e não
  calcula imposto.
- **Sem exportação de pessoas** para atender portabilidade pedida ao escritório.
- **Sem troca de nome e e-mail da conta.**
- **Sem cifra do disco** e sem política de backup definida; dependem da
  implantação.
- Os textos jurídicos foram escritos a partir do código e ainda precisam de
  revisão por advogado.

## Incidentes (art. 48)

Não há processo escrito de resposta a incidentes. Até haver, a regra mínima é:
conter, preservar os registros de acesso e a trilha de auditoria, avaliar o
risco aos titulares e comunicar a ANPD e os escritórios afetados no prazo que a
regulamentação da ANPD fixar.
