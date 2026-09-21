/**
 * The office's people: listing, reading, registering, editing and deleting.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { PermissionError, ValidationError } from "../domain/errors.ts";
import {
  translatePersonProblem,
  validatePerson,
  type PeoplePage,
  type Person,
  type PersonInput,
  type PersonKind,
  type PersonSummary,
} from "../domain/person.ts";
import {
  translateAnonymizationProblem,
  type AnonymizationCandidate,
  type AnonymizationResult,
} from "../domain/anonymization.ts";
import { subjectReference } from "../domain/document.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { api, assertSameOrigin, callContext, documents, sessions } from "./runtime.ts";

export interface PeopleQuery {
  readonly q?: string | undefined;
  readonly kind?: PersonKind | undefined;
  readonly cursor?: string | undefined;
}

/** A page of the list. A read: no origin check, so a loader can call it. */
export const listPeople = createServerFn({ method: "GET" })
  .validator((query: PeopleQuery) => query)
  .handler(async ({ data }): Promise<Result<PeoplePage>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        api().people.list(ctx, {
          ...(data.q ? { q: data.q.trim() } : {}),
          ...(data.kind ? { kind: data.kind } : {}),
          ...(data.cursor ? { cursor: data.cursor } : {}),
        }),
      ),
    ),
  );

export interface PersonView {
  readonly person: Person;
  /**
   * The people this one links to, so the screen can name a spouse and each
   * representative instead of showing identifiers.
   */
  readonly linked: readonly PersonSummary[];
}

/** One person, with the names of the people linked to them. */
export const getPerson = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<PersonView>> =>
    attempt(async () => {
      const manager = sessions();
      const person = await manager.authorize(callContext(), (ctx) => api().people.get(ctx, data));
      const ids = [...(person.spouseId ? [person.spouseId] : []), ...person.representativeIds];
      const linked = await Promise.all(
        ids.map(async (id) => {
          const other = await manager.authorize(callContext(), (ctx) => api().people.get(ctx, id));
          return { id: other.id, kind: other.kind, name: other.name, tradeName: other.tradeName };
        }),
      );
      return { person, linked };
    }),
  );

/**
 * Local rules first, in Portuguese; the API's answer after, translated, since
 * it speaks English and only it knows about duplicates and links.
 */
async function checked<T>(input: PersonInput, run: () => Promise<T>): Promise<T> {
  const problems = validatePerson(input);
  if (problems.length > 0) throw new ValidationError(problems);
  try {
    return await run();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.fields.map(translatePersonProblem));
    }
    throw error;
  }
}

export const createPerson = createServerFn({ method: "POST" })
  .validator((input: PersonInput) => input)
  .handler(async ({ data }): Promise<Result<Person>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data, () =>
        sessions().authorize(callContext(), (ctx) => api().people.create(ctx, data)),
      );
    }),
  );

export interface UpdatePersonInput {
  readonly id: string;
  readonly version: number;
  readonly person: PersonInput;
}

export const updatePerson = createServerFn({ method: "POST" })
  .validator((input: UpdatePersonInput) => input)
  .handler(async ({ data }): Promise<Result<Person>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data.person, () =>
        sessions().authorize(callContext(), (ctx) =>
          api().people.update(ctx, data.id, data.version, data.person),
        ),
      );
    }),
  );

export const deletePerson = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().authorize(callContext(), (ctx) => api().people.remove(ctx, data));
      return null;
    }),
  );

/** Who is past the legal retention. A read: a loader calls it. */
export const anonymizationCandidates = createServerFn({ method: "GET" })
  .handler(async (): Promise<Result<AnonymizationCandidate[]>> =>
    attempt(() => sessions().authorize(callContext(), (ctx) => api().people.anonymizationCandidates(ctx))),
  );

/**
 * Anonymises a person past the retention, and first erases from the document
 * service what was generated about them: the documents of each of their
 * payouts, and of each contract whose other parties are anonymised too or
 * are being. A contract that names someone still registered keeps its
 * documents, and the answer counts them. The documents go first: once the
 * person is anonymised they are no longer a candidate, and nothing would say
 * which documents were theirs.
 */
export const anonymizePerson = createServerFn({ method: "POST" })
  .validator((personId: string) => personId)
  .handler(async ({ data }): Promise<Result<AnonymizationResult>> =>
    attempt(async () => {
      assertSameOrigin();
      // The API refuses a member, but only after the documents would be gone:
      // ask the session first.
      const session = await createCookieSessionStore().read();
      if (session?.role !== "admin") throw new PermissionError();
      const candidates = await sessions().authorize(callContext(), (ctx) => api().people.anonymizationCandidates(ctx));
      const candidate = candidates.find((c) => c.person.id === data);
      if (candidate === undefined) {
        throw new ValidationError([translateAnonymizationProblem({ field: "person", message: "is not due for anonymization" })]);
      }
      const erase = [
        ...candidate.contracts.filter((c) => c.documentsCanGo).map((c) => subjectReference({ kind: "contract", id: c.id })),
        ...candidate.payouts.map((p) => subjectReference({ kind: "payout", id: p.id })),
      ];
      const keep = candidate.contracts.filter((c) => !c.documentsCanGo).map((c) => subjectReference({ kind: "contract", id: c.id }));
      const { deleted, kept } = await sessions().authorizeDocuments(callContext(), async (ctx) => {
        let deleted = 0;
        for (const reference of erase) {
          for (const document of await documents().listByReference(ctx, reference)) {
            await documents().remove(ctx, document.id);
            deleted++;
          }
        }
        let kept = 0;
        for (const reference of keep) kept += (await documents().listByReference(ctx, reference)).length;
        return { deleted, kept };
      });
      try {
        await sessions().authorize(callContext(), (ctx) => api().people.anonymize(ctx, data));
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(error.fields.map(translateAnonymizationProblem));
        throw error;
      }
      return { documentsDeleted: deleted, documentsKept: kept };
    }),
  );
