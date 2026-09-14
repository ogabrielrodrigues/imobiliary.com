import { IconArrowLeft } from "@tabler/icons-react";
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";

import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";

const TITLE = "Página não encontrada | Imobiliary Docs";

/**
 * The page for an address no route answers.
 *
 * It sits in the same frame as the credential screens: it is reached signed in
 * or not, and that frame already works for both. It offers the landing page and
 * the dashboard; the dashboard's own guard sends a signed-out visitor to sign
 * in, so there is no need to know here who is looking.
 *
 * The server answers it with a 404 status, which is what keeps a crawler from
 * indexing a mistyped address as a real page.
 */
export function NotFound() {
  // No route matched, so no route's head sets the title; the tab would keep
  // saying whatever page came before.
  useEffect(() => {
    document.title = TITLE;
  }, []);

  return (
    <AuthLayout
      title="Página não encontrada"
      subtitle="O endereço pode estar incompleto, ou a página pode ter mudado de lugar."
      footer={<>Se você chegou aqui por um link da própria plataforma, ele está quebrado.</>}
    >
      <div className="flex flex-wrap gap-2">
        <Button nativeButton={false} render={<Link to="/dashboard" />}>
          Ir para o dashboard
        </Button>
        <Button variant="secondary" nativeButton={false} render={<Link to="/" />}>
          <IconArrowLeft data-icon="inline-start" aria-hidden="true" />
          Página inicial
        </Button>
      </div>
    </AuthLayout>
  );
}
