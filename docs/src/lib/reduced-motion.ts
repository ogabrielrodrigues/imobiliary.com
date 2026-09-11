import { useSyncExternalStore } from "react";

/**
 * Whether the page asks for reduced motion, as resolved on <html> by the head
 * script and AppearanceSync — the reader's choice or the system's.
 *
 * CSS already stills transitions, but a chart library animates in JavaScript,
 * so it has to be told. The server answers false; the browser corrects it on
 * hydration.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-motion"],
      });
      return () => observer.disconnect();
    },
    () => document.documentElement.getAttribute("data-motion") === "reduce",
    () => false,
  );
}
