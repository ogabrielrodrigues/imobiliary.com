import { IconAccessible, IconPalette, IconShieldCheck, IconUser } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { PageBody, PageHeader } from "@/components/page";
import { AccessibilityPanel } from "@/components/settings/accessibility-panel";
import { AccountPanel } from "@/components/settings/account-panel";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { ExportPanel } from "@/components/settings/export-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONTROLLER } from "@/domain/legal";
import { platformLinks } from "@/server/auth";

const TABS = [
  { value: "aparencia", label: "Aparência", icon: IconPalette },
  { value: "acessibilidade", label: "Acessibilidade", icon: IconAccessible },
  { value: "seguranca", label: "Conta", icon: IconShieldCheck },
  { value: "dados", label: "Dados do escritório", icon: IconUser },
] as const;

type Tab = (typeof TABS)[number]["value"];

const DEFAULT_TAB: Tab = "aparencia";

interface SettingsSearch {
  readonly aba?: Tab;
}

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.value === value);
}

export const Route = createFileRoute("/_app/ajustes")({
  /**
   * The open tab lives in the address, so a link can point at one and a reload
   * keeps it. An unknown value falls back to the first tab rather than an
   * error: it is a preference about where to look, not data.
   */
  validateSearch: (search: Record<string, unknown>): SettingsSearch =>
    isTab(search["aba"]) ? { aba: search["aba"] } : {},
  // The platform's addresses come from the server: the deployment configures
  // them, and the account panel links to them.
  loader: async () => ({ links: await platformLinks() }),
  head: () => ({ meta: [{ title: "Ajustes | Imobiliary Docs" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { links } = Route.useLoaderData();
  const { aba = DEFAULT_TAB } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <>
      <PageHeader title="Ajustes" />
      <PageBody>
        <Tabs
          value={aba}
          onValueChange={(value) => {
            if (!isTab(value)) return;
            // replace: switching tabs is not a place to come back to. Back
            // leaves Ajustes, as it would from any other screen.
            void navigate({
              search: value === DEFAULT_TAB ? {} : { aba: value },
              replace: true,
            });
          }}
          className="gap-4"
        >
          {/* Four tabs outgrow a phone; the list scrolls sideways instead of wrapping. */}
          {/*
            Scrolls sideways on a phone, where four tabs do not fit. Two
            things keep that from showing a vertical scrollbar on a wide
            screen: overflow-x alone turns overflow-y into auto as well, so it
            is pinned hidden; and the list's fixed 32px height is released
            (with the same group-data prefix, or the component's h-8 wins on
            specificity), since icons and rem-sized text can exceed it. The
            focus ring still shows: it fits inside the list's 3px padding.
          */}
          <TabsList
            aria-label="Seções de ajustes"
            className="max-w-full self-start overflow-x-auto overflow-y-hidden group-data-horizontal/tabs:h-auto"
          >

            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="px-3">
                <tab.icon data-icon="inline-start" aria-hidden="true" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="aparencia" className="flex flex-col gap-4">
            <AppearancePanel />
          </TabsContent>

          <TabsContent value="acessibilidade" className="flex flex-col gap-4">
            <AccessibilityPanel />
          </TabsContent>

          <TabsContent value="seguranca" className="flex flex-col gap-4">
            <AccountPanel links={links} />
          </TabsContent>

          {/*
            Where the rights of article 18 are actually exercised. A policy that
            describes rights and a support address that grants them makes the
            person ask permission for something the law already gave them; both
            operations here resolve in one request.
          */}
          <TabsContent value="dados" className="flex flex-col gap-4">
            <p className="max-w-2xl text-small leading-relaxed text-muted-foreground">
              A Lei n.º 13.709/2018 (LGPD) garante a você o direito de acessar,
              levar consigo e eliminar seus dados. A cópia abaixo é imediata:
              não passa por pedido nem por análise. Os dados da sua conta, e o
              encerramento dela, ficam no{" "}
              <a href={links.account} className="text-primary-text hover:underline">
                imobiliary.com
              </a>
              . Os detalhes do que guardamos estão na{" "}
              <Link to="/privacidade" className="text-primary-text hover:underline">
                Política de Privacidade
              </Link>
              .
            </p>

            <ExportPanel />

            <p className="max-w-2xl text-caption leading-relaxed text-faint">
              Para correção de dados, dúvidas ou qualquer outro pedido, escreva
              para {CONTROLLER.privacyEmail}. Encarregado pelo tratamento de
              dados: {CONTROLLER.officerName}, {CONTROLLER.officerEmail}.
            </p>
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}
