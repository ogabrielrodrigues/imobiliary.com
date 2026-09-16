import { useState } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import {
  IconBuildingEstate,
  IconFileDescription,
  IconLayoutDashboard,
  IconLogout,
  IconMenu2,
  IconSettings,
  IconUsers,
} from "@tabler/icons-react";

import { Brand } from "@/components/brand";
import { MAIN_CONTENT_ID } from "@/components/route-announcer";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { currentUser, signOut, type CurrentUser } from "@/server/auth";

export const Route = createFileRoute("/_app")({
  /**
   * The guard. Running it in `beforeLoad` means an unauthenticated visitor is
   * redirected before any child route loads its data, so no request is made on
   * behalf of a session that does not exist.
   *
   * An administrator who still owes a second factor is sent to the settings
   * screen, where the only thing they can do is enrol one. Everything else
   * would meet the API's refusal anyway.
   */
  beforeLoad: async ({ location }) => {
    const user = await currentUser();
    if (user === null) {
      throw redirect({ to: "/entrar" });
    }
    if (user.mfaEnrollmentRequired && location.pathname !== "/ajustes") {
      throw redirect({ to: "/ajustes", search: { aba: "seguranca" } });
    }
    return { user };
  },
  component: AppLayout,
});

interface NavItem {
  readonly to: "/dashboard" | "/pessoas" | "/ajustes";
  readonly label: string;
  readonly icon: typeof IconLayoutDashboard;
}

/**
 * The navigation, in the order the work happens: the day's figures, then what
 * the office manages, then the account.
 *
 * The entries beyond the dashboard and the settings lead nowhere yet. They are
 * here so the shape of the product is visible from the first screen, and each
 * gains its own route in the phase that builds it.
 */
const PRIMARY: readonly NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: IconLayoutDashboard },
  { to: "/pessoas", label: "Pessoas", icon: IconUsers },
];

const SOON: readonly { label: string; icon: typeof IconLayoutDashboard }[] = [
  { label: "Imóveis", icon: IconBuildingEstate },
  { label: "Contratos", icon: IconFileDescription },
];

function AppLayout() {
  const { user } = Route.useRouteContext();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground md:flex-row">
      {/* Below md the sidebar becomes a drawer behind this bar. */}
      <div className="flex items-center gap-3 border-b border-border bg-raised px-4 py-3 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Abrir menu"
          onClick={() => setDrawerOpen(true)}
        >
          <IconMenu2 aria-hidden="true" />
        </Button>
        <Brand to="/dashboard" />
      </div>

      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-raised md:flex">
        <SidebarContent user={user} pathname={pathname} onNavigate={() => undefined} />
      </aside>

      {/* Mounted only once asked for: a Base UI dialog has nothing to render
          on the server, and rendering its root during hydration takes the whole
          route into the error boundary. */}
      {drawerOpen && (
        <Sheet open onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="w-64 bg-raised p-0">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SidebarContent user={user} pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
      )}

      {/*
        min-h-0 is load-bearing: a flex-1 item in a column refuses to shrink
        below its content without it, and this would never scroll.
      */}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarContent({
  user,
  pathname,
  onNavigate,
}: {
  readonly user: CurrentUser;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="hidden md:block">
        <Brand to="/dashboard" />
      </div>

      <nav aria-label="Principal" className="flex flex-col gap-1">
        {PRIMARY.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-small font-medium",
              pathname === item.to || pathname.startsWith(`${item.to}/`)
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
            )}
          >
            <item.icon aria-hidden="true" className="size-4.5" />
            {item.label}
          </Link>
        ))}

        {SOON.map((item) => (
          <span
            key={item.label}
            aria-disabled="true"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-small font-medium text-disabled-foreground"
          >
            <item.icon aria-hidden="true" className="size-4.5" />
            {item.label}
            <span className="ml-auto font-mono text-micro tracking-[0.1em] uppercase">em breve</span>
          </span>
        ))}
      </nav>

      <nav aria-label="Conta" className="mt-auto flex flex-col gap-1">
        <Link
          to="/ajustes"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-small font-medium",
            pathname === "/ajustes"
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
          )}
        >
          <IconSettings aria-hidden="true" className="size-4.5" />
          Ajustes
        </Link>

        <div className="mt-2 flex flex-col gap-1 rounded-md border border-border px-3 py-2.5">
          <span className="truncate text-small font-medium">{user.user.name}</span>
          <span className="truncate text-caption text-faint">{user.organization.name}</span>
          <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">
            {user.role === "admin" ? "administrador" : "membro"}
          </span>
        </div>

        <Button
          variant="ghost"
          className="justify-start px-3 text-muted-foreground"
          onClick={async () => {
            onNavigate();
            await signOut();
            // A full navigation rather than a client one: every cached loader
            // result belongs to the session that just ended.
            window.location.assign("/entrar");
          }}
        >
          <IconLogout aria-hidden="true" className="size-4.5" />
          Sair
        </Button>
      </nav>
    </div>
  );
}
