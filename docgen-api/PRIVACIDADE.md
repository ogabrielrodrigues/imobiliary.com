# Registro das operações de tratamento de dados pessoais

Documento interno, mantido em cumprimento ao art. 37 da Lei n.º 13.709/2018
(LGPD). Descreve o que o serviço **de fato** faz — foi escrito a partir do
código, não a partir de intenções, e deve ser corrigido sempre que o código
mudar.

**Última revisão:** 2026-09-17 (identidade passa à plataforma Imobiliary)

Este é o registro do serviço de documentos. As contas, senhas, sessões e o
exercício dos direitos do titular sobre a própria conta estão agora no registro
da plataforma, `imobiliary-api/PRIVACIDADE.md`. O que os titulares leem está nas
páginas de privacidade e termos das plataformas, e as coisas precisam continuar
dizendo a mesma verdade.

---

## Papéis

| Conjunto de dados | Papel da Imobiliary |
|---|---|
| Conta do usuário (nome, e-mail, senha, sessões) | Não é mais tratada aqui: fica na plataforma Imobiliary, controladora |
| Conteúdo dos documentos (nome, CPF e endereço de locatários, fiadores, proprietários) | **Operadora** — o controlador é o escritório |

Modelos, documentos e lotes pertencem ao **escritório**, e todos os seus
membros os usam. Quem decide coletar o CPF de um locatário é o escritório, e um
pedido de titular sobre um contrato é encaminhado a ele.

## Inventário

| Dado | Onde | Forma | Retenção | Base legal |
|---|---|---|---|---|
| Nome do escritório | `owners.name` | texto puro, atualizado a cada acesso | enquanto houver modelos ou documentos | execução de contrato (art. 7º, V) |
| E-mail de conta antiga | `owners.email` (tipo `legacy_account`) | texto puro | até a migração ao escritório; depois permanece como registro de para onde foram os dados | execução de contrato |
| Valores preenchidos nos documentos | `documents.data` | **JSON em texto puro** | até a exclusão do documento | instruções do controlador (art. 39) |
| Referência do documento | `documents.reference` | texto, por exemplo `contract:<id>` | idem | idem |
| Documentos gerados | `data/blobs/**` | **ZIP OOXML sem cifra** | idem | idem |
| Nome do arquivo | `documents.filename` | texto puro | idem | idem |
| Modelos enviados | `data/blobs/**`, `template_versions` | **sem cifra** | até a exclusão | execução de contrato |
| Nomes dos campos | `template_versions.placeholders` | JSON | idem | idem |
| Endereço IP | memória do processo | chave do limitador | **≤10 min**, nunca gravado | legítimo interesse (art. 7º, IX) |
| Log de acesso | stdout | método, rota, status, bytes, duração | indefinida, depende do coletor | legítimo interesse |

O token da plataforma traz o identificador do usuário, o e-mail, o nome e o
papel. **Nada disso é gravado** além do nome do escritório: serve para decidir
a quem pertence a requisição e, uma única vez por e-mail, para migrar uma conta
antiga.

**Nunca coletados:** senha, sessão, user agent, dispositivo, geolocalização,
telefone, cookies de terceiros.

**Log de acesso:** não registra IP, e-mail, token, corpo de requisição nem
query string. Confirmado em `internal/adapter/http/middleware.go`.

## Compartilhamento e transferência internacional

Nenhum. O serviço não envia e-mail (o Resend saiu com as senhas) e não tem
integração com análise, marketing ou monitoramento.

## Direitos do titular (art. 18)

| Direito | Como é exercido |
|---|---|
| Sobre a própria conta | na plataforma Imobiliary |
| Cópia do que o escritório guarda aqui | `GET /v1/me/export`, JSON aberto |
| Eliminação de um documento | `DELETE /v1/documents/{id}` |
| Sobre dados de contrato (locatário, fiador) | pelo escritório, controlador |

**Atenção:** a exclusão de um *modelo* (`DELETE /v1/templates/{id}`) é uma
ocultação, não uma eliminação. É deliberado — mantém reproduzível um documento
gerado antes — e por isso o modelo continua aparecendo na exportação, marcado
como excluído. Não descreva isso como eliminação em documento algum.

## Medidas de segurança (art. 46)

- O serviço não guarda nenhum segredo de autenticação. Verifica tokens Ed25519
  de cinco minutos emitidos pela plataforma com as **chaves públicas**, de modo
  que um vazamento deste servidor não permite emitir tokens. HS256 e `none` são
  recusados, e o `aud` precisa ser `docgen`.
- Isolamento por escritório aplicado na própria consulta SQL, nunca como
  verificação posterior.
- Limitação de requisições por IP (global) e por escritório (escrita).
- Migração de conta antiga numa transação, uma única vez por e-mail.

## Lacunas conhecidas

Registradas aqui porque um registro que só lista virtudes não serve para nada.

1. **Não há cifragem em repouso.** `documents.data`, os blobs e o banco inteiro
   ficam em texto puro. Quem obtiver acesso de leitura ao volume lê todos os
   CPFs com `grep`. É a lacuna mais séria.
2. **Não há expurgo por prazo.** Os dados permanecem até que o escritório os
   apague. **Encerrar um escritório na plataforma não apaga seus documentos
   aqui**; isso precisa ser ligado antes de operar com dados reais.
3. **A API não termina TLS.** Precisa estar atrás de um proxy que termine TLS e
   ser inalcançável de fora, sobretudo com `DOCGEN_TRUST_PROXY_HEADERS=true`.
4. **Retenção de log indefinida.** O prazo é o do coletor.
5. **Blob órfão em caso de falha.** Se o processo morrer entre a transação e a
   remoção dos arquivos, um arquivo pode sobreviver sem registro.
6. **Um e-mail migra para o primeiro escritório** em que for usado. Quem é
   membro de dois escritórios leva a conta antiga para o primeiro que acessar.

## Incidentes (art. 48)

Não há processo escrito de resposta a incidentes. Definir antes de operar com
dados reais: quem avalia o risco, em quanto tempo, quem comunica a ANPD e os
titulares, e onde o incidente fica registrado.
