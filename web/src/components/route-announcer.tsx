import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";

/** The id every page gives its <main>, and the skip link's target. */
export const MAIN_CONTENT_ID = "conteudo";

/**
 * Tells a screen reader that the page changed.
 *
 * A full page load announces itself; a client-side navigation does not — the
 * content swaps silently and focus stays on the link that was clicked, which
 * may no longer exist. After each navigation to a new path this announces the
 * new title and moves focus to the main content, as a page load would.
 *
 * Only a change of path counts. A change of search alone, such as switching a
 * tab, keeps the reader where they are.
 */
export function RouteAnnouncer() {
  const router = useRouter();
  const [message, setMessage] = useState("");

  useEffect(
    () =>
      router.subscribe("onResolved", (event) => {
        if (event.fromLocation === undefined || !event.pathChanged) return;
        // A timer, not an animation frame: the head is updated in the render
        // that follows, so the title is only the new one after it, and frames
        // do not run at all in a background tab.
        window.setTimeout(() => {
          setMessage(document.title);
          // A page that already put focus somewhere inside its content, such
          // as a form focusing its first field, made a better choice than the
          // region as a whole, so it is left alone.
          const main = document.getElementById(MAIN_CONTENT_ID);
          if (main && !main.contains(document.activeElement)) {
            main.focus({ preventScroll: true });
          }
        }, 50);
      }),
    [router],
  );

  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
