import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconBuildingEstate, IconPlus, IconSearch } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addressLine, addressPlace, type PropertySummary } from "@/domain/property";
import { listProperties } from "@/server/properties";

type PropertiesSearch = { q?: string };

export const Route = createFileRoute("/_app/imoveis/")({
  validateSearch: (search: Record<string, unknown>): PropertiesSearch =>
    typeof search["q"] === "string" && search["q"] !== "" ? { q: search["q"] } : {},
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => listProperties({ data: { q: deps.q } }),
  head: () => ({ meta: [{ title: "Imóveis | Imobiliary" }] }),
  component: PropertiesPage,
});

/**
 * The office's properties, by street.
 *
 * The search box matches the street, district or city, and also the registry
 * and the IPTU registration, which is how a property is often asked about on
 * the phone.
 */
function PropertiesPage() {
  const { q } = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const [typed, setTyped] = useState(q ?? "");
  const [extra, setExtra] = useState<readonly PropertySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.value.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setCursor(result.ok ? result.value.nextCursor : null);
  }, [result]);

  useEffect(() => {
    const next = typed.trim();
    if (next === (q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({ search: next === "" ? {} : { q: next }, replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, q, navigate]);

  const properties = result.ok ? [...result.value.properties, ...extra] : [];

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const next = await listProperties({ data: { q, cursor } });
    setLoadingMore(false);
    if (next.ok) {
      setExtra((current) => [...current, ...next.value.properties]);
      setCursor(next.value.nextCursor);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Imóveis</h1>
        <Button className="ml-auto" nativeButton={false} render={<Link to="/imoveis/novo" />}>
          <IconPlus data-icon="inline-start" aria-hidden="true" />
          Novo imóvel
        </Button>
      </header>

      <div className="relative">
        <IconSearch
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
        />
        <Input
          type="search"
          aria-label="Buscar imóveis pelo endereço, matrícula ou IPTU"
          placeholder="Buscar pelo endereço, matrícula ou IPTU"
          className="pl-9"
          value={typed}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setTyped(next);
          }}
        />
      </div>

      {!result.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar os imóveis agora."}
        </p>
      ) : properties.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium">{q === undefined ? "Nenhum imóvel cadastrado ainda." : "Nenhum imóvel encontrado."}</p>
          <p className="font-reading text-small text-muted-foreground">
            {q === undefined
              ? "Cadastre os proprietários em Pessoas e depois o imóvel, com a parte de cada um."
              : "Busque por outra parte do endereço, pela matrícula ou pela inscrição do IPTU."}
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {properties.map((property) => (
              <li key={property.id} className="border-b border-border last:border-b-0">
                <Link
                  to="/imoveis/$propertyId"
                  params={{ propertyId: property.id }}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
                >
                  <IconBuildingEstate aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-faint" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{addressLine(property.address)}</span>
                    <span className="truncate text-caption text-muted-foreground">{addressPlace(property.address)}</span>
                    {property.ownerNames.length > 0 && (
                      <span className="truncate text-caption text-faint">{property.ownerNames.join(", ")}</span>
                    )}
                  </span>
                  {property.registry !== "" && (
                    <span className="ml-auto shrink-0 font-mono text-micro tracking-[0.1em] text-faint uppercase">
                      Mat. {property.registry}
                    </span>
                  )}
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
