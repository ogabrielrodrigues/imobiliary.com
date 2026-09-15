# Imobiliary: plano de implantação inicial

## Contexto

O repositório já tem o docgen (Imobiliary Docs): `docgen-api/` em Go 1.27 com
SQLite e `docs/` em TanStack Start, com contas, sessões e banco próprios, pronto
e verificado. Agora começa a plataforma principal, de gestão de imóveis para
locação: `imobiliary-api/` (Go 1.27, PostgreSQL 18) e `web/` (TanStack Start),
com os mesmos padrões de arquitetura, segurança, LGPD, acessibilidade e SEO.
O docgen passa a apoiar a plataforma numa fase própria, com a identidade
emitida pelo Imobiliary.

Decidido em cinco rodadas de discussão com o usuário em 2026-09-15.

Ambiente verificado: sem Docker e sem PostgreSQL instalados; winget oferece
`PostgreSQL.PostgreSQL.18` (18.6); o Go do PATH é 1.25.5 e baixa o toolchain
1.27.1 pelo `go.mod`.

---

## 1. Decisões

| Tema | Decisão |
|---|---|
| Identidade | A imobiliary-api é dona de usuários e sessões. Tokens Ed25519 com `iss`, `aud`, `kid`. O docgen aceita esses tokens só na fase 7. |
| Dono dos dados | Organização com membros; papéis `admin` e `member`. |
| Entrada de membros | Convite por e-mail, link de uso único. |
| 2FA | TOTP opcional para membro, obrigatório para admin. |
| Pessoas | Entidade `Person` única (física ou jurídica); papel pelo vínculo. |
| `identity` | Só o CPF (a CIN usa o número do CPF). Jurídica: `registration` (CNPJ alfanumérico). |
| Extras de pessoa | `email`, `phone`, `property_regime`, `spouse_id`. |
| Extras de imóvel | `municipal_registration`, `registry_office`, `share` por proprietário. |
| Extras de contrato | `starts_on`, `terminated_on`, `adjustment_index`. |
| `rent_fee` | Multa e juros de atraso (`late_fee`), mais cobranças adicionais em itens (`rent_charges`). |
| Primeira parcela | Paga no início do contrato; sem pró-rata, todas as parcelas são mês cheio. |
| Art. 20 da Lei 8.245 | Antecipado aceito em qualquer contrato; com garantia, aviso legal e ciência registrada. |
| Índice negativo | Nunca reduz o aluguel; a alíquota fica registrada como informação. |
| Repasse ao proprietário | Fase posterior a esta implantação. |
| Design | Pacote de workspace `packages/ui` compartilhado com o `docs`. |
| Dashboard | Recebimentos do mês, carteira, prazos, receita do escritório; tabelas "vencem hoje" e "em atraso". |
| PostgreSQL local | Nativo, via winget. |
| Exclusão | Apresentada sem objeção: ver 3.9. |

---

## 2. Estrutura do repositório

```
imobiliary/
├── docgen-api/        inalterado até a fase 7
├── docs/              inalterado até a fase 8 (migração para packages/ui)
├── imobiliary-api/    módulo Go `imobiliary`, env `IMOBILIARY_*`
├── web/               @imobiliary/web
└── packages/ui/       @imobiliary/ui
```

- `pnpm-workspace.yaml` ganha `web` e `packages/*`.
- Scripts da raiz com prefixo por projeto (`docgen:dev`, `docs:dev`,
  `imobiliary:dev`, `web:dev`, `*:test`, `*:check`); a seção "Running it" do
  `CLAUDE.md` muda no mesmo commit.
- Código da imobiliary-api que repete o docgen é **copiado e adaptado**, não
  compartilhado entre módulos: o docgen fica intocado e cada módulo continua
  com três dependências.

---

## 3. Modelo de dados

### 3.1 Convenções

- **Ids** UUIDv7 gerados em Go (pacote `uuid` da std). Toda tabela tem
  `created_at` e `updated_at`; tabelas editáveis têm `version`.
