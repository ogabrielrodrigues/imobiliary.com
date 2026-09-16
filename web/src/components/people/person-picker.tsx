import { useEffect, useId, useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";

import type { PersonSummary } from "@/domain/person";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listPeople } from "@/server/people";

/**
 * Choosing people already registered: a spouse, or a company's representatives.
 *
 * The chosen are shown as named chips; below them, a search over individuals
 * of the office. It asks the API after a short pause in typing rather than on
 * every key, and shows at most the first page: someone looking for a person
 * types more of the name, they do not scroll.
 */
export function PersonPicker({
  label,
  hint,
  error,
  chosen,
  exclude,
  multiple,
  onChange,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly chosen: readonly PersonSummary[];
  /** Ids never offered, such as the person being edited. */
  readonly exclude: readonly string[];
  readonly multiple: boolean;
  readonly onChange: (people: readonly PersonSummary[]) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PersonSummary[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const result = await listPeople({ data: { q, kind: "individual" } });
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok ? result.value.people : []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const taken = new Set([...exclude, ...chosen.map((p) => p.id)]);
  const offered = results.filter((p) => !taken.has(p.id));
  const canChoose = multiple || chosen.length === 0;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-search`}>{label}</Label>

      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={`${label}: escolhidos`}>
          {chosen.map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-1 rounded-md border border-border bg-muted py-1 pr-1 pl-2.5 text-small"
            >
              {person.name}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remover ${person.name}`}
                onClick={() => onChange(chosen.filter((p) => p.id !== person.id))}
              >
                <IconX aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canChoose && (
        <div className="relative">
          <IconSearch
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          />
          <Input
            id={`${id}-search`}
            type="search"
            className="pl-9"
            placeholder="Buscar pelo nome ou CPF"
            value={query}
            autoComplete="off"
            aria-invalid={error !== undefined}
            {...(message === undefined ? {} : { "aria-describedby": `${id}-message` })}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
            }}
          />
        </div>
      )}

      {canChoose && query.trim().length >= 2 && (
        <div aria-live="polite" className="flex flex-col gap-1">
          {searching && offered.length === 0 ? (
            <p className="text-caption text-faint">Buscando...</p>
          ) : offered.length === 0 ? (
            <p className="text-caption text-faint">Nenhuma pessoa física encontrada com esse nome.</p>
          ) : (
            <ul className="flex flex-col rounded-md border border-border">
              {offered.map((person) => (
                <li key={person.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-small hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
                    onClick={() => {
                      onChange(multiple ? [...chosen, person] : [person]);
                      setQuery("");
                    }}
                  >
                    {person.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {message !== undefined && (
        <p id={`${id}-message`} className={error === undefined ? "text-xs text-faint" : "text-xs text-destructive"}>
          {message}
        </p>
      )}
    </div>
  );
}
