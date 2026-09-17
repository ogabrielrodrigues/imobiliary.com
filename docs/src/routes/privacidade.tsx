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
      title: "Política de Privacidade | Imobiliary Docs",
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
        o que o sistema realmente faz, não o que seria desejável que fizesse.
      </P>

      <LegalSection title="1. Quem trata seus dados">
        <P>
          {CONTROLLER.legalName}, inscrita no CNPJ sob o n.º {CONTROLLER.cnpj},
          com sede em {CONTROLLER.address}, operadora da plataforma{" "}
          {CONTROLLER.tradeName}.
        </P>
        <P>
          Encarregado pelo tratamento de dados pessoais (art. 41):{" "}
          {CONTROLLER.officerName}, {CONTROLLER.officerEmail}.
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
            (nome, e-mail e registros de acesso). Nós decidimos coletá-los para
            que a plataforma funcione. A conta em si, com a senha e a
            verificação em duas etapas, fica no imobiliary.com: é a mesma conta,
            e é lá que ela é criada, alterada e encerrada.
          </li>
          <li>
            <strong className="text-foreground">
              Somos operadores do conteúdo dos seus documentos
            </strong>{" "}
            (os valores que você preenche em um contrato, como o nome e o CPF
            de um locatário ou fiador). Quem decide coletar esses dados é você;
            nós apenas os armazenamos e processamos por sua conta e ordem. Sobre
            eles, <strong className="text-foreground">você é o controlador</strong>.
          </li>
        </LegalList>
        <P>
          Na prática: se um locatário nos pedir acesso ou exclusão dos dados que
          aparecem em um contrato, encaminharemos o pedido a você, porque a
          decisão é sua. As obrigações recíprocas estão nos{" "}
          <Link to="/termos" className="text-primary-text hover:underline">
            Termos de Uso
          </Link>
          .
        </P>
      </LegalSection>

      <LegalSection title="3. Que dados tratamos">
        <P>
          <strong className="text-foreground">Da sua conta:</strong> nome e
          e-mail, que chegam do imobiliary.com quando você entra.{" "}
          <strong className="text-foreground">
            Nenhuma senha passa por aqui
          </strong>
          : você entra com a conta do imobiliary.com, e esta plataforma recebe
          apenas um token de cinco minutos, que serve para identificar você e o
          seu escritório. Não enviamos e-mail nem comunicação de marketing.
        </P>
        <P>
          <strong className="text-foreground">Do seu escritório:</strong> o
          nome dele, atualizado a cada acesso. Modelos e documentos pertencem ao
          escritório, e todos os seus membros trabalham com os mesmos.
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
            Identificar você e o seu escritório e gerar os documentos que você
            pede: <em>execução de contrato</em> (art. 7º, V).
          </li>
          <li>
            Limitar tentativas abusivas de acesso e proteger a plataforma:{" "}
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
          consentimento para usá-lo; apenas informamos.
        </P>
        <P>
          Guardamos ainda, no armazenamento local do seu navegador, até três
          registros: um indicando que você já dispensou o aviso de cookies;
          outro com as suas preferências de aparência e acessibilidade (tema,
          tamanho do texto, contraste e animações), se você alterar alguma em
          Ajustes; e um terceiro com o campo que você escolheu, em cada modelo,
          para completar o nome dos documentos gerados. Esse último guarda só o
          nome do campo, nunca o que foi preenchido nele. Nenhum deles
          identifica ninguém, e nenhum é enviado a nós.
        </P>
        <P>
          Não usamos cookies de análise, de publicidade ou de terceiros. Não há
          Google Analytics, pixel, tag manager ou ferramenta equivalente nesta
          plataforma.
        </P>
      </LegalSection>

      <LegalSection title="6. Com quem compartilhamos">
        <P>
          Não vendemos, alugamos nem cedemos dados pessoais, não há integração
          com serviços de análise, marketing ou monitoramento, e nenhum dado seu
          sai para um terceiro. O imobiliary.com, de onde vem a sua conta, é a
          mesma controladora desta plataforma, e a política de privacidade de lá
          descreve o que é tratado por lá.
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
            <strong className="text-foreground">Modelos e documentos:</strong>{" "}
            enquanto o escritório existir. Não há prazo de expurgo automático:
            os dados permanecem até que você os exclua.
          </li>
          <li>
            <strong className="text-foreground">Sessões:</strong> a sessão fica
            no cookie e expira em 30 dias; o token de acesso aos documentos vale
            cinco minutos e existe só na memória do servidor.
          </li>
          <li>
            <strong className="text-foreground">Endereço IP:</strong> até dez
            minutos, apenas em memória.
          </li>
        </LegalList>
        <P>
          Quando você exclui um documento, apagamos os registros e também o
          arquivo armazenado. Uma exceção técnica: se um arquivo for
          byte-a-byte idêntico ao de outro escritório, ele é fisicamente um só,
          e permanece enquanto o outro escritório precisar dele. Os seus
          registros, em qualquer caso, são apagados.
        </P>
      </LegalSection>

      <LegalSection title="8. Segurança">
        <P>
          Adotamos as seguintes medidas técnicas (art. 46):
        </P>
        <LegalList>
          <li>
            Nenhum segredo de autenticação guardado aqui: os tokens que
            recebemos do imobiliary.com são verificados com chaves públicas, de
            modo que um acesso indevido a este servidor não permite emitir
            nenhum.
          </li>
          <li>
            Sessão em cookie cifrado e assinado, inacessível ao JavaScript da
            página.
          </li>
          <li>
            Isolamento por escritório aplicado na própria consulta ao banco, e
            não como verificação posterior que se possa esquecer.
          </li>
          <li>
            Tráfego cifrado em trânsito (HTTPS), com HSTS e uma política de
            segurança de conteúdo restritiva.
          </li>
          <li>Limitação de requisições por endereço e por escritório.</li>
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
            em <em>Ajustes › Dados do escritório</em> você baixa um arquivo com
            tudo o que guardamos aqui, em formato aberto e legível.
          </li>
          <li>
            <strong className="text-foreground">
              Acesso e eliminação da sua conta:
            </strong>{" "}
            no imobiliary.com, em <em>Ajustes › Meus dados</em>, porque é lá que
            a conta existe.
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
