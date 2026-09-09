# API de Geração de Documentos Padronizados

## Contexto

Uma API que gera documentos padronizados a partir de modelos DOCX enviados pelo
próprio usuário, preenchidos com dados personalizados a cada requisição. O
diretório está vazio: projeto greenfield, sem código a reaproveitar.

O fluxo de negócio é deliberadamente enxuto: o usuário se autentica, envia um
modelo `.docx` com placeholders, gera documentos a partir desse modelo e baixa
o resultado. A complexidade está concentrada na renderização OOXML e nos
requisitos de segurança, não nas regras de domínio.

## Verificações já feitas

- `go1.27.1` confirmado como release estável atual em `go.dev/dl`. O toolchain
  local é `go1.25.5`, mas `GOTOOLCHAIN=auto` já está ativo: a diretiva
  `go 1.27.1` no `go.mod` dispara o download automático.
- `encoding/json/v2` é **estável** na 1.27 (não exige mais GOEXPERIMENT).
- O pacote **`uuid`** entrou na stdlib com `NewV4`/`NewV7`.

## Convenções

- **Todo o código em inglês** — identificadores, comentários, mensagens de erro,
  nomes de teste, documentação. O português fica restrito à conversa.
- `gofmt` e `go vet` limpos. Nomenclatura conforme *Effective Go*: pacotes com
  nome curto e sem stutter (`token.New`, não `token.NewToken`).
- Erros embrulhados com `%w`; sentinelas de domínio comparadas com `errors.Is`.
- `context.Context` como primeiro parâmetro em tudo que faz I/O.

## Decisões confirmadas

| Área | Decisão |
|---|---|
| Formato de saída | DOCX gerado com `archive/zip` + `text/template` |
| Templates | Recurso CRUD da API, com versionamento imutável |
| Armazenamento | SQLite (`modernc.org/sqlite`) + blobs em filesystem |
| Execução | Síncrona |
| Sessão | Access JWT curto + refresh opaco rotacionado e revogável |
| JWT | `github.com/golang-jwt/jwt/v5` |
| Rate limit | Token bucket em memória, em camadas |
| Contas | Usuários simples, sem multi-tenancy |

### Dependências externas — lista completa

Três, todas justificadas:

- `modernc.org/sqlite` — SQLite em Go puro, sem cgo, permite binário estático.
- `github.com/golang-jwt/jwt/v5` — escolha do usuário sobre a implementação stdlib.
- `golang.org/x/crypto` — para `argon2` (hash de senha). Mantido pelo próprio
  time do Go; a stdlib não oferece KDF de senha moderno.

Todo o resto — HTTP, roteamento, ZIP, XML, JSON, UUID, HMAC, rand — sai da stdlib.

## Domínio

Cinco entidades, sem relacionamentos supérfluos:

- **User** — conta. Cadastro com `email`, `password` e `name`.
- **RefreshToken** — sessão persistida, encadeada para permitir rotação.
- **Template** — o modelo lógico, com nome e descrição. Pertence a um usuário.
- **TemplateVersion** — o `.docx` em si, **imutável**. Publicar uma alteração
  cria uma nova versão; a anterior continua utilizável. É o que torna a geração
  reproduzível: todo documento aponta para a versão exata que o originou.
- **Document** — o resultado gerado. Guarda os dados de entrada e o hash do
  blob produzido.

Um documento nasce final: não há rascunho, revisão nem cancelamento. Não há
numeração sequencial de negócio — o identificador é o UUIDv7.

## Superfície da API

