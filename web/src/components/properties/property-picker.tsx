import { useEffect, useId, useState } from "react";
import { IconSearch, IconX } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addressLine, addressPlace, type PropertySummary } from "@/domain/property";
import { listProperties } from "@/server/properties";

/**
 * Choosing one property already registered, by address, registry or IPTU.
 * Like the person picker, it asks after a short pause in typing and shows the
 * first page only.
 */
export function PropertyPicker({
  label,
  hint,
  error,
  chosen,
  onChange,
  onBlur,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly chosen: PropertySummary | null;
  readonly onChange: (property: PropertySummary | null) => void;
  readonly onBlur?: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PropertySummary[]>([]);
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
      const result = await listProperties({ data: { q } });
      if (cancelled) return;
      setSearching(false);
      setResults(result.ok ? result.value.properties : []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-search`}>{label}</Label>

      {chosen !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-small font-medium">{addressLine(chosen.address)}</span>
            <span className="truncate text-caption text-muted-foreground">{addressPlace(chosen.address)}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={`Trocar ${addressLine(chosen.address)}`}
            onClick={() => onChange(null)}
          >
            <IconX aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <IconSearch
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            />
            <Input
              id={`${id}-search`}
              type="search"
              className="pl-9"
              placeholder="Buscar pelo endereço, matrícula ou IPTU"
              value={query}
              autoComplete="off"
              aria-invalid={error !== undefined}
              {...(message === undefined ? {} : { "aria-describedby": `${id}-message` })}
              {...(onBlur === undefined ? {} : { onBlur })}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setQuery(next);
              }}
            />
          </div>

          {query.trim().length >= 2 && (
            <div aria-live="polite" className="flex flex-col gap-1">
              {searching && results.length === 0 ? (
                <p className="text-caption text-faint">Buscando...</p>
              ) : results.length === 0 ? (
                <p className="text-caption text-faint">Nenhum imóvel encontrado. Cadastre-o em Imóveis antes.</p>
              ) : (
                <ul className="flex flex-col rounded-md border border-border">
                  {results.map((property) => (
                    <li key={property.id} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
                        onClick={() => {
                          onChange(property);
                          setQuery("");
                        }}
                      >
                        <span className="text-small">{addressLine(property.address)}</span>
                        <span className="text-caption text-muted-foreground">{addressPlace(property.address)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {message !== undefined && (
        <p id={`${id}-message`} className={error === undefined ? "text-xs text-faint" : "text-xs text-destructive"}>
          {message}
        </p>
      )}
    </div>
  );
}
