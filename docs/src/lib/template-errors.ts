/**
 * What the API says about a template it refused, in words an author can act on.
 *
 * The API reports problems with the file itself under the field `template`,
 * in English and aimed at developers. The upload screens show them on the file
 * field, so they must never be dropped: a refusal nobody sees makes the upload
 * button look broken, which is exactly how this was found.
 */

import { messageFor, type Failure } from "../application/result.ts";

const FORMAT = "{{.nome_do_campo}}";

/** The Portuguese message for a refused template, or undefined if none. */
export function templateProblem(failure: Failure | null): string | undefined {
  const raw = messageFor(failure, "template");
  if (raw === undefined) return undefined;

  const malformed = /malformed placeholder "([^"]+)"/.exec(raw)?.[1];
  if (malformed !== undefined) {
    return `O modelo tem um campo mal escrito: ${malformed}. Cada campo precisa de duas chaves de cada lado, assim: ${FORMAT}.`;
  }

  const badName = /placeholder "([^"]+)" must be lowercase snake_case/.exec(raw)?.[1];
  if (badName !== undefined) {
    return `O campo ${badName} precisa estar em minúsculas, sem acentos e com _ entre as palavras, como em ${FORMAT}.`;
  }

  const tooMany = /declares (\d+) placeholders, the maximum is (\d+)/.exec(raw);
  if (tooMany !== null) {
    return `O modelo tem ${tooMany[1]} campos; o máximo é ${tooMany[2]}.`;
  }

  return `Não conseguimos ler um dos campos do modelo. Confira se todos seguem o formato ${FORMAT}, em minúsculas e sem acentos.`;
}
