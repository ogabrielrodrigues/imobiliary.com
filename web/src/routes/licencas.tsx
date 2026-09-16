import { createFileRoute } from "@tanstack/react-router";

import { LegalList, LegalPage, LegalSection, P } from "@/components/legal-page";
import { CONTROLLER, LICENCES } from "@/domain/legal";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/licencas")({
  head: () =>
    pageSeo({
      title: "Direitos autorais e licenças | Imobiliary",
      description:
        "Créditos das fontes e bibliotecas usadas no Imobiliary, e como notificar uma violação de direitos autorais.",
      path: "/licencas",
    }),
  component: LicencesPage,
});

/**
 * Credits, and the notice channel.
 *
 * There is no DMCA procedure here on purpose: the DMCA is United States law
 * for services that host third-party content, and this platform publishes
 * nothing of anyone's. What applies is Brazilian: Lei 9.610/98 for copyright,
 * and the Marco Civil (arts. 19 and 21) for what a provider must do when
 * notified.
 */
function LicencesPage() {
  return (
    <LegalPage document={LICENCES}>
      <P>
        O Imobiliary é construído sobre software livre e fontes abertas. Esta página diz o que
        usamos e sob qual licença.
      </P>

      <LegalSection title="Fontes">
        <LegalList>
          <li>Fustat, sob SIL Open Font License 1.1, usada na interface.</li>
          <li>Inter, sob SIL Open Font License 1.1, usada nos textos longos e nas tabelas.</li>
          <li>JetBrains Mono, sob SIL Open Font License 1.1, usada em códigos e rótulos.</li>
        </LegalList>
        <P>
          As três são servidas do nosso próprio domínio. Nenhuma requisição de fonte sai para
          terceiros, o que também é o que permite a política de segurança de conteúdo ser
          restritiva.
        </P>
      </LegalSection>

      <LegalSection title="Bibliotecas">
        <LegalList>
          <li>React e React DOM, licença MIT.</li>
          <li>TanStack Start, Router e Form, licença MIT.</li>
          <li>Base UI e shadcn/ui, licença MIT.</li>
          <li>Tailwind CSS, licença MIT.</li>
          <li>Tabler Icons, licença MIT.</li>
          <li>pgx, licença MIT, e golang-jwt, licença MIT, no lado da API.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Conteúdo do escritório">
        <P>
          O que cada escritório cadastra é dele. Não reivindicamos direitos sobre esses dados e não
          os usamos para outra finalidade que não operar a plataforma.
        </P>
      </LegalSection>

      <LegalSection title="Notificação de violação de direitos autorais">
        <P>
          Se você acredita que algum conteúdo aqui viola direitos autorais seus, escreva para{" "}
          {CONTROLLER.privacyEmail} identificando a obra, onde ela aparece e a titularidade. A Lei
          9.610/98 rege a matéria no Brasil; nos termos do Marco Civil da Internet (arts. 19 e 21),
          a retirada de conteúdo de terceiros depende de ordem judicial, salvo nas hipóteses que a
          própria lei excepciona.
        </P>
        <P>
          Não adotamos o procedimento do DMCA: é lei dos Estados Unidos, voltada a serviços que
          hospedam conteúdo público de terceiros, o que esta plataforma não faz.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
