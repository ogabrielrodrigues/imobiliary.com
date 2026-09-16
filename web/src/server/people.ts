/**
 * The office's people: listing, reading, registering, editing and deleting.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { ValidationError } from "../domain/errors.ts";
import {
  translatePersonProblem,
  validatePerson,
  type PeoplePage,
  type Person,
  type PersonInput,
  type PersonKind,
  type PersonSummary,
} from "../domain/person.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

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