- **Instante x data.** Instantes: `timestamptz`, emitidos em RFC 3339 com offset
  de `America/Sao_Paulo`. Datas civis: `date`, sem fuso, tipo `domain.Date` em
  Go, sufixo `_on` (`birth_on`, `signed_on`, `starts_on`, `expires_on`,
  `terminated_on`, `due_on`, `paid_on`, `amended_on`). "Hoje" e "mês corrente"
  calculados em Go em `America/Sao_Paulo`, com `time/tzdata` embutido.
- **Dinheiro**: `domain.Money` (`int64`, centavos) e `bigint` com `CHECK >= 0`.
- **Taxas**: `domain.Rate` (`int32`, milionésimos: 10% = 100000, -3,1812% =
  -31812) e `integer`.
- **JSON**: dinheiro e taxas como string decimal (`"1500.00"`, `"-3.1812"`),
  convertidos com parser estrito na borda; malformado é 422. Nenhum float.
- **Arredondamento**: meio para cima, no centavo, em aritmética inteira com
  checagem de overflow.
- **Concorrência**: edição exige `If-Match: <version>`, divergência é 412.
  Invariantes críticas vivem em constraints; mutex em memória só no rate limiter
  e no semáforo do argon2.
- **Isolamento**: toda tabela de negócio tem `organization_id NOT NULL`; FKs
  compostas `(organization_id, id)`; RLS com
  `organization_id = current_setting('app.organization_id', true)::uuid`,
  definido por `set_config(..., true)` no início de cada transação. Sem a
  variável, nenhuma linha aparece.
- **Papéis no banco**: `imobiliary_owner` (dono, só migra) e `imobiliary_app`
  (sem DDL, sem UPDATE/DELETE em `audit_events`).
- **Extensões** (contrib do Postgres, não são dependências):
  `btree_gist`, `pg_trgm`, `unaccent`.

### 3.2 Identidade e organização

- `organizations(id, name, ...)`
- `users(id, email UNIQUE lower, name, password_hash, password_changed_at,
  terms_version, terms_accepted_at, ...)`
- `memberships(organization_id, user_id, role admin|member)`; a organização
  nunca fica sem admin (checado na transação que troca papel ou remove membro).
- `sessions` / refresh com rotação e revogação da cadeia em replay, e
  `password_resets`: desenho do docgen (`docgen-api/internal/usecase/identity.go`,
  `internal/domain/password_reset.go`).
- `invitations(id, organization_id, email, role, token_hash, expires_at,
  accepted_at, invited_by)`; aceitar cria ou vincula a conta e a membership na
  mesma transação.
- `user_totp(user_id, secret_enc, confirmed_at, last_used_step)` e
  `recovery_codes(user_id, code_hash, used_at)`.

### 3.3 Pessoas

- `people(id, organization_id, kind individual|company, email_enc, phone_enc,
  ...)`
- `individuals(person_id PK, full_name, nationality, identity_enc,
  identity_index, marital_status, property_regime, spouse_id, occupation,
  birth_on_enc, gender)`
- `companies(person_id PK, legal_name, company_name, registration_enc,
  registration_index)`
- `company_representatives(company_id, person_id)`: o LegalManager é vínculo.
- `UNIQUE(organization_id, identity_index)` e idem para `registration_index`.
- Validação: CPF por DV; CNPJ com 12 posições `[0-9A-Z]` + 2 DV numéricos,
  módulo 11 sobre (ASCII − 48) (IN RFB 2.229/2024). Fuzz tests.
- `gender` tem finalidade declarada: concordância no texto do contrato.
- Busca por nome com `pg_trgm` + `unaccent` ("joao" encontra "João"); busca
  exata por CPF/CNPJ pelo índice cego.

**Criptografia de campo** (`internal/platform/fieldcrypt`): AES-256-GCM da std;
AAD = tabela, coluna e id da linha (um texto cifrado não pode ser trocado de
linha); prefixo de versão de chave para rotação. Índice cego:
HMAC-SHA256(chave de índice, organization_id ‖ documento normalizado), por
organização para não correlacionar a mesma pessoa entre escritórios. Chaves em
`IMOBILIARY_FIELD_KEYS` e `IMOBILIARY_INDEX_KEY`; ausentes, o processo não
sobe. Listagens nunca decifram documento; o detalhe decifra.

