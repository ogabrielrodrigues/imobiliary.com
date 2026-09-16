import { createFileRoute } from "@tanstack/react-router";

import { LegalList, LegalPage, LegalSection, P } from "@/components/legal-page";
import { CONTROLLER, TERMS_OF_USE } from "@/domain/legal";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/termos")({
  head: () =>
    pageSeo({
      title: "Termos de Uso | Imobiliary",
      description: "As regras de uso da plataforma Imobiliary.",
      path: "/termos",
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage document={TERMS_OF_USE}>
      <P>
        Estes termos regem o uso do Imobiliary, plataforma de gestão de imóveis para locação
        operada por {CONTROLLER.legalName} ({CONTROLLER.cnpj}).
      </P>

      <LegalSection title="1. A conta e o escritório">
        <P>
          Ao criar uma conta você também cria um escritório, do qual passa a ser administrador. Os
          dados cadastrados pertencem ao escritório, e não à conta: quem administra pode convidar e
          remover pessoas, e um escritório nunca fica sem administrador.
        </P>
        <P>
          Você é responsável pelo sigilo da sua senha e pelos atos praticados com a sua conta.
          Administradores precisam manter a verificação em duas etapas ativa.
        </P>
      </LegalSection>

      <LegalSection title="2. Uso da plataforma">
        <LegalList>
          <li>Cadastre apenas dados que você tem base legal para tratar.</li>
          <li>Não use a plataforma para atividade ilícita nem para tentar acessar dados de outro escritório.</li>
          <li>Não tente burlar limites técnicos, medidas de segurança ou de auditoria.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="3. Nosso papel sobre os dados do escritório (art. 39 da LGPD)">
        <P>
          Em relação aos dados de locatários, proprietários, fiadores e demais pessoas que o
          escritório cadastra, atuamos como operadores. Tratamos esses dados apenas conforme as
          instruções do escritório, que é o controlador, e adotamos as medidas de segurança
          descritas na Política de Privacidade.
        </P>
        <P>
          Se recebermos um pedido de titular sobre esses dados, encaminhamos ao escritório
          responsável, que decide. Se entendermos que uma instrução viola a legislação de proteção
          de dados, comunicaremos o escritório.
        </P>
      </LegalSection>

      <LegalSection title="4. Disponibilidade">
        <P>
          Trabalhamos para manter a plataforma disponível, mas ela pode ficar indisponível por
          manutenção, falha de terceiros ou caso fortuito. Não garantimos operação ininterrupta.
        </P>
      </LegalSection>

      <LegalSection title="5. O que a plataforma não faz">
        <P>
          O Imobiliary organiza informações e cálculos a partir do que é cadastrado. Ele não presta
          consultoria jurídica, contábil ou financeira, e não substitui a conferência dos valores e
          das cláusulas por quem é responsável pelo contrato.
        </P>
      </LegalSection>

      <LegalSection title="6. Encerramento">
        <P>
          Você pode encerrar sua conta a qualquer momento. Podemos suspender ou encerrar contas que
          violem estes termos, com aviso quando for possível. O encerramento não afeta os dados que
          a lei obriga a guardar pelos prazos correspondentes.
        </P>
      </LegalSection>

      <LegalSection title="7. Alterações e foro">
        <P>
          Mudanças relevantes nestes termos são publicadas com nova versão e data de vigência.
          Aplica-se a lei brasileira, e fica eleito o foro do domicílio do usuário para questões
          de consumo.
        </P>
      </LegalSection>
    </LegalPage>
  );
}
