# Fase 7: integração com o docgen

Plano da fase 7 do `PLANO.md`, com as decisões tomadas com o usuário em
2026-09-17 e o modelo de teste `contrato de locacao.docx` (locação
residencial com caução).

## 1. Decisões

| Tema | Decisão |
|---|---|
| Contas do docgen | Migram pelo e-mail: no primeiro acesso com a conta Imobiliary, os modelos, documentos e lotes da conta docgen com o mesmo e-mail passam ao escritório. O login próprio do docgen deixa de existir. |
| Posse dos modelos | Do escritório: todos os membros usam os mesmos modelos, documentos e lotes. |
| Gerar contrato | Com revisão: a plataforma preenche o modelo, mostra a prévia com cada campo editável, e só então gera. |
| Onde fica o documento | No contrato e no histórico do Docs. O contrato lista e mostra os documentos gerados para ele dentro do imobiliary.com. |
| Login do Docs | O Docs mantém sua tela de entrada, mas valida e-mail, senha e segundo fator no Imobiliary. |
| RG | Não existe no cadastro. A qualificação usa a CIN, que tem o número do CPF: o mesmo número aparece nos dois lugares. |
| Local de assinatura e foro | Campo próprio `{{.foro}}` (cidade/UF), sugerido pela cidade do imóvel (foro da situação do imóvel, Lei 8.245/91 art. 58, II) e editável na revisão. |
| Gênero e número | Do cadastro de cada pessoa. Sem gênero informado em alguma pessoa do papel, o texto fica neutro: "locatário(a)". |

## 2. O que o modelo de teste exige

- **Qualificação** de locador e locatário: nome, nacionalidade, estado civil,
  profissão, CIN e CPF, endereço com CEP. Pessoa jurídica: razão social, CNPJ,
  sede e representantes com a qualificação de cada um.
- **Garantia** em texto que muda com a modalidade: o parágrafo do modelo só
  serve para caução (valor, quantidade de aluguéis, por extenso).
- **Valores por extenso**: aluguel, caução e notas promissórias
  ("R$ 1.600,00 (mil e seiscentos reais)").
- **Datas e prazos**: início, término, prazo em meses por extenso, data do
  primeiro reajuste (início + 12 meses), índice ("IGP-M/FGV").
- **Multa e juros** do contrato, com percentual por extenso.
- **Notas promissórias**: quantidade, numeração e meses cobertos, derivados
  do cronograma.
- **Gênero e número** em todo o corpo ("a locatária" está fixo hoje).
- **Assinaturas** com o nome de cada parte; testemunhas ficam em branco.

O docgen só substitui campos simples: sem condicionais, repetição ou funções.
Por isso **quem monta os trechos variáveis é a plataforma**, e o modelo recebe
cada trecho pronto em um campo.

## 3. Vocabulário de campos

A imobiliary-api expõe `GET /v1/contracts/{id}/document-fields`, que devolve
todos os campos já calculados. A lista é fixa, documentada no OpenAPI e
mostrada ao usuário na tela de modelos, para que ele marque o próprio .docx.

| Campo | Exemplo |
|---|---|
| `contrato_numero` | 2026/001 |
| `locador_qualificacao` | MARIA DA SILVA, brasileira, casada, professora, portadora da Carteira de Identidade Nacional n.º 529.982.247-25, inscrita no CPF sob o n.º 529.982.247-25, residente e domiciliada na Rua ..., CEP 14700-000 |
| `locatario_qualificacao` | idem; várias pessoas separadas por "; e" |
| `fiador_qualificacao` | idem, com o cônjuge anuente quando houver; vazio sem fiança |
| `locador_termo`, `locatario_termo`, `fiador_termo` | "o locador", "a locadora", "os locadores", "o(a) locador(a)" |
| `locador_titulo`, `locatario_titulo` | LOCADOR, LOCADORA, LOCADORES, LOCADOR(A) |
| `imovel_endereco` | Rua das Flores, 120, apto 12, Centro, Colina/SP, CEP 14770-000 |
| `imovel_matricula`, `imovel_iptu` | como no cadastro |
| `aluguel_valor`, `aluguel_extenso` | R$ 1.600,00 / mil e seiscentos reais |
| `garantia_texto` | parágrafo pronto conforme a modalidade (caução, fiança, seguro fiança, cessão, sem garantia) |
| `caucao_valor`, `caucao_extenso`, `caucao_alugueis` | R$ 4.800,00 / quatro mil e oitocentos reais / 03 (três) |
| `prazo_meses` | 12 (doze) meses |
| `data_inicio`, `data_termino`, `data_primeiro_reajuste` | 01/10/2026 |
| `data_assinatura_extenso` | 17 de setembro de 2026 |
| `indice_reajuste` | IGP-M/FGV |
| `vencimento_dia` | 10 (dez) |
| `multa_atraso`, `juros_atraso` | 10% (dez por cento) / 1% (um por cento) ao mês |
| `promissorias_quantidade`, `promissorias_periodo` | 12 (doze) / outubro/2026 a setembro/2027 |
| `foro` | Colina/SP |
| `locador_assinatura`, `locatario_assinatura` | nomes separados por quebra de linha |

