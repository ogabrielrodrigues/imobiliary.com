import { IconExternalLink } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import type { PlatformLinks } from "@/server/auth";

/**
 * The account, which lives on the Imobiliary platform.
 *
 * Password, second factor and the account itself are managed there, and this
 * says so plainly rather than offering controls that would only redirect. The
 * addresses come from the server so a link never points at the wrong
 * deployment.
 */
export function AccountPanel({ links }: { readonly links: PlatformLinks }) {
  return (
    <section
      aria-labelledby="account-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id="account-title" className="text-sm font-semibold">
        Sua conta é a do Imobiliary
      </h2>
      <p className="text-small leading-relaxed text-muted-foreground">
        A senha e a verificação em duas etapas ficam no imobiliary.com, junto
        com o resto da sua conta. Alterar a senha lá encerra as sessões abertas,
        aqui incluída, e você entra de novo com a nova senha.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          nativeButton={false}
          render={<a href={links.security} />}
        >
          Senha e duas etapas
          <IconExternalLink data-icon="inline-end" aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          nativeButton={false}
          render={<a href={links.account} />}
        >
          Meus dados no imobiliary.com
          <IconExternalLink data-icon="inline-end" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
