import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconBuilding, IconPlus, IconSearch, IconUser } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KIND_LABELS, type PersonKind, type PersonSummary } from "@/domain/person";
import { cn } from "@/lib/utils";
import { listPeople } from "@/server/people";

type KindFilter = "fisica" | "juridica";

const KIND_OF: Record<KindFilter, PersonKind> = { fisica: "individual", juridica: "company" };

export const Route = createFileRoute("/_app/pessoas/")({
  // The search and the filter live in the address, so a reload or a shared
  // link shows the same list.
  validateSearch: (search: Record<string, unknown>): PeopleSearch => ({
    q: typeof search["q"] === "string" && search["q"] !== "" ? search["q"] : undefined,
    tipo: search["tipo"] === "fisica" || search["tipo"] === "juridica" ? search["tipo"] : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q, tipo: search.tipo }),
  loader: ({ deps }) =>
    listPeople({ data: { q: deps.q, kind: deps.tipo === undefined ? undefined : KIND_OF[deps.tipo] } }),
  head: () => ({ meta: [{ title: "Pessoas | Imobiliary" }] }),
  component: PeoplePage,
});

type PeopleSearch = { q?: string | undefined; tipo?: KindFilter | undefined };

/** Sets or removes one search key; an absent key, never an undefined one. */
function withSearch<K extends keyof PeopleSearch>(
  prev: PeopleSearch,
  key: K,
  value: PeopleSearch[K] | undefined,
): PeopleSearch {
  const next: PeopleSearch = { ...prev };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * The office's people, alphabetical.
 *
 * One search box serves names and documents alike: typing a CPF or CNPJ finds
 * that document exactly, anything else matches part of a name without regard
 * to accents. Further pages are appended on request rather than numbered,
 * since the API pages by cursor and knows no total.
 */
function PeoplePage() {
  const { q, tipo } = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const [typed, setTyped] = useState(q ?? "");
  const [extra, setExtra] = useState<readonly PersonSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.value.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);

  // A new first page replaces whatever was appended to the previous one.
  useEffect(() => {
    setExtra([]);
    setCursor(result.ok ? result.value.nextCursor : null);
  }, [result]);

  // The address follows the box after a pause, so each keystroke is not a
  // navigation and a request.
  useEffect(() => {
    const next = typed.trim();
    if (next === (q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({ search: (prev) => withSearch(prev, "q", next === "" ? undefined : next), replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, q, navigate]);

  const people = result.ok ? [...result.value.people, ...extra] : [];

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const next = await listPeople({
      data: { q, kind: tipo === undefined ? undefined : KIND_OF[tipo], cursor },
    });
    setLoadingMore(false);
    if (next.ok) {
      setExtra((current) => [...current, ...next.value.people]);
      setCursor(next.value.nextCursor);
    }
  }

  const filters: readonly { value: KindFilter | undefined; label: string }[] = [
    { value: undefined, label: "Todas" },
    { value: "fisica", label: "Pessoas físicas" },
    { value: "juridica", label: "Pessoas jurídicas" },
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Pessoas</h1>
        <Button className="ml-auto" nativeButton={false} render={<Link to="/pessoas/nova" />}>
          <IconPlus data-icon="inline-start" aria-hidden="true" />
          Nova pessoa
        </Button>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          />
          <Input
            type="search"
            aria-label="Buscar pessoas pelo nome, CPF ou CNPJ"
            placeholder="Buscar pelo nome, CPF ou CNPJ"
            className="pl-9"
            value={typed}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setTyped(next);
            }}
          />
        </div>
        <nav aria-label="Filtrar por tipo" className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <Link
              key={filter.label}
              from={Route.fullPath}
              search={(prev) => withSearch(prev, "tipo", filter.value)}
              replace
              aria-current={tipo === filter.value ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-small font-medium",
                tipo === filter.value
                  ? "border-primary-text bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:bg-row-hover",
              )}
            >
              {filter.label}
            </Link>
          ))}
        </nav>
      </div>

      {!result.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar as pessoas agora."}
        </p>
      ) : people.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium">
            {q === undefined && tipo === undefined ? "Nenhuma pessoa cadastrada ainda." : "Ninguém encontrado."}
          </p>
          <p className="font-reading text-small text-muted-foreground">
            {q === undefined && tipo === undefined
              ? "Cadastre proprietários, locatários e fiadores uma vez e use o mesmo cadastro em todos os contratos."
              : "Confira a grafia ou busque por outra parte do nome."}
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {people.map((person) => (
              <li key={person.id} className="border-b border-border last:border-b-0">
                <Link
                  to="/pessoas/$personId"
                  params={{ personId: person.id }}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
                >
                  {person.kind === "company" ? (
                    <IconBuilding aria-hidden="true" className="size-4.5 shrink-0 text-faint" />
                  ) : (
                    <IconUser aria-hidden="true" className="size-4.5 shrink-0 text-faint" />
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{person.name}</span>
                    {person.tradeName !== "" && (
                      <span className="truncate text-caption text-muted-foreground">{person.tradeName}</span>
                    )}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-micro tracking-[0.1em] text-faint uppercase">
                    {KIND_LABELS[person.kind]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {cursor !== null && (
            <Button variant="secondary" className="self-center" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Carregando..." : "Mostrar mais"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
