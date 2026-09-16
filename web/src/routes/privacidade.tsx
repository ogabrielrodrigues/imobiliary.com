import { createFileRoute } from "@tanstack/react-router";

import { LegalList, LegalPage, LegalSection, P } from "@/components/legal-page";
import { CONTROLLER, PRIVACY_POLICY } from "@/domain/legal";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/privacidade")({
  head: () =>
    pageSeo({
      title: "Política de Privacidade | Imobiliary",
      description:
        "Como o Imobiliary trata dados pessoais: o que guardamos, por quê, por quanto tempo e quais são seus direitos.",
      path: "/privacidade",
    }),
  component: PrivacyPage,
});

/**
 * The privacy policy.
 *
 * It describes what the code actually does, and says plainly where the
 * platform is a processor rather than a controller: the office decides what to
 * do with the data of its tenants and owners, and this platform only holds it
 * for them. Article 39 of the LGPD is what makes that division real, and the
 * terms carry the clause.
 */
function PrivacyPage() {
  return (
    <LegalPage document={PRIVACY_POLICY}>
      <P>
        Esta política explica como o Imobiliary trata dados pessoais. Ela vale para quem cria uma
        conta aqui e para os dados que cada escritório registra na plataforma.
      </P>

      <LegalSection title="1. Quem é o controlador">
        <P>
          {CONTROLLER.legalName}, inscrita no CNPJ {CONTROLLER.cnpj}, com sede em{" "}
          {CONTROLLER.address}, é a controladora dos dados da sua conta.
        </P>
        <P>
          Encarregado pelo tratamento de dados pessoais (art. 41 da LGPD): {CONTROLLER.officerName},
          pelo e-mail {CONTROLLER.officerEmail}. Pedidos sobre seus dados também podem ser enviados
          para {CONTROLLER.privacyEmail}.
        </P>
      </LegalSection>

      <LegalSection title="2. Dois papéis diferentes">
        <P>
          Sobre os dados da sua conta, somos controladores: decidimos que informação é necessária
          para você entrar e usar a plataforma.
        </P>
        <P>
          Sobre os dados que o escritório cadastra, somos operadores. Quem decide cadastrar um
          locatário, um proprietário ou um fiador, por qual motivo e por quanto tempo, é o
          escritório. Se você é locatário, proprietário ou fiador e quer saber o que é guardado
          sobre você, o pedido é para o escritório que administra o seu contrato: somos nós que
          guardamos, mas é ele que decide.
        </P>
      </LegalSection>

      <LegalSection title="3. O que guardamos da sua conta">
        <LegalList>
          <li>Nome, e-mail e a senha, guardada apenas como hash argon2id, nunca em texto.</li>
          <li>
            O escritório a que sua conta pertence e o papel que você tem nele: administrador ou
            membro.
          </li>
          <li>
            Se você ativou a verificação em duas etapas, o segredo dela, cifrado, e os códigos de
            recuperação, guardados apenas como hash.
          </li>
          <li>A data em que aceitou os termos e qual versão aceitou.</li>
          <li>As sessões abertas, para que você possa continuar conectado e para encerrá-las.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="4. O que guardamos do escritório">
        <P>
          Pessoas (físicas ou jurídicas), endereços, imóveis, contratos, aditivos e aluguéis, com o
          conteúdo que o escritório cadastra. Documentos de identificação, data de nascimento,
          e-mail e telefone dessas pessoas são cifrados no banco de dados. Nomes e endereços não
          são, porque precisam ser pesquisáveis; eles são protegidos por controle de acesso.
        </P>
      </LegalSection>

      <LegalSection title="5. Registros que a lei exige">
        <P>
          O Marco Civil da Internet (art. 15) obriga a guardar registros de acesso à aplicação por
          seis meses. Guardamos, para cada entrada e tentativa de entrada: data e hora com fuso,
          endereço IP e porta de origem. Esses registros ficam em sigilo e são apagados
          automaticamente depois desse prazo.
        </P>
        <P>
          Se você excluir sua conta, esses registros continuam ligados a ela até completar os seis
          meses, e guardamos o e-mail da conta, cifrado, para que ainda identifiquem alguém. Os dois
          são apagados ao fim do prazo. A base legal é o cumprimento de obrigação legal (arts. 7º, II
          e 16, I da LGPD).
        </P>
        <P>
          Mantemos também uma trilha de auditoria do que foi alterado na plataforma: quem fez, o
          quê, quando e quais campos mudaram. Ela registra os nomes dos campos, nunca os valores.
          Quando uma conta é excluída, as entradas dela continuam na trilha do escritório, sem
          apontar para a conta.
        </P>
      </LegalSection>

      <LegalSection title="6. Cookies e armazenamento no navegador">
        <P>
          Usamos um único cookie, estritamente necessário, que guarda sua sessão de forma cifrada e
          assinada. Sem ele não há como manter você conectado. Não usamos cookies de análise,
          publicidade ou rastreamento, e por isso não há banner pedindo consentimento.
        </P>
        <P>
          Guardamos também, no seu navegador e apenas nele, as preferências de aparência e
          acessibilidade (tema, tamanho do texto, contraste e redução de efeitos), sob a chave
          imobiliary_accessibility. Esses dados não são enviados a lugar nenhum.
        </P>
      </LegalSection>

      <LegalSection title="7. Com quem compartilhamos">
        <P>
          Com quem hospeda a infraestrutura e com o serviço que entrega nossos e-mails
          transacionais (Resend, nos Estados Unidos), que recebe apenas o endereço e o conteúdo da
          mensagem. Esse envio é uma transferência internacional de dados, feita com base nas
          cláusulas-padrão previstas na LGPD. Não vendemos dados pessoais e não os usamos para
          publicidade.
        </P>
      </LegalSection>

      <LegalSection title="8. Por quanto tempo">
        <LegalList>
          <li>Dados da conta: enquanto ela existir.</li>
          <li>
            E-mail de uma conta excluída, cifrado: seis meses, junto dos registros de acesso dela.
          </li>
          <li>Registros de acesso: seis meses, como manda o Marco Civil.</li>
          <li>
            Contratos, aluguéis e as pessoas ligadas a eles: enquanto o escritório precisar deles
            para cumprir obrigações legais e exercer direitos. A cobrança de aluguel prescreve em
            três anos (art. 206, §3º, I do Código Civil), e obrigações fiscais pedem prazos
            próprios.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="9. Seus direitos">
        <P>
          A LGPD (art. 18) garante confirmação e acesso, correção, anonimização, bloqueio ou
          eliminação de dados desnecessários, portabilidade, informação sobre compartilhamento e
          revogação de consentimento. Escreva para {CONTROLLER.privacyEmail} e respondemos no prazo
          legal.
        </P>
        <P>
          Dois deles ficam disponíveis direto em Ajustes, na aba Meus dados: baixar uma cópia dos dados
          da sua conta, em JSON, e excluir a conta. A exclusão pede a sua senha e é imediata. Um
          escritório que só tem você como membro é excluído junto. Se você for o único
          administrador de um escritório com outros membros, precisa passar a administração a
          alguém antes.
        </P>
        <P>
          A eliminação tem limite: quando a guarda é obrigação legal ou necessária para exercer
          direitos em processo, os dados são mantidos pelo prazo correspondente (art. 16 da LGPD).
          Dizemos isso porque prometer apagar tudo seria mentira.
        </P>
      </LegalSection>

      <LegalSection title="10. Segurança">
        <P>
          Senhas com argon2id, segundo fator obrigatório para administradores, sessões que se
          renovam com detecção de reuso, dados sensíveis cifrados no banco, fontes servidas do
          próprio domínio, política de segurança de conteúdo restritiva e registros de auditoria
          que não podem ser alterados pela aplicação.
        </P>
      </LegalSection>

      <LegalSection title="11. Mudanças">
        <P>
          Se esta política mudar de forma relevante, publicamos a nova versão com a data de vigência
          e avisamos na plataforma. As versões anteriores continuam identificadas pelo número.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
