import { createFileRoute, Link } from "@tanstack/react-router";

import {
  LegalList,
  LegalPage,
  LegalSection,
  P,
} from "@/components/legal-page";
import { CONTROLLER, TERMS_OF_USE } from "@/domain/legal";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/termos")({
  head: () =>
    pageSeo({
      title: "Termos de Uso | Imobiliary Docs",
      description:
        "As regras de uso do Imobiliary Docs, incluindo as obrigações de " +
        "tratamento de dados pessoais entre você e a plataforma.",
      path: "/termos",
    }),
  component: TermsOfUsePage,
});

/**
 * The terms of use.
 *
 * Section 6 is the one that matters legally and would be easy to leave out: the
 * data-processing clause the LGPD requires (article 39) when one party
 * processes personal data on another's instructions. Without it the roles the
 * privacy policy describes have nothing behind them.
 */
function TermsOfUsePage() {
  return (
    <LegalPage document={TERMS_OF_USE}>
      <P>
        Estes termos regem o uso da plataforma {CONTROLLER.tradeName}, oferecida
        por {CONTROLLER.legalName}, CNPJ {CONTROLLER.cnpj}. Ao criar uma conta,
        você declara que os leu e concorda com eles.
      </P>

      <LegalSection title="1. O que a plataforma faz">
        <P>
          O {CONTROLLER.tradeName} recebe modelos de documento em formato .docx
          com campos marcados, descobre quais são esses campos e gera documentos
          preenchidos a partir dos valores que você fornece, preservando a
          formatação original do arquivo.
        </P>
        <P>
          A plataforma é uma ferramenta de automação de documentos.{" "}
          <strong className="text-foreground">
            Ela não presta consultoria jurídica
          </strong>{" "}
          e não verifica se um documento gerado é válido, adequado ou suficiente
          para a sua finalidade. A responsabilidade pelo conteúdo dos seus
          modelos e pelos documentos que você gera é inteiramente sua.
        </P>
      </LegalSection>

      <LegalSection title="2. Sua conta">
        <P>
          Você precisa fornecer informações verdadeiras ao criar a conta e
          manter sua senha em sigilo. Atividades realizadas com suas credenciais
          são consideradas suas. Avise-nos imediatamente em{" "}
          {CONTROLLER.privacyEmail} se suspeitar de acesso indevido.
        </P>
        <P>
          Você pode encerrar sua conta a qualquer momento, pela própria
          plataforma. O encerramento é definitivo e apaga seus modelos,
          documentos e arquivos.
        </P>
      </LegalSection>

      <LegalSection title="3. Uso aceitável">
        <P>Ao usar a plataforma, você se compromete a não:</P>
        <LegalList>
          <li>
            enviar conteúdo ilícito, ou sobre o qual não tenha os direitos
            necessários;
          </li>
          <li>
            inserir dados pessoais de terceiros sem base legal que o autorize;
          </li>
          <li>
            tentar obter acesso a contas, modelos ou documentos que não sejam
            seus;
          </li>
          <li>
            sobrecarregar deliberadamente a infraestrutura, contornar limites de
            uso ou automatizar acesso de forma abusiva.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="4. Seu conteúdo continua seu">
        <P>
          Os modelos que você envia e os documentos que você gera são seus. Não
          reivindicamos nenhuma titularidade sobre eles e não os usamos para
          qualquer finalidade além de prestar o serviço a você: não os
          analisamos, não os usamos para treinar sistemas e não os
          disponibilizamos a ninguém.
        </P>
      </LegalSection>

      <LegalSection title="5. Disponibilidade e limitação de responsabilidade">
        <P>
          Trabalhamos para manter a plataforma disponível e correta, mas ela é
          oferecida no estado em que se encontra. Não garantimos operação
          ininterrupta nem ausência de falhas.
        </P>
        <P>
          <strong className="text-foreground">
            Mantenha suas próprias cópias
          </strong>{" "}
          dos documentos que importarem para você. Nossa responsabilidade por
          perdas decorrentes do uso da plataforma limita-se, no máximo, aos
          valores pagos por você nos doze meses anteriores ao evento, salvo nos
          casos em que a lei não admita limitação.
        </P>
      </LegalSection>

      <LegalSection title="6. Tratamento de dados pessoais (art. 39 da LGPD)">
        <P>
          Esta seção rege o tratamento, por nós, dos dados pessoais que você
          insere nos documentos, tipicamente dados de locatários, fiadores e
          proprietários. Quanto a esses dados,{" "}
          <strong className="text-foreground">
            você é o controlador e nós somos o operador
          </strong>
          .
        </P>
        <P>Nós nos obrigamos a:</P>
        <LegalList>
          <li>
            tratar esses dados exclusivamente conforme suas instruções e para
            prestar o serviço, jamais para finalidade própria;
          </li>
          <li>
            adotar as medidas de segurança descritas na{" "}
            <Link to="/privacidade" className="text-primary-text hover:underline">
              Política de Privacidade
            </Link>
            , e informá-lo sobre as que ainda não adotamos;
          </li>
          <li>
            comunicá-lo sem demora sobre qualquer incidente de segurança que
            envolva esses dados;
          </li>
          <li>
            auxiliá-lo, na medida do razoável, a responder a pedidos de
            titulares e a requisições da autoridade;
          </li>
          <li>
            não subcontratar terceiros para tratar esses dados sem informá-lo
            previamente. Hoje há um único subcontratado, o Resend, que entrega
            nossos e-mails de segurança e recebe apenas o seu endereço e o seu
            primeiro nome, nunca o conteúdo dos seus documentos;
          </li>
          <li>
            eliminar esses dados quando você encerrar a conta ou solicitar sua
            exclusão.
          </li>
        </LegalList>
        <P>Você, por sua vez, declara que:</P>
        <LegalList>
          <li>
            possui base legal adequada para tratar os dados pessoais que insere
            na plataforma;
          </li>
          <li>
            é responsável por informar os titulares sobre esse tratamento e por
            atender aos pedidos que eles lhe dirigirem;
          </li>
          <li>
            não insere dados pessoais sensíveis (art. 5º, II) sem necessidade e
            sem base legal específica.
          </li>
        </LegalList>
        <P>
          Se um titular nos procurar diretamente sobre dados que constam dos
          seus documentos, encaminharemos o pedido a você, porque a decisão
          cabe a quem controla o tratamento.
        </P>
      </LegalSection>

      <LegalSection title="7. Encerramento pela nossa parte">
        <P>
          Podemos suspender ou encerrar uma conta que descumpra estes termos, de
          forma proporcional e, sempre que possível, após aviso. Em caso de
          encerramento, você terá prazo razoável para exportar seus dados, salvo
          quando a lei ou uma ordem judicial exigirem conduta diversa.
        </P>
      </LegalSection>

      <LegalSection title="8. Alterações">
        <P>
          Podemos alterar estes termos. A nova versão será publicada aqui com
          nova numeração e data de vigência, e mudanças relevantes serão
          comunicadas por e-mail antes de passarem a valer. Se você não
          concordar, pode encerrar sua conta.
        </P>
      </LegalSection>

      <LegalSection title="9. Lei aplicável e foro">
        <P>
          Estes termos são regidos pela lei brasileira. Fica eleito o foro do
          domicílio do usuário para dirimir controvérsias dele decorrentes.
        </P>
      </LegalSection>

      <LegalSection title="10. Contato">
        <P>
          {CONTROLLER.legalName}, {CONTROLLER.address}. Dúvidas sobre estes
          termos ou sobre privacidade: {CONTROLLER.privacyEmail}. Encarregado
          pelo tratamento de dados: {CONTROLLER.officerName},{" "}
          {CONTROLLER.officerEmail}.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