### 3.4 Endereços

- `addresses(id, organization_id, street, number text, complement, district,
  city, uf char(2) CHECK nas 27, zip_code char(8), observation)`.
- Cada linha tem um único dono: `person_addresses(person_id, address_id, kind
  residential|correspondence|commercial, is_primary)` e
  `properties.address_id UNIQUE`. Pessoa e imóvel nunca dividem uma linha.

### 3.5 Imóveis

- `properties(id, organization_id, address_id, water_code, energy_code,
  registry, registry_office, municipal_registration, version)`.
- `property_owners(property_id, person_id, share)`; soma de `share` = 100%
  validada no domínio e conferida por constraint trigger `DEFERRABLE INITIALLY
  DEFERRED`.

### 3.6 Contratos

- `contracts(id, organization_id, property_id, contract_registry
  UNIQUE por organização, guarantee_kind none|deposit|surety|surety_insurance|
  fund_assignment, deposit_amount, rent, current_rent, admin_fee DEFAULT
  100000, late_penalty_rate, late_interest_rate, due_day 1..31,
  adjustment_index, signed_on, starts_on, expires_on, terminated_on, version)`.
- `EXCLUDE USING gist (property_id WITH =, daterange(starts_on,
  COALESCE(terminated_on, expires_on), '[]') WITH &&)`: um contrato vigente por
  imóvel, garantido pelo banco.
- `contract_parties(contract_id, person_id, role landlord|tenant|guarantor|
  guarantor_spouse)`. Padrão dos locadores: os proprietários do imóvel.
- Estruturais (não burláveis): uma modalidade por contrato (art. 37, parágrafo
  único, é uma coluna só); fiador só com `surety`; `deposit_amount` só com
  `deposit`; locatário não é fiador do próprio contrato.
- **Avisos legais com ciência** (padrão escolhido pelo usuário para o art. 20),
  em `contract_acknowledgments(contract_id, code, acknowledged_by,
  acknowledged_at)` e na auditoria. A API responde 422 com o código enquanto
  `acknowledgments` não trouxer a ciência:
  - `advance_rent`: parcela 1 no início com garantia diferente de `none`
    (Lei 8.245 arts. 20, 42 e 43, III);
  - `guarantor_spouse_consent`: fiador casado sem `guarantor_spouse`, salvo
    separação absoluta (CC art. 1.647, III; Súmula 332 STJ);
  - `deposit_limit`: caução acima de 3 aluguéis (art. 38, §2º);
  - `adjustment_period`: reajuste com menos de 12 meses desde o início ou o
    último reajuste (Lei 10.192/2001 art. 2º, §1º).
- **Cronograma** (`domain.Schedule`, puro): uma parcela por mês de prazo
  (meses entre `starts_on` e `expires_on`, arredondando para cima). Parcela 1
  vence em `starts_on`; parcela k (k ≥ 2) vence no `due_day` do mês
  `starts_on + (k − 1)`; dia inexistente cai no último dia do mês. `due_day`
  padrão: dia de `signed_on`.
- **Rescisão**: `terminated_on` encerra o período na constraint e remove as
  parcelas pendentes com vencimento posterior, na mesma transação.

### 3.7 Aditivos

- `amendments(id, organization_id, contract_id, previous_rent, indexed_rent,
  index, index_aliquot Rate, amended_on)`.
- Valor sugerido: `previous × (1 + alíquota)`; com alíquota negativa, o
  anterior. Editável (reajuste negociado).
- Na mesma transação: `contracts.current_rent` e `rent_amount` das parcelas
  pendentes com `due_on >= amended_on`.

### 3.8 Aluguéis

- `rents(id, organization_id, contract_id, sequence, due_on, rent_amount,
  late_fee, amount_paid, paid_on, UNIQUE(contract_id, due_on))`, índice parcial
  `(organization_id, due_on) WHERE paid_on IS NULL`.
- `rent_charges(id, rent_id, kind condominium|property_tax|water|energy|other,
  description, amount)`.
