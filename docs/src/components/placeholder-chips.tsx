import { groupPlaceholders, placeholderSyntax } from "@imobiliary/docx/placeholder";

/**
 * The fields a template declares, grouped for reading.
 *
 * The API's names are flat — `locatario_nome`, never `locatario.nome` — so the
 * hierarchy is produced here from a shared prefix, and only when two or more
 * names actually share one. Grouping is appearance; what gets sent is always
 * the flat name, which is why each chip still shows it.
 */
export function PlaceholderChips({
  names,
}: {
  readonly names: readonly string[];
}) {
  if (names.length === 0) {
    return (
      <p className="text-caption text-faint">
        Este modelo não declara nenhum campo.
      </p>
    );
  }

  const groups = groupPlaceholders(names);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.key ?? "__loose"} className="flex flex-col gap-2">
          {group.label !== null && (
            <h3 className="font-mono text-label font-medium tracking-[0.1em] text-faint uppercase">
              {group.label}
            </h3>
          )}
          <ul className="flex flex-wrap gap-2">
            {group.fields.map((field) => (
              <li key={field.name}>
                <span
                  title={placeholderSyntax(field.name)}
                  className="inline-block rounded-md border border-docs/40 bg-docs/12 px-2 py-1 font-mono text-xs text-docs-soft"
                >
                  {placeholderSyntax(field.name)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