Roteamento com `http.ServeMux` da stdlib, que desde a 1.22 suporta método e
wildcards no padrão (`POST /v1/templates/{id}/versions`). Nenhum router externo.

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/v1/auth/register` | — | Cria conta |
| POST | `/v1/auth/login` | — | E-mail + senha → access + refresh |
| POST | `/v1/auth/refresh` | refresh | Rotaciona o par de tokens |
| POST | `/v1/auth/logout` | refresh | Revoga a cadeia de sessão |
| GET | `/v1/me` | access | Dados da conta |
| POST | `/v1/templates` | access | Upload multipart do `.docx` → cria versão 1 |
| GET | `/v1/templates` | access | Lista paginada |
| GET | `/v1/templates/{id}` | access | Metadados + **schema de placeholders** |
| POST | `/v1/templates/{id}/versions` | access | Publica nova versão |
| DELETE | `/v1/templates/{id}` | access | Soft delete |
| POST | `/v1/documents` | access | Gera documento a partir de um template |
| GET | `/v1/documents/{id}` | access | Metadados |
| GET | `/v1/documents/{id}/download` | access | Baixa o `.docx` |
| GET | `/healthz` | — | Liveness |

O download é um `GET` autenticado que faz stream do blob com
`Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`
e `Content-Disposition: attachment`. Serve `http.ServeContent`, ganhando
`Range` e `If-Modified-Since` de graça. Todo acesso é filtrado por `owner_id`
na camada de repositório — nunca no handler.

## Design dos placeholders

Esta era a parte em aberto; a proposta:

**Sintaxe.** O usuário escreve `{{.customer_name}}` no corpo do `.docx`, em
`snake_case`. É a sintaxe nativa de `text/template`, então não há parser
próprio a manter.

> **Desvio do plano, decidido durante a implementação.** O plano previa que o
> usuário ganharia condicionais e repetições "sem custo extra". Na prática a
> gramática aceita foi **restringida a referências de campo puras**: nada de
> pipelines, chamadas de função, variáveis, `if` ou `range`. O template vem de
> upload não confiável, e com os dados sendo `map[string]string` essas
> construções agregam pouco e ampliam bastante a superfície a validar. A
> restrição é verificada percorrendo a árvore sintática e produz um erro
> explicando exatamente o que foi rejeitado. Coberto por
> `TestCompileRejectsUnsupportedConstructs`.

**Descoberta automática do schema.** No momento em que a versão é criada, o
template é compilado e sua *parse tree* é percorrida (`text/template/parse`,
caçando `FieldNode` dentro de `ActionNode`) para extrair a lista de campos
referenciados. Essa lista é persistida em `template_versions.placeholders` e
devolvida por `GET /v1/templates/{id}`. O cliente descobre o que precisa enviar
sem adivinhar, e sem que o usuário declare nada manualmente.

**Validação na geração.** Campo faltando ou campo desconhecido → `422` com a
lista exata dos problemas. Rejeitar extras é intencional: transforma um erro de
digitação silencioso em falha imediata. O template roda com
`Option("missingkey=error")` como segunda barreira.

**Escape de XML — o detalhe que corrompe arquivos.** `text/template` não escapa
nada. Um valor contendo `&`, `<` ou `>` produziria um `document.xml` inválido e
um `.docx` que o Word se recusa a abrir. Todo valor é escapado com
`xml.EscapeText` **antes** de entrar no template. Terá teste dedicado.

**Segurança.** O template vem do usuário, então: sem `FuncMap` (nenhuma função
disponível), dados como `map[string]string` de valores planos (sem métodos a
invocar), limite de tamanho no template e no payload, e `Execute` sob contexto
com timeout.

## Estrutura

Clean Architecture adaptada ao Go: as **interfaces são declaradas no consumidor**
(`usecase`), não junto da implementação. É o idioma da linguagem e entrega
Inversão de Dependência sem a cerimônia de um container de DI.

```
cmd/docgen/main.go          # composition root: monta e injeta tudo
internal/
  domain/                   # entidades e erros. ZERO imports do projeto
  usecase/                  # casos de uso + ports (interfaces) que eles consomem
  adapter/
    http/                   # handlers, middleware, router (net/http, stdlib)
    sqlite/                 # implementação dos repositórios
    docx/                   # motor de renderização
  platform/
    config/                 # carga de configuração via env
    token/                  # emissão/validação de JWT e refresh
    ratelimit/              # token bucket
    blob/                   # store content-addressed
