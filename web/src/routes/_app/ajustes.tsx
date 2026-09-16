import { IconAccessible, IconBuilding, IconPalette, IconShieldCheck } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AccessibilityPanel } from "@/components/settings/accessibility-panel";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { OrganizationPanel } from "@/components/settings/organization-panel";
import { PasswordPanel } from "@/components/settings/password-panel";
import { SecondFactorPanel } from "@/components/settings/second-factor-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { account } from "@/server/auth";
import { organizationView } from "@/server/organization";

const TABS = [
  { value: "aparencia", label: "Aparência", icon: IconPalette },
  { value: "acessibilidade", label: "Acessibilidade", icon: IconAccessible },
  { value: "seguranca", label: "Segurança", icon: IconShieldCheck },
  { value: "escritorio", label: "Escritório", icon: IconBuilding },
] as const;

type Tab = (typeof TABS)[number]["value"];

const DEFAULT_TAB: Tab = "aparencia";

function isTab(value: unknown): value is Tab {
  return TABS.some((tab) => tab.value === value);
}

export const Route = createFileRoute("/_app/ajustes")({
  /**
   * The open tab lives in the address, so a link can point at one and a reload
   * keeps it. An unknown value falls back to the first tab rather than an
   * error: it is a preference about where to look, not data.
   */
  validateSearch: (search: Record<string, unknown>): { aba?: Tab } =>
    isTab(search["aba"]) ? { aba: search["aba"] } : {},
  loader: async () => ({
    account: await account(),
    organization: await organizationView(),
  }),
  head: () => ({ meta: [{ title: "Ajustes | Imobiliary" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { aba = DEFAULT_TAB } = Route.useSearch();
  const { user } = Route.useRouteContext();
  const data = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const recoveryCodesLeft = data.account.ok ? data.account.value.recoveryCodesLeft : 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Ajustes</h1>

      <Tabs
        value={aba}
        onValueChange={(value) => {
          if (!isTab(value)) return;
          // replace: switching tabs is not a place to come back to. Back
          // leaves Ajustes, as it would from any other screen.
          void navigate({ search: value === DEFAULT_TAB ? {} : { aba: value }, replace: true });
        }}
        className="gap-4"
      >
        {/* Four tabs outgrow a phone, so the list scrolls sideways rather than
            wrapping. overflow-y is pinned hidden because overflow-x alone
            turns it into auto and a 1px subpixel overflow would show a bar. */}
        <TabsList className="h-auto overflow-x-auto overflow-y-hidden">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
              <tab.icon aria-hidden="true" className="size-4" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="aparencia">
          <AppearancePanel />
        </TabsContent>

        <TabsContent value="acessibilidade">
          <AccessibilityPanel />
        </TabsContent>

        <TabsContent value="seguranca" className="flex flex-col gap-4">
          <SecondFactorPanel user={user} recoveryCodesLeft={recoveryCodesLeft} />
          <PasswordPanel />
        </TabsContent>

        <TabsContent value="escritorio">
          {data.organization.ok ? (
            <OrganizationPanel
              user={user}
              members={data.organization.value.members}
              invitations={data.organization.value.invitations}
            />
          ) : (
            <p className="text-small text-muted-foreground">
              Não foi possível carregar o escritório agora. Recarregue a página.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
