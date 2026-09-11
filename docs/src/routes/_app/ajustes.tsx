import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { PageBody, PageHeader } from "@/components/page";
import { AccessibilityPanel } from "@/components/settings/accessibility-panel";
import { DeletePanel } from "@/components/settings/delete-panel";
import { ExportPanel } from "@/components/settings/export-panel";
import { PasswordPanel } from "@/components/settings/password-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CONTROLLER } from "@/domain/legal";

const TABS = [
  { value: "acessibilidade", label: "Acessibilidade" },
  { value: "seguranca", label: "Segurança" },
  { value: "dados", label: "Meus dados" },
] as const;

type Tab = (typeof TABS)[number]["value"];

const DEFAULT_TAB: Tab = "acessibilidade";

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
  head: () => ({ meta: [{ title: "Ajustes — Imobiliary Docs" }] }),
  component: SettingsPage,
});

function SettingsPage() {
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
          <TabsList aria-label="Seções de ajustes" className="self-start">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="px-3">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="acessibilidade" className="flex flex-col gap-4">
            <AccessibilityPanel />
          </TabsContent>

          <TabsContent value="seguranca" className="flex flex-col gap-4">
            <PasswordPanel />
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
              levar consigo e eliminar seus dados. As duas coisas abaixo são
              imediatas — não passam por pedido nem por análise. Os detalhes do
              que guardamos estão na{" "}
              <Link to="/privacidade" className="text-primary hover:underline">
                Política de Privacidade
              </Link>
              .
            </p>

            <ExportPanel />
            <DeletePanel />

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