**Regras de concordância.** Uma pessoa com gênero informado concorda com ele.
Várias pessoas: todas femininas, feminino plural; alguma masculina, masculino
plural. Pessoa jurídica é tratada como feminina ("a locatária", referindo-se à
sociedade). Qualquer pessoa física do papel sem gênero deixa o papel neutro.

**Por extenso** é escrito à mão em Go, sem dependência, com testes para
centavos, milhares, milhões, "um real", "mil reais" e "e" entre grupos.

## 4. Identidade e posse

1. **Tokens para o docgen.** A imobiliary-api emite, para uma sessão válida,
   um token de 5 minutos com `aud=docgen`, `sub`, `org`, `email` e o papel,
   assinado com a mesma chave Ed25519 (`POST /v1/sessions/docgen-token`).
2. **O docgen aceita só esses tokens.** Recebe as chaves públicas por
   configuração (`DOCGEN_IDENTITY_PUBLIC_KEYS`, com `kid`), exige `iss`,
   `aud=docgen` e EdDSA. Cadastro, login, refresh e troca de senha do docgen
   são removidos; as rotas respondem 410 por um tempo.
3. **Posse pelo escritório.** Migração no SQLite: `templates`, `documents` e
   `batches` ganham `organization_id`; as consultas passam a filtrar por ele.
4. **Migração pelo e-mail.** No primeiro token de um escritório, se existir
   usuário docgen com o mesmo e-mail e ainda não migrado, seus modelos,
   documentos e lotes passam ao escritório, numa transação, com registro de
   auditoria. Um e-mail migra uma vez só.
5. **Docs.** A tela de entrada do Docs chama a imobiliary-api (senha e
   segundo fator), guarda a sessão Imobiliary no cookie e pede tokens docgen
   ao chamar o docgen. As telas de criar conta e redefinir senha passam a
   levar ao imobiliary.com.
6. **LGPD.** `PRIVACIDADE.md` dos dois lados: o docgen deixa de ser
   controlador de contas, e a exportação e exclusão de conta passam a morar
   só no Imobiliary. A política de privacidade do Docs é atualizada.

## 5. Gerar contrato na plataforma

1. **Documento ligado ao contrato.** O docgen aceita `reference` (texto até
   100 caracteres) ao gerar, e filtra por ela em `GET /v1/documents`. A
   plataforma usa `contract:<id>`.
2. **Tela.** Na página do contrato, "Gerar documento": escolher o modelo,
   ver a prévia preenchida com `document-fields` e editar qualquer campo
   (os que ficaram vazios aparecem marcados), gerar.
3. **A prévia** reaproveita o leitor de .docx e a prévia do Docs, movidos
   para `packages/` para que as duas plataformas usem o mesmo código, sem
   copiar.
4. **Documentos do contrato.** Seção na página do contrato com os
   documentos gerados: visualizar dentro do imobiliary.com (a mesma prévia,
   só leitura), baixar, excluir.
5. **Campo que o modelo pede e a plataforma não conhece** fica vazio e
   editável na revisão, com o aviso de qual é.

## 6. Etapas e commits

1. imobiliary-api: `document-fields` (qualificação, concordância, por
   extenso, garantia, promissórias), testes de unidade e integração, OpenAPI.
2. imobiliary-api: token `aud=docgen`, testes.
3. docgen-api: verificação dos tokens Imobiliary, posse por escritório,
   migração por e-mail, remoção do login próprio, `reference`, testes,
   OpenAPI e referência republicada.
4. Modelo de teste marcado: uma cópia de `contrato de locacao.docx` com os
   campos, gerada a partir do texto original, para validar a geração de ponta
   a ponta (o original não é alterado).
5. packages: leitor de .docx e prévia compartilhados; `docs` passa a usá-los,
   com as páginas iguais antes e depois.
6. docs: login pelo Imobiliary.
7. web: gerar documento com revisão, documentos do contrato com
   visualização.
8. Verificação no navegador nos dois domínios, `CLAUDE.md` e graphify.

## 7. Verificação

- Qualificação e concordância testadas para: pessoa física com e sem gênero,
  casal de locatários, dois locadores de gêneros diferentes, pessoa jurídica
  com dois representantes, fiador casado com cônjuge anuente.
- Por extenso contra uma tabela de casos.
- Um token com `aud` errado, algoritmo HS256, `kid` desconhecido ou expirado
  é recusado pelo docgen.
- Migração: um e-mail com modelos migra uma vez; outro escritório não vê
  nada; uma conta docgen sem par continua intocada.
- Ponta a ponta: contrato cadastrado, modelo de teste marcado, prévia com os
  campos, documento gerado aberto no Word (via COM, como já feito no Docs) e
  listado no contrato e no histórico.

## 8. Em aberto

- **Docs com dados reais**: `docgen-api/data/docgen.db` tem dados pessoais de
  teste em claro; a migração é o momento de descartá-lo.
- **Testemunhas** ficam em branco no documento; cadastrá-las fica para depois.
- **Assinatura eletrônica** está fora desta fase.