- Status na API: `paid` se `paid_on`; `overdue` se pendente e `due_on < hoje`;
  senão `pending`. Nada disso é gravado.
- Registrar pagamento: `UPDATE ... WHERE id = $1 AND paid_on IS NULL`; a segunda
  chamada concorrente recebe 409. `late_fee` sugerido (multa +
  juros ao mês pró-rata dia sobre aluguel + cobranças), editável. `amount_paid`
  é o recebido de fato. Sem pagamento parcial nesta implantação.
- Estorno: volta a pendente, auditado.

### 3.9 Exclusão

- Contrato com pagamento registrado não se exclui, só se rescinde; sem
  pagamento, exclusão permitida.
- Pessoa ou imóvel com vínculo: FK `RESTRICT`.
- Exclusão é `DELETE` real, auditada sem valores; sem lixeira.

---

## 4. imobiliary-api

### 4.1 Estrutura (espelho do docgen)

```
imobiliary-api/
├── cmd/imobiliary/main.go
├── internal/
│   ├── domain/     money, rate, date, identity (CPF/CNPJ), organization, user,
│   │               person, address, property, contract, schedule, amendment,
│   │               rent, errors; não importa nada do módulo
│   ├── usecase/    ports.go + identity, organization, invitation, mfa, people,
│   │               properties, contracts, amendments, rents, dashboard, privacy
│   ├── adapter/
│   │   ├── http/      server, middleware, handlers, response
│   │   ├── postgres/  db.go, repositórios, migrations/*.sql
│   │   └── mail/      Resend
│   └── platform/   config, token, password, ratelimit, fieldcrypt, totp,
│                   logging, metrics
├── openapi.yaml, README.md, PRIVACIDADE.md
```

Dependências: `github.com/jackc/pgx/v5`, `github.com/golang-jwt/jwt/v5`,
`golang.org/x/crypto`. Nenhuma outra.

### 4.2 Reaproveitar do docgen (copiar e adaptar)

- `internal/platform/password/password.go`: argon2id e semáforo global.
- `internal/platform/ratelimit/ratelimit.go` e `adapter/http/ratekey*`: chave
  IPv6 por /64, varredura acima de 100k chaves.
- `internal/adapter/mail/mail.go`: Resend por HTTP, falha fechada sem chave
  salvo `IMOBILIARY_MAIL_LOG=true`.
- `internal/usecase/identity.go`: rotação de refresh, revogação em replay,
  `password_changed_at` truncado ao segundo, cadastro sempre 202.
- `internal/platform/token/token.go`: trocar HS256 por EdDSA, com `aud` e `kid`.
- `internal/domain/errors.go`: `ValidationError`.
- `internal/adapter/sqlite/db.go`: o migrador, agora com tabela
  `schema_migrations` e `pg_advisory_lock`.

### 4.3 Transversal

- **Sessão**: access token de 15 min com `sub` e `org` (organização ativa);
  membership conferida no banco a cada requisição, na mesma transação que fixa a
  variável de RLS. Troca de organização emite novo token.
- **2FA**: login responde `mfa_required` com um desafio de 5 min, uso único;
  admin sem TOTP recebe sessão restrita às rotas de ativação. Janela ±1 passo,
  reuso do mesmo passo bloqueado, tentativas limitadas por usuário.
- **Logs operacionais**: `log/slog` JSON em stdout com `request_id`,
  `traceparent` W3C, rota (modelo, não o caminho com ids), status, duração, IP.
  Handler de redação para dados pessoais.
- **Auditoria**: `audit_events(id, organization_id, actor_id, action, entity,
  entity_id, fields text[], request_id, ip inet, occurred_at)`, gravada na
  transação da alteração.
- **Registros de acesso** (Marco Civil art. 15): `access_records(occurred_at,
  user_id, event, ip inet, port)` particionada por mês; partições com mais de 6
  meses são descartadas na inicialização e a cada 24 h.
- **Métricas**: `/metrics` em texto Prometheus, escrito à mão, em porta interna;
  `/healthz` e `/readyz`.
