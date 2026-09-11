import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old address of the data-rights screen, now a tab of Ajustes.
 *
 * Kept as a redirect because the address has been published — in the privacy
 * policy's earlier versions and in anyone's bookmarks — and an access request
 * should never end on a 404.
 */
export const Route = createFileRoute("/_app/meus-dados")({
  beforeLoad: () => {
    throw redirect({ to: "/ajustes", search: { aba: "dados" }, replace: true });
  },
});
