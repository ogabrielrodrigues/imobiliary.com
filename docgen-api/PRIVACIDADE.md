# Registro das operações de tratamento de dados pessoais

Documento interno, mantido em cumprimento ao art. 37 da Lei n.º 13.709/2018
(LGPD). Descreve o que o serviço **de fato** faz — foi escrito a partir do
código, não a partir de intenções, e deve ser corrigido sempre que o código
mudar.

**Última revisão:** 2026-09-10 (redefinição de senha)

Este é o registro do lado do servidor. O que os titulares leem está em
`docs/src/routes/privacidade.tsx` e `docs/src/routes/termos.tsx`, e as duas
coisas precisam continuar dizendo a mesma verdade.

---

## Papéis

| Conjunto de dados | Papel da Imobiliary |
|---|---|
| Conta do corretor (nome, e-mail, senha, sessões) | **Controladora** |
| Conteúdo dos documentos (nome, CPF e endereço de locatários, fiadores, proprietários) | **Operadora** — o controlador é o corretor |

A distinção não é formal: quem decide coletar o CPF de um locatário é o
corretor, e um pedido de titular sobre um contrato é encaminhado a ele. As
obrigações recíprocas estão na seção 6 dos Termos de Uso.

## Inventário

| Dado | Onde | Forma | Retenção | Base legal |
|---|---|---|---|---|
| Nome, e-mail | `users` | texto puro | até a exclusão da conta | execução de contrato (art. 7º, V) |
| Senha | `users.password_hash` | argon2id, sal individual, m=19456 t=2 p=1 | idem | idem |
| Aceite dos termos | `users.terms_accepted_at`, `terms_version` | texto | idem | comprovação (art. 37) |
| Última troca de senha | `users.password_changed_at` | texto | idem | segurança (art. 7º, IX) |
| Token de redefinição | `password_resets.token_hash` | **digest SHA-256**, nunca o segredo | **30 min ou até o uso**, expurgo horário | execução de contrato |
| Valores preenchidos nos documentos | `documents.data` | **JSON em texto puro** | até a exclusão do documento ou da conta | instruções do controlador (art. 39) |
| Documentos gerados | `data/blobs/**` | **ZIP OOXML sem cifra** | idem | idem |
| Nome do arquivo | `documents.filename` | texto puro | idem | idem |
| Modelos enviados | `data/blobs/**`, `template_versions` | **sem cifra** | até a exclusão da conta | execução de contrato |
| Nomes dos campos | `template_versions.placeholders` | JSON | idem | idem |
| Sessões (criação, uso, revogação) | `refresh_tokens` | timestamps + digest SHA-256 do segredo | **30 dias**, expurgo horário | segurança (art. 7º, IX) |
| Endereço IP | memória do processo | chave do limitador | **≤10 min**, nunca gravado | legítimo interesse (art. 7º, IX) |
| Log de acesso | stdout | método, rota, status, bytes, duração | indefinida — depende do coletor | legítimo interesse |

**Nunca coletados:** user agent, dispositivo, geolocalização, telefone,
endereço do titular da conta, dados de navegação, cookies de terceiros.

**Log de acesso:** não registra IP, e-mail, token, corpo de requisição nem
query string. Confirmado em `internal/adapter/http/middleware.go`.

## Compartilhamento e transferência internacional

**Um operador, uma finalidade.** O **Resend** (Resend, Inc., EUA) entrega os
e-mails de segurança — link de redefinição e aviso de senha alterada. Recebe
o endereço de e-mail e o primeiro nome do titular, e apenas no instante em
que uma dessas mensagens precisa sair. **Nunca recebe conteúdo de documento.**

Isso é **transferência internacional** (art. 33), a ser amparada por cláusulas
contratuais padrão na forma da Resolução CD/ANPD n.º 19/2024. **Pendência:**
assinar o contrato de tratamento com o Resend antes de operar com dados reais.

Sem chave de provedor configurada, o serviço escreve o e-mail no log em vez de
enviá-lo — é o padrão, e é o que mantém desenvolvimento sem terceiro nenhum.