- **Rede**: bind em 127.0.0.1; `IMOBILIARY_TRUST_PROXY_HEADERS` como no docgen.
- **API**: REST `/v1`, paginação por cursor sobre UUIDv7, OpenAPI e página de
  referência publicada como no docgen.

---

## 5. packages/ui

Copiado do `docs` sem alterá-lo: bloco de tokens e temas de
`docs/src/styles/app.css` (Escuro, Claro, Papel, alto contraste,
`@custom-variant dark`), importação das fontes, `docs/src/domain/accessibility.ts`
e o script do head, `docs/src/lib/accessibility-storage.ts`, `cn` com
`FONT_SIZES` (`docs/src/lib/utils.ts`), `styles/contrast.test.ts` e
`utils.test.ts`. Exporta fontes TypeScript; testes com `node --test`.

Fontes: Fustat, JetBrains Mono e **Inter Variable**
(`@fontsource-variable/inter`, nova dependência) para texto longo e secundário.

---

## 6. web

### 6.1 Base

Mesma do `docs`, sem TipTap e sem Recharts: TanStack Start, Router, Query
(+ ssr-query), Form, Table v9, shadcn sobre Base UI, Tailwind 4, Tabler,
cva, tw-animate-css, `@imobiliary/ui`. Camadas `domain / application /
infrastructure / server / queries / components / routes` com
`scripts/check-layers.mjs`.

Copiar e adaptar do `docs`: `application/session.ts` (SessionManager,
RefreshCoordinator single-flight), `application/result.ts`,
`infrastructure/transport.ts`, `infrastructure/session/cookie-session-store.ts`,
`server/runtime.ts` (origem, X-Forwarded-For), `lib/form.ts`, `lib/seo.ts`,
`queries/keys.ts` (padrão `staleAfter`), `components/not-found.tsx`,
`RouteAnnouncer`, app shell com drawer, `domain/legal.ts` (produção não sobe com
placeholders).

Gotchas do `CLAUDE.md` valem aqui: `resolve.dedupe`, `optimizeDeps.include`,
`nativeButton={false}`, dialogs montados só quando pedidos, nunca
`text-[Npx]`, nunca `text-primary`, `shadcn add` com recusas via `printf`.
`shadcn init` só uma vez, e o `app.css` gerado é substituído pelo import do
pacote em seguida.

### 6.2 Rotas

- Públicas: `/`, `/entrar`, `/verificacao`, `/criar-conta`, `/esqueci-senha`,
  `/redefinir-senha`, `/convite/$token`, `/privacidade`, `/termos`,
  `/licencas`, `robots[.]txt`, `sitemap[.]xml`, `/.well-known/security[.]txt`,
  404.
- `_app`: `/dashboard`, `/pessoas` (lista, nova, `$id`), `/imoveis`,
  `/contratos` (`$id` com parcelas, aditivos e rescisão; criação em etapas:
  imóvel, partes, valores e garantia, revisão com cronograma e avisos legais),
  `/alugueis`, `/ajustes` (Aparência, Acessibilidade, Segurança com senha e
  2FA, Organização com membros e convites só para admin, Meus dados).

### 6.3 Jurídico

- Papéis LGPD: controladora dos dados de conta; operadora dos dados de
  locatários, proprietários e fiadores, cujo controlador é o escritório
  (cláusula do art. 39 nos termos). Exclusão pelo titular limitada pela guarda
  legal (art. 16, I; aluguéis prescrevem em 3 anos, CC art. 206, §3º, I).
- Cookies: só a sessão e preferências no localStorage, sem analytics; sem banner
  de consentimento, informação na política.
- `/licencas`: direitos autorais (Lei 9.610/98), licenças das fontes (OFL) e
  bibliotecas (MIT), canal de notificação. Substitui a ideia de página DMCA.
- Registro do art. 37 em `imobiliary-api/PRIVACIDADE.md`, atualizado a cada fase
  que acrescenta categoria de dado.
- Textos da plataforma sem vícios de linguagem de IA: sem travessão, sem
  enumeração em trio por hábito, sem afirmar o que o sistema não faz.

---