```

A regra de dependência é unidirecional: `adapter` → `usecase` → `domain`.
`domain` não importa nada do projeto. Verificável com `go list`.

Sobre SOLID no Go: **ISP** aparece como interfaces de um ou dois métodos
(`UserRepository`, `BlobStore`) em vez de um `Repository` monolítico — o que
também torna os fakes de teste triviais. **SRP** separa renderização de
persistência de transporte. **OCP/LSP** têm pouco a dizer sem herança; não vou
forçar abstração onde a linguagem não pede.

## Persistência

SQLite com `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON`. Duas conexões distintas: um pool de leitura e **uma única**
conexão de escrita (`SetMaxOpenConns(1)`) — SQLite serializa escritas de
qualquer forma, e isso elimina contenção de `SQLITE_BUSY`.

IDs são UUIDv7 armazenados como `BLOB(16)`: ordenáveis por tempo, o que mantém
localidade de inserção no índice B-tree e evita a fragmentação do UUIDv4.

- `template_versions` é **append-only**: uma versão publicada nunca muda. É o
  que habilita o cache permanente em memória.
- `refresh_tokens` guarda apenas o **hash** do token, com `parent_id` para
  encadear a rotação e permitir detecção de reuso.

Os binários não vão para o banco. Ficam em `data/blobs/<aa>/<bb>/<sha256>`,
endereçados por conteúdo — dedupe automático e escrita atômica via arquivo
temporário + `os.Rename`.

## Renderização DOCX

Um `.docx` é um ZIP cujo conteúdo textual vive em `word/document.xml`.

**O problema central:** o Word fragmenta texto em runs (`<w:r>`) de forma
arbitrária — por verificação ortográfica, histórico de edição, qualquer coisa.
Um placeholder `{{.customer_name}}` frequentemente aparece partido em três ou
quatro runs distintos, e um `text/template` ingênuo nunca o encontraria.

A solução é uma passagem de normalização, executada **uma única vez** quando a
versão é criada:

1. Ler `word/document.xml` com `encoding/xml`.
2. Coalescer runs adjacentes que compartilham o mesmo `<w:rPr>`, reunindo os
   placeholders partidos.
3. Compilar com `text/template`, extrair o schema e persistir o DOCX normalizado.

Como a versão é imutável, o `*template.Template` compilado é cacheado em memória
indefinidamente (LRU limitado por contagem). Na geração, o caminho quente é
apenas `Execute` + reescrita do ZIP: nenhum parse de XML, nenhum acesso a disco
para o template.

Os demais arquivos do ZIP são copiados **sem recompressão**, via
`zip.Writer.Copy` a partir das entradas originais — só a entrada alterada é
recomprimida.

### Otimizações

- `sync.Pool` de `bytes.Buffer` para os buffers de renderização.
- Cache de templates compilados (seguro porque as versões são imutáveis).
- Blobs endereçados por conteúdo: documentos idênticos não duplicam bytes.
- `encoding/json/v2` no encode/decode das requisições.
- Statements preparados e reutilizados nos repositórios.

## Segurança

**Autenticação e sessão.** Access token JWT com TTL de ~15min, validado sem
tocar o banco. Refresh token opaco de 32 bytes de `crypto/rand`, persistido
apenas como hash, **rotacionado a cada uso**. Se um refresh já consumido for
reapresentado, toda a cadeia daquele usuário é revogada — detecção padrão de
roubo de token. Senhas com argon2id.

**Rate limit em camadas**, token bucket em memória sobre `sync.Map`, com
varredura periódica dos buckets ociosos:

- limite global por IP;
- limite severo em `/v1/auth/*`, contra brute-force;
- limite por usuário autenticado em upload e geração.

O IP vem de `RemoteAddr` por padrão. `X-Forwarded-For` só é considerado se um
proxy confiável estiver configurado explicitamente — caso contrário o header é
trivialmente forjável e o rate limit vira decoração.

**Upload de template** é a maior superfície de ataque. Validar: tamanho
comprimido e descomprimido (contra zip bomb), número de entradas, presença de
`word/document.xml`, e rejeitar nomes de entrada com `..` ou caminho absoluto.
`encoding/xml` não resolve entidades externas, o que já neutraliza XXE.

**Servidor HTTP** com `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout` e
`IdleTimeout` explícitos, `MaxHeaderBytes` reduzido e `http.MaxBytesReader` nos
corpos. Shutdown gracioso via `signal.NotifyContext`. Respostas de erro em
formato uniforme, sem vazar detalhe interno — `login` responde igual para
e-mail inexistente e senha errada.

## Testes

**Unitários** — sem I/O, com fakes das interfaces declaradas no `usecase`:

- `docx`: normalização de runs, extração do schema, escape de XML, renderização.
- `token`: emissão, expiração, assinatura inválida, algoritmo trocado.
- `ratelimit`: recarga do bucket com **relógio injetado**, sem `time.Sleep`.
- `usecase`: regras de validação e caminhos de erro.

**Integração** — `//go:build integration`, exercitando a pilha real:

- Repositórios contra SQLite em arquivo temporário (`t.TempDir()`).
- Handlers via `net/http/httptest` com o servidor completo montado.
- Ponta a ponta: registrar → autenticar → subir template → gerar → baixar,
  reabrindo o `.docx` resultante com `archive/zip` para confirmar que o OOXML
  não foi corrompido.
- Rotação de refresh: reapresentar um token já usado deve revogar a cadeia.
- Rate limit devolvendo `429` com `Retry-After`.

**Fixtures.** Um `.docx` mínimo gerado programaticamente no `testdata`, com um
placeholder deliberadamente partido entre runs — o caso exato que quebra
implementações ingênuas.

## Ordem de implementação

1. `go.mod`, config, `log/slog`, `main.go` com shutdown gracioso.
2. SQLite: migrations com `go:embed`, abertura, pragmas.
3. `domain` + identidade: repositórios de usuário e refresh token.
4. `platform/token` e `platform/ratelimit`.
5. Middlewares (recover, logging, rate limit, auth) e rotas `/v1/auth/*`.
6. `platform/blob`.
7. `adapter/docx`: normalização, extração de schema, renderização.
8. Casos de uso de template e documento, handlers e download.
9. Suíte de integração ponta a ponta.

## Verificação

- `go vet ./...`, `go test ./...` e `go test -tags=integration ./...` limpos.
- `go test -race ./...` — importa para o cache e o rate limiter concorrentes.
- `go build` produzindo binário estático.
- `go list -deps ./internal/domain` não pode conter pacote do próprio projeto.
- Verificação manual: subir a API, percorrer o fluxo completo com `curl` e
  **abrir o documento gerado no Word**.

---

## Estado da implementação

Concluída e verificada. Registro do que foi executado:

- `gofmt`, `go vet` e `go build ./...` limpos.
- `go test ./...` e `go test -tags=integration ./...` passando (14 pacotes).
- `go list -deps ./internal/domain` não retorna nenhum pacote do projeto — a
  regra de dependência se mantém.
- Verificação manual com o binário real e `curl`: cadastro, login, upload de um
  `.docx` com placeholder deliberadamente partido em três runs, descoberta
  automática do schema (`["amount","customer_name","plan"]`), geração e
  download. O arquivo baixado foi reaberto e validado: as quatro partes do
  pacote preservadas, `&` e `<` escapados como `&amp;` e `&lt;`, e o
  `word/document.xml` resultante parseia como XML bem-formado.
- Defesas exercitadas manualmente: 401 sem token e com token adulterado, 422
  listando de uma vez campo faltante e campo com erro de digitação, rotação de
  refresh com replay derrubando a cadeia inteira, e 429 com `Retry-After` após
  esgotar o burst em `/v1/auth/login`.

### Ressalva

O detector de corrida (`go test -race`) **não pôde ser executado** nesta
máquina: ele exige cgo e não há compilador C instalado. Vale rodar
`go test -race ./...` em um ambiente com GCC ou Clang antes de colocar em
produção — o cache de templates e o rate limiter são as áreas concorrentes que
mais se beneficiariam.

### Não implementado

Fora do escopo acordado, mas vale registrar como possível evolução: paginação
por cursor (hoje é `limit`/`offset`), quebras de linha dentro de um valor
substituído (exigiria emitir `<w:br/>`), e link de download assinado e efêmero
para o navegador baixar sem cabeçalho `Authorization`.

---

## Como retomar

### Onde está cada coisa

A API agora vive em `docgen-api/`, uma pasta do workspace do Imobiliary. Todos
os caminhos e comandos desta seção são relativos a ela; da raiz do repositório,
os scripts `pnpm api:*` fazem o equivalente.

| Arquivo | O que é |
|---|---|
| `README.md` | Ponto de entrada: como rodar, configurar e testar |
| `openapi.yaml` | **Fonte da verdade** do contrato da API (OpenAPI 3.1, validada) |
| `docgen.postman_collection.json` | Coleção para importar no HTTPie / Postman / Insomnia |
| `docs/api-reference.html` | Fonte da página de referência publicada |
| `docgen.md` | Este documento: plano, decisões e estado |

A referência publicada está em
<https://claude.ai/code/artifact/e3eaf9ee-95d7-46a0-bd7f-d596a95345ee>.
Para atualizá-la a partir de outra sessão, edite `docs/api-reference.html` e
republique **passando essa URL** — publicar sem ela cria um artifact novo em vez
de atualizar este.

### Subir o serviço

```sh
export DOCGEN_JWT_SECRET="at-least-32-bytes-of-secret-material"
go run ./cmd/docgen
```

O primeiro `go build` de uma máquina nova baixa o toolchain 1.27.1 e compila a
stdlib inteira — leva vários minutos. Depois disso o cache resolve.

### Verificar que continua são

```sh
gofmt -l . && go vet ./... && go build ./...
go test ./...
go test -tags=integration ./...
go list -deps ./internal/domain | grep docgen   # só pode retornar o próprio pacote
npx @redocly/cli lint openapi.yaml
```

### Pendências conhecidas

1. **`go test -race` nunca foi executado** — exige cgo e não há compilador C
   nesta máquina. É a primeira coisa a rodar num ambiente com GCC ou Clang.
2. Paginação é `limit`/`offset`; um cursor seria melhor para listas grandes.
3. Quebra de linha dentro de um valor substituído não vira quebra no documento
   (exigiria emitir `<w:br/>` em vez de escapar o `\n`).
4. Download exige o cabeçalho `Authorization`, o que é incômodo para o
   navegador. Um link assinado e efêmero resolveria.
