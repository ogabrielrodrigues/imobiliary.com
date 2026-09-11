import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { IconFileText, IconFiles, IconLogout, IconSettings } from "@tabler/icons-react";

import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import type { User } from "@/domain/user";
import { cn } from "@/lib/utils";
import { currentUser, logout } from "@/server/auth";

export const Route = createFileRoute("/_app")({
  /**
   * The guard. Running it in `beforeLoad` means an unauthenticated visitor is
   * redirected before any child route loads its data, so no request is made on
   * behalf of a session that does not exist.
   */
  beforeLoad: async () => {
    const user = await currentUser();
    if (user === null) {
      throw redirect({ to: "/entrar" });
    }
    return { user };
  },
  head: () => ({
    // Everything behind sign-in is kept out of search results. A dashboard has
    // nothing to offer a crawler, and its titles would leak the product's
    // shape for no benefit.
    meta: [{ name: "robots", content: "noindex, nofollow" }],
  }),
  component: AppShell,
});

const NAV = [
  { to: "/templates", label: "Templates", icon: IconFileText },
  { to: "/documentos", label: "Documentos", icon: IconFiles },
] as const;

function AppShell() {
  const { user } = Route.useRouteContext();

  return (
    // The shell is exactly one viewport tall and never scrolls itself; the
    // page body inside it does. Anything taller — min-h-dvh, say — lets a long
    // document stretch the row, and the sidebar is stretched with it, which
    // pushes the account block below the fold.
    //
    // svh rather than dvh: dvh re-measures as mobile browser chrome collapses,
    // which would resize the shell mid-scroll. With the document no longer
    // scrolling, the chrome never auto-collapses and the two agree anyway.
    <div className="flex h-svh overflow-hidden pb-[var(--cookie-notice-space,0px)]">
      <Sidebar user={user} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

function Sidebar({ user }: { readonly user: User }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  async function onSignOut() {
    await logout({ data: undefined });
    await navigate({ to: "/entrar" });
  }

  return (
    // Scrolls on its own: with the shell clipped to one viewport, a short
    // window would otherwise cut off the account block with no way to reach it.
    // mt-auto still behaves — an auto margin absorbs free space when there is
    // any and collapses to nothing when the content overflows.
    <aside className="flex w-52 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-raised px-3.5 py-5">
      {/* Inside the app, home is the model list, not the landing page. */}
      {/*
        20px, against the 13.5px of the navigation below: enough of a step to
        read as the heading of the region rather than another item in the
        list. At 16px the mark filled a little over half the column and left
        the rest empty, which is what made it look adrift.

        px-2.5 is the sidebar's one inset — nav links, the account row and the
        sign-out button all use it, so every left edge lands on the same line.
      */}
      <Brand to="/templates" className="px-2.5 text-title" />

      <nav aria-label="Seções" className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-control transition-colors",
                active
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
              )}
            >
              {/* The active entry's icon takes the accent the dot used to carry. */}
              <item.icon
                aria-hidden="true"
                className={cn("size-4 shrink-0", active && "text-primary-text")}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3.5">
        {/*
          Account-level settings sit with the account, not with the work. A nav
          of its own, so a screen reader lists it as a separate landmark from
          the sections above.
        */}
        <nav aria-label="Conta">
          <Link
            to="/ajustes"
            aria-current={pathname.startsWith("/ajustes") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-control transition-colors",
              pathname.startsWith("/ajustes")
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
            )}
          >
            <IconSettings
              aria-hidden="true"
              className={cn("size-4 shrink-0", pathname.startsWith("/ajustes") && "text-primary-text")}
            />
            Ajustes
          </Link>
        </nav>

        <div className="flex items-center gap-2.5 px-2.5">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-border text-label font-semibold text-muted-foreground"
          >
            {initialsOf(user.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-caption font-medium">
              {user.name}
            </span>
            <span className="truncate text-label text-faint">
              {user.email}
            </span>
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={onSignOut}
          className="h-8 justify-start gap-2.5 px-2.5 text-small text-muted-foreground"
        >
          <IconLogout aria-hidden="true" className="size-4 shrink-0" />
          Sair
        </Button>
      </div>
    </aside>
  );
}

/** Up to two initials, for the avatar. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts.at(0)?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? "") : "";
  return (first + last).toUpperCase();
}
