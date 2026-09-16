import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { MAIN_CONTENT_ID } from "@/components/route-announcer";

const TITLE = "Página não encontrada | Imobiliary";

/**
 * The page for an address no route answers.
 *
 * The server still answers it with a 404 status, which is what keeps a crawler
 * from indexing a mistyped address as a real page. It sets its own title
 * because no route matched, so no route's head ran and the tab would keep
 * saying whatever page came before.
 */
export function NotFound() {
  useEffect(() => {
    document.title = TITLE;
  }, []);

  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className="flex min-h-dvh flex-col items-start justify-center gap-6 bg-background px-4 py-16 text-foreground md:px-8"
    >
      <Brand to="/" />
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-semibold tracking-tight">Página não encontrada</h1>
        <p className="max-w-md font-reading text-muted-foreground">
          O endereço pode estar incompleto, ou a página pode ter mudado de lugar.
        </p>
      </div>
      <Button variant="secondary" nativeButton={false} render={<Link to="/" />}>
        <IconArrowLeft data-icon="inline-start" aria-hidden="true" />
        Página inicial
      </Button>
    </main>
  );
}
