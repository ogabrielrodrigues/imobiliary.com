import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Failure } from "../application/result.ts";
import { templateProblem } from "./template-errors.ts";

function refused(message: string): Failure {
  return { kind: "validation", fields: [{ field: "template", message }] };
}

describe("templateProblem", () => {
  it("is undefined when the API did not object to the template", () => {
    assert.equal(templateProblem(null), undefined);
    assert.equal(
      templateProblem({ kind: "validation", fields: [{ field: "name", message: "x" }] }),
      undefined,
    );
  });

  it("names the broken placeholder the API quoted", () => {
    const message = templateProblem(
      refused(
        'word/document.xml has a malformed placeholder "{{.locatario_identidade}"; write each one as {{.field_name}}',
      ),
    );
    assert.match(message ?? "", /\{\{\.locatario_identidade\}\./);
    assert.match(message ?? "", /duas chaves de cada lado/);
  });

  it("explains a name that is not snake_case", () => {
    const message = templateProblem(
      refused('word/document.xml: placeholder "NomeCliente" must be lowercase snake_case'),
    );
    assert.match(message ?? "", /NomeCliente precisa estar em minúsculas/);
  });

  it("still says something for a problem it does not recognise", () => {
    assert.match(templateProblem(refused("something new")) ?? "", /Confira se todos seguem/);
  });
});
