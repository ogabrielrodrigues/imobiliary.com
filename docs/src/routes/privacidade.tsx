import { createFileRoute, Link } from "@tanstack/react-router";

import {
  LegalList,
  LegalPage,
  LegalSection,
  P,
} from "@/components/legal-page";
import { CONTROLLER, PRIVACY_POLICY } from "@/domain/legal";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/privacidade")({
  head: () =>
    pageSeo({
      title: "Política de Privacidade — Imobiliary Docs",
      description:
        "Como o Imobiliary Docs trata dados pessoais: o que guardamos, por " +
        "quanto tempo, com quem compartilhamos e como exercer seus direitos.",
      path: "/privacidade",
    }),
  component: PrivacyPolicyPage,
});

/**
 * The privacy policy.
 *
 * Every claim here was checked against the code before it was written. Where
 * the service does something a reader would rather it did not — keeping the
 * filled-in values indefinitely, storing them unencrypted — the text says so.
 * A policy that promises protection the system does not provide is worse than
 * no policy: it is a written misstatement.
 */
function PrivacyPolicyPage() {
  return (
    <LegalPage document={PRIVACY_POLICY}>
      <P>
        Esta política explica como o {CONTROLLER.tradeName} trata dados
        pessoais, em conformidade com a Lei n.º 13.709/2018 (LGPD). Ela descreve
        o que o sistema realmente faz — não o que seria desejável que fizesse.
      </P>

      <LegalSection title="1. Quem trata seus dados">
        <P>
          {CONTROLLER.legalName}, inscrita no CNPJ sob o n.º {CONTROLLER.cnpj},
          com sede em {CONTROLLER.address}, operadora da plataforma{" "}
          {CONTROLLER.tradeName}.
        </P>
        <P>
          Encarregado pelo tratamento de dados pessoais (art. 41):{" "}
          {CONTROLLER.officerName} — {CONTROLLER.officerEmail}.
        </P>
      </LegalSection>

      <LegalSection title="2. Dois papéis diferentes">
        <P>
          A plataforma trata dois conjuntos de dados muito distintos, e nosso
          papel legal não é o mesmo nos dois.
        </P>
        <LegalList>
          <li>
            <strong className="text-foreground">
              Somos controladores dos dados da sua conta
            </strong>{" "}
            — nome, e-mail, senha e registros de acesso. Nós decidimos coletá-los
            para que a plataforma funcione.
          </li>
          <li>
            <strong className="text-foreground">
              Somos operadores do conteúdo dos seus documentos
            </strong>{" "}
            — os valores que você preenche em um contrato, como o nome e o CPF
            de um locatário ou fiador. Quem decide coletar esses dados é você;
            nós apenas os armazenamos e processamos por sua conta e ordem. Sobre
            eles, <strong className="text-foreground">você é o controlador</strong>.
          </li>
        </LegalList>
        <P>
          Na prática: se um locatário nos pedir acesso ou exclusão dos dados que
          aparecem em um contrato, encaminharemos o pedido a você, porque a
          decisão é sua. As obrigações recíprocas estão nos{" "}
          <Link to="/termos" className="text-primary hover:underline">
            Termos de Uso
          </Link>
          .
        </P>
      </LegalSection>

      <LegalSection title="3. Que dados tratamos">
        <P>
          <strong className="text-foreground">Da sua conta:</strong> nome,
          e-mail e senha. A senha nunca é armazenada — guardamos apenas um hash
          argon2id, do qual o valor original não pode ser recuperado. Registramos
          também quando a senha foi alterada pela última vez, para invalidar
          acessos emitidos antes disso.
        </P>
        <P>
          Seu e-mail é usado para entrar na conta e para as mensagens de
          segurança: o link de redefinição de senha e o aviso de que a senha foi
          alterada. Não enviamos comunicação de marketing.
        </P>
        <P>
          <strong className="text-foreground">Dos seus modelos:</strong> o
          arquivo .docx que você envia, o nome e a descrição que você dá a ele, e
          a lista de campos que o documento declara.
        </P>
        <P>
          <strong className="text-foreground">Dos seus documentos:</strong> o
          arquivo gerado, o nome dado a ele, e{" "}
          <strong className="text-foreground">
            todos os valores que você preencheu
          </strong>
          . Estes últimos ficam guardados para que um documento possa ser
          reproduzido depois. Se você preenche o CPF de um locatário, esse CPF
          fica armazenado conosco até que você o exclua.
        </P>
        <P>
          <strong className="text-foreground">De acesso:</strong> registramos
          método, rota, código de resposta, tamanho e duração de cada
          requisição. Esses registros{" "}
          <strong className="text-foreground">
            não contêm endereço IP, e-mail, token nem o corpo das requisições
          </strong>
          .
        </P>
        <P>
          <strong className="text-foreground">Seu endereço IP</strong> é usado
          apenas para limitar tentativas abusivas de acesso. Ele fica somente na
          memória do servidor, é descartado em até dez minutos após a última
          requisição e{" "}
          <strong className="text-foreground">nunca é gravado</strong>. Não
          coletamos user agent, dispositivo, geolocalização nem qualquer dado de
          navegação.
        </P>
      </LegalSection>

      <LegalSection title="4. Com que finalidade e sob qual base legal">
        <LegalList>
          <li>
            Criar e manter sua conta, autenticar seus acessos e gerar os
            documentos que você pede — <em>execução de contrato</em> (art. 7º,
            V).
          </li>
          <li>
            Limitar tentativas abusivas de acesso e proteger a plataforma —{" "}
            <em>legítimo interesse</em> (art. 7º, IX), restrito ao mínimo
            necessário.
          </li>
          <li>
            O conteúdo dos seus documentos é tratado{" "}
            <em>mediante suas instruções</em>, na qualidade de operadores (art.
            39). A base legal aplicável a esses dados é definida por você.
          </li>
        </LegalList>
        <P>
          Não usamos seus dados para publicidade, não fazemos perfilamento e não
          tomamos decisões automatizadas sobre você.
        </P>
      </LegalSection>

      <LegalSection title="5. Cookies e armazenamento no navegador">
        <P>
          Usamos <strong className="text-foreground">um único cookie</strong>,
          chamado <code className="font-mono text-docs">
            imobiliary_docs_session
          </code>
          . Ele mantém você conectado e contém sua sessão de forma cifrada e
          assinada. É marcado <code className="font-mono text-docs">httpOnly</code>,
          o que impede que qualquer script da página o leia, e{" "}
          <code className="font-mono text-docs">SameSite=Lax</code>. Ele é
          estritamente necessário: sem ele não há login, e por isso não pedimos
          consentimento para usá-lo — informamos.
        </P>
        <P>
          Guardamos ainda, no armazenamento local do seu navegador, um único
          registro indicando que você já dispensou o aviso de cookies. Ele não
          identifica ninguém e nunca é enviado a nós.
        </P>
        <P>
          Não usamos cookies de análise, de publicidade ou de terceiros. Não há
          Google Analytics, pixel, tag manager ou ferramenta equivalente nesta
          plataforma.
        </P>
      </LegalSection>

      <LegalSection title="6. Com quem compartilhamos">
        <P>
          Não vendemos, alugamos nem cedemos dados pessoais, e não há integração
          com serviços de análise, marketing ou monitoramento. Um único terceiro
          recebe dado seu, e apenas para uma finalidade:
        </P>
        <LegalList>
          <li>
            <strong className="text-foreground">Resend</strong> (Resend, Inc.,
            Estados Unidos), que entrega nossos e-mails de segurança — o link de
            redefinição de senha e o aviso de que a senha foi alterada. Recebe
            seu endereço de e-mail e seu primeiro nome, apenas quando uma dessas
            mensagens precisa ser enviada. Atua como <em>operador</em>, sob
            nossas instruções, e não pode usar esses dados para finalidade
            própria.
          </li>
        </LegalList>
        <P>
          Como o Resend fica nos Estados Unidos, esse envio é uma{" "}
          <strong className="text-foreground">
            transferência internacional de dados
          </strong>{" "}
          (art. 33). Ela é feita sob cláusulas contratuais padrão, na forma da
          Resolução CD/ANPD n.º 19/2024, e limitada ao mínimo necessário para a
          mensagem chegar até você.
        </P>
        <P>
          Fora isso, seu navegador não faz requisição a nenhum servidor de
          terceiro ao abrir esta plataforma: as fontes tipográficas são servidas
          por nós mesmos, justamente para que o seu endereço não chegue a
          ninguém.
        </P>
        <P>
          Compartilharemos dados apenas se formos obrigados por lei, ordem
          judicial ou requisição de autoridade competente.
        </P>
      </LegalSection>

      <LegalSection title="7. Por quanto tempo guardamos">
        <LegalList>
          <li>
            <strong className="text-foreground">
              Conta, modelos e documentos:
            </strong>{" "}
            enquanto sua conta existir. Não há prazo de expurgo automático — os
            dados permanecem até que você os exclua.
          </li>
          <li>
            <strong className="text-foreground">Sessões:</strong> os registros de
            sessão expiram em 30 dias e são apagados automaticamente.
          </li>
          <li>
            <strong className="text-foreground">
              Links de redefinição de senha:
            </strong>{" "}
            30 minutos, ou até serem usados — o que vier primeiro. Guardamos
            apenas um resumo criptográfico do link, nunca ele próprio.
          </li>
          <li>
            <strong className="text-foreground">Endereço IP:</strong> até dez
            minutos, apenas em memória.
          </li>
        </LegalList>
        <P>
          Quando você exclui a conta, apagamos os registros e também os arquivos
          armazenados. Uma exceção técnica: se um arquivo seu for
          byte-a-byte idêntico ao de outra conta, ele é fisicamente um só, e
          permanece enquanto a outra conta precisar dele — os seus registros, em
          qualquer caso, são apagados.
        </P>
      </LegalSection>

      <LegalSection title="8. Segurança">
        <P>
          Adotamos as seguintes medidas técnicas (art. 46):
        </P>
        <LegalList>
          <li>
            Senhas protegidas com argon2id, com sal individual, nos parâmetros
            recomendados pela OWASP.
          </li>
          <li>
            Sessão em cookie cifrado e assinado, inacessível ao JavaScript da
            página.
          </li>
          <li>
            Isolamento por conta aplicado na própria consulta ao banco, e não
            como verificação posterior que se possa esquecer.
          </li>
          <li>
            Tráfego cifrado em trânsito (HTTPS), com HSTS e uma política de
            segurança de conteúdo restritiva.
          </li>
          <li>Limitação de tentativas de acesso por endereço e por conta.</li>
        </LegalList>
        <P>
          <strong className="text-foreground">
            O que ainda não fazemos, e você tem o direito de saber:
          </strong>{" "}
          o conteúdo dos seus documentos e os arquivos gerados são armazenados{" "}
          <strong className="text-foreground">sem criptografia em repouso</strong>
          . Isso significa que quem obtivesse acesso indevido ao servidor de
          armazenamento poderia lê-los. Estamos trabalhando nisso, e preferimos
          dizê-lo a prometer uma proteção que ainda não existe.
        </P>
      </LegalSection>

      <LegalSection title="9. Seus direitos, e como exercê-los">
        <P>
          O art. 18 da LGPD assegura a você, entre outros, os direitos de
          confirmação, acesso, correção, portabilidade, eliminação e informação
          sobre compartilhamento. Nesta plataforma:
        </P>
        <LegalList>
          <li>
            <strong className="text-foreground">Acesso e portabilidade:</strong>{" "}
            em <em>Meus dados</em>, dentro da sua conta, você baixa um arquivo
            com tudo o que guardamos, em formato aberto e legível.
          </li>
          <li>
            <strong className="text-foreground">Eliminação:</strong> na mesma
            tela, você exclui sua conta. A exclusão é imediata, definitiva e
            leva junto modelos, documentos e arquivos.
          </li>
          <li>
            <strong className="text-foreground">
              Eliminação de um documento específico:
            </strong>{" "}
            em <em>Documentos</em>, cada documento pode ser excluído
            individualmente.
          </li>
          <li>
            <strong className="text-foreground">Correção:</strong> escreva para{" "}
            {CONTROLLER.privacyEmail}.
          </li>
        </LegalList>
        <P>
          Para qualquer outro pedido, ou se algo acima não funcionar, escreva
          para {CONTROLLER.privacyEmail}. Respondemos em até 15 dias. Você
          também pode peticionar diretamente à Autoridade Nacional de Proteção
          de Dados (art. 18, §1º).
        </P>
      </LegalSection>

      <LegalSection title="10. Incidentes de segurança">
        <P>
          Se ocorrer um incidente de segurança que possa acarretar risco ou dano
          relevante a você, comunicaremos a Autoridade Nacional de Proteção de
          Dados e você, em prazo razoável, descrevendo o que aconteceu, quais
          dados foram atingidos e o que estamos fazendo a respeito (art. 48).
        </P>
      </LegalSection>

      <LegalSection title="11. Alterações desta política">
        <P>
          Se alterarmos esta política, publicaremos a nova versão aqui com nova
          numeração e nova data de vigência. Mudanças que afetem
          significativamente o tratamento dos seus dados serão comunicadas por
          e-mail antes de entrarem em vigor.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