## 7. Fases e commits

Cada fase fecha com: testes verdes, OpenAPI e referência atualizados, Status do
`CLAUDE.md`, `graphify update .` (nunca durante teste no navegador) e commits
por bloco coerente, com mensagem detalhada.

**Fase 0: fundações**
1. Instalar PostgreSQL 18 via winget (confirmar com o usuário antes); criar
   papéis, banco `imobiliary` e modelo de testes.
2. Workspace e scripts; seção nova no `CLAUDE.md`.
3. imobiliary-api: config com falha fechada, logging, pool e migrador, health,
   métricas, desligamento gracioso; `Money`, `Rate`, `Date`, CPF/CNPJ,
   `fieldcrypt`, com unitários e fuzz; harness de integração.
4. `packages/ui`.
5. `web`: esqueleto, landing provisória, 404, CSP, SEO, camadas.
6. Investigação do start de produção do TanStack Start (item aberto do `docs`).
   Se exigir adaptador, trazer ao usuário antes de adicionar.

**Fase 1: identidade e organização.** Migrações de identidade, auditoria e
registros de acesso; cadastro com organização, login com 2FA, refresh, logout,
senha, convites, membros, TOTP, exportação e exclusão de conta. Web: telas
públicas, app shell, Ajustes, páginas legais.

**Fase 2: pessoas e endereços.** Cifragem, índice cego, busca, representantes,
cônjuge; lista, formulário e detalhe.

**Fase 3: imóveis.** Proprietários com percentuais.

**Fase 4: contratos e parcelas.** Constraint de exclusão, regras estruturais,
avisos legais, cronograma, rescisão, exclusão.

**Fase 5: aditivos.** Sugestão, índice negativo, recálculo de pendentes.

**Fase 6: aluguéis e dashboard.** Pagamento, multa e juros, cobranças, estorno,
`/alugueis`, `GET /v1/dashboard` e a tela.

**Fase 7: integração com o docgen.** Plano próprio ao chegar: docgen aceita
tokens `aud=docgen`, migração de contas por e-mail, "Gerar contrato" pelo BFF
com texto de qualificação (vários locatários, concordância de gênero).

**Fase 8: `docs` consome `packages/ui`.** Commit próprio, com o hash de estilos
computados das páginas públicas a 1280px, nos três temas, igual antes e depois.

Fora desta implantação: repasse ao proprietário, pagamento parcial, anonimização
automática ao fim da guarda, criptografia em repouso do disco, CI.

---

## 8. Verificação

- API, a cada commit: `cd imobiliary-api && gofmt -l . && go vet ./... &&
  go test ./... && go test -tags=integration ./...`; ao fim de cada fase, `-race`
  com o GCC do WinLibs no PATH, como no docgen. Integração contra PostgreSQL
  real: `TestMain` migra `imobiliary_test_template`, cada teste cria
  `CREATE DATABASE ... TEMPLATE` e o descarta.
- Testes que provam as garantias: dois pagamentos concorrentes da mesma parcela
  (um 409); dois contratos simultâneos no mesmo imóvel (um 23P01); replay de
  refresh revoga a cadeia; linha de outra organização invisível mesmo com
  consulta sem filtro (RLS); texto cifrado movido de linha falha na decifragem;
  cronograma com dia 31, fevereiro e ano bissexto; alíquota negativa mantém o
  valor; `If-Match` divergente dá 412; papel de app não consegue UPDATE em
  `audit_events`.
- Fuzz: CPF, CNPJ alfanumérico, `ParseMoney`, `ParseRate`, `ApplyRate`.
- Web: `pnpm --filter ./web check` e `pnpm --filter ./packages/ui test`;
  verificação no navegador de cada tela, nos três temas, alto contraste e a
  375px, com formulários submetidos por `requestSubmit()` (limitação conhecida
  da automação com Base UI).
- `pnpm security` estendido a `imobiliary-api` (govulncheck) e aos novos pacotes,
  provado falhando com uma dependência vulnerável plantada.
- `docs` e `docgen-api` continuam passando suas próprias verificações sem
  alteração até as fases 7 e 8.
