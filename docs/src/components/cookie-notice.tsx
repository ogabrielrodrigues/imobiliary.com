import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

/**
 * Where the dismissal is remembered.
 *
 * localStorage rather than a cookie, deliberately: creating a second cookie to
 * manage the notice about the first one would be its own small absurdity, and
 * this is a per-browser interface preference that never needs to reach the
 * server. The privacy policy says it is here.
 */
const STORAGE_KEY = "imobiliary_docs_cookie_notice";

/**
 * How much room the notice is taking at the foot of the screen.
 *
 * Published as a custom property so the surfaces that put something at the very
 * bottom — the legal footer, the app sidebar — can hold it clear rather than
 * disappear behind it. A bar that covers the link to the privacy policy is a
 * poor way to announce a privacy policy.
 */
const SPACE_PROPERTY = "--cookie-notice-space";

/**
 * The cookie notice.
 *
 * It informs rather than asks. The only cookie this platform sets is the
 * session, which is strictly necessary — without it there is no sign-in — and a
 * necessary cookie does not require consent. Offering a "reject" button that
 * cannot reject anything would be consent theatre: worse than saying nothing,
 * because it claims a choice that does not exist.
 *
 * So there is one button, it dismisses, and the link goes to the text that
 * explains what is actually stored.
 */
export function CookieNotice() {
  // Starts hidden and appears after mount. The server cannot know whether this
  // visitor has dismissed it, so rendering it during SSR would flash the notice
  // at everyone who already said they had read it.
  const [visible, setVisible] = useState(false);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === null) {
        setVisible(true);
      }
    } catch {
      // Private browsing, or storage disabled entirely. Showing the notice
      // every visit is the honest failure: it is information, and repeating
      // information costs nothing but a click.
      setVisible(true);
    }
  }, []);

  // Republish the height whenever it changes — the text wraps to two or three
  // lines on a narrow screen, and a fixed guess would be wrong on most of them.
  useEffect(() => {
    const element = bar.current;
    const root = document.documentElement;

    if (!visible || element === null) {
      root.style.removeProperty(SPACE_PROPERTY);
      return;
    }

    const publish = () => {
      root.style.setProperty(
        SPACE_PROPERTY,
        `${element.getBoundingClientRect().height}px`,
      );
    };

    // Published straight away rather than waiting on the observer's first
    // callback, which is one frame late at best and, under React's double
    // invocation in development, can be undone by the cleanup that follows it.
    publish();

    // The observer then keeps it right: the text wraps to two or three lines on
    // a narrow screen, and a height measured once would be wrong on most of them.
    const observer = new ResizeObserver(publish);
    observer.observe(element);

    return () => {
      observer.disconnect();
      root.style.removeProperty(SPACE_PROPERTY);
    };
  }, [visible]);

  if (!visible) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "dismissed");
    } catch {
      // Nothing to do — it will be shown again next time, which is harmless.
    }
    setVisible(false);
  }

  return (
    <aside
      ref={bar}
      aria-label="Aviso sobre cookies"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-raised/95 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
        <p className="min-w-64 flex-1 text-[13px] leading-relaxed text-muted-foreground">
          Usamos um único cookie, necessário para manter você conectado. Não há
          cookies de análise, publicidade ou terceiros.{" "}
          <Link
            to="/privacidade"
            className="font-medium text-primary hover:underline"
          >
            Saiba o que guardamos
          </Link>
          .
        </p>
        <Button type="button" size="sm" onClick={dismiss}>
          Entendi
        </Button>
      </div>
    </aside>
  );
}