Fora isso não há integração com análise, marketing, monitoramento ou
hospedagem de fontes: o navegador do visitante não contata host de terceiro.

## Direitos do titular (art. 18)

| Direito | Como é exercido |
|---|---|
| Confirmação e acesso | `GET /v1/me/export` — tela "Meus dados" |
| Portabilidade | idem, JSON aberto |
| Eliminação da conta | `DELETE /v1/me` — apaga registros **e arquivos** |
| Eliminação de um documento | `DELETE /v1/documents/{id}` |
| Correção | canal do encarregado |

A exclusão de conta é real: os `ON DELETE CASCADE` disparam e os blobs órfãos
são apagados do disco. Um blob compartilhado byte-a-byte com outra conta
sobrevive — o teste `TestDeleteAccountErasesRowsAndFiles` afirma as duas coisas.

**Atenção:** a exclusão de um *modelo* (`DELETE /v1/templates/{id}`) é uma
ocultação, não uma eliminação. É deliberado — mantém reproduzível um documento
gerado antes — e por isso o modelo continua aparecendo na exportação, marcado
como excluído. Não descreva isso como eliminação em documento algum.

## Medidas de segurança (art. 46)

- argon2id nos parâmetros da OWASP, com sal individual e comparação em tempo
  constante.
- Segredo de refresh guardado apenas como digest SHA-256; um vazamento do banco
  não entrega sessões utilizáveis.
- Rotação de refresh com detecção de replay: reapresentar um token consumido
  revoga a cadeia inteira.
- Isolamento por conta aplicado na própria consulta SQL, nunca como verificação
  posterior.
- Limitação de requisições por IP (global e credenciais) e por conta (escrita).
  A troca de senha é cobrada do balde estrito de credenciais, mesmo
  autenticada: adivinhar senha é adivinhar senha.
- Trocar a senha encerra todas as demais sessões **na hora**. Como o access
  token é stateless, `Authenticate` compara o instante de emissão com
  `password_changed_at` — sem isso um invasor seguiria dentro até o token
  expirar sozinho.
- Token de redefinição de uso único, guardado só como digest, consumido em
  statement condicional, e invalidado por qualquer troca de senha.
- O pedido de redefinição responde igual para endereço existente e
  inexistente, para não virar diretório de quem tem conta.
- Na plataforma: cookie de sessão selado e `httpOnly`, verificação de `Origin`
  em toda mutação, CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`.

## Lacunas conhecidas

Registradas aqui porque um registro que só lista virtudes não serve para nada.

1. **Não há cifragem em repouso.** `documents.data`, os blobs e o banco inteiro
   ficam em texto puro. Quem obtiver acesso de leitura ao volume lê todos os
   CPFs com `grep`. É a lacuna mais séria, e está declarada aos titulares na
   política de privacidade em vez de silenciada.
2. **Não há expurgo por prazo.** Nada expira além dos refresh tokens. Os dados
   permanecem até que o titular os apague.
3. **A API não termina TLS.** Sobe com `ListenAndServe()`. **Requisito de
   implantação:** precisa estar atrás de um proxy que termine TLS e ser
   inalcançável de fora, sobretudo com `DOCGEN_TRUST_PROXY_HEADERS=true`, que
   torna o `X-Forwarded-For` confiável e portanto forjável por quem alcançar a
   API diretamente.
4. **Retenção de log indefinida.** O serviço escreve em stdout; o prazo é o do
   coletor. Definir e documentar no ambiente de produção.
5. **Blob órfão em caso de falha.** Se o processo morrer entre a transação e a
   remoção dos arquivos, um arquivo pode sobreviver sem registro. É a direção
   segura da falha, mas exige uma varredura periódica que ainda não existe.

## Incidentes (art. 48)

Não há processo escrito de resposta a incidentes. Definir antes de operar com
dados reais: quem avalia o risco, em quanto tempo, quem comunica a ANPD e os
titulares, e onde o incidente fica registrado.
