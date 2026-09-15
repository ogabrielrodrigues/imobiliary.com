import { useBlocker } from "@tanstack/react-router";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Asks before leaving a document with changes nobody saved.
 *
 * The router's blocker covers links and the back button, and while it is
 * registered it also answers the browser's `beforeunload`, so a reload or a
 * closed tab gets the browser's own prompt. The dialog is mounted only while a
 * navigation waits on it: a Base UI dialog does not survive hydration here.
 */
export function UnsavedChangesGuard({ when }: { readonly when: boolean }) {
  const leaving = useBlocker({
    shouldBlockFn: () => true,
    disabled: !when,
    enableBeforeUnload: true,
    withResolver: true,
  });

  if (leaving.status !== "blocked") return null;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) leaving.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
          <AlertDialogDescription>
            As alterações feitas no modelo desde a última vez que ele foi salvo serão perdidas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Continuar editando</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => leaving.proceed()}>
            Sair sem salvar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
