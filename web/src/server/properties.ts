/**
 * The office's properties: listing, reading, registering, editing and deleting.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { ValidationError } from "../domain/errors.ts";
import {
  translatePropertyProblem,
  validateProperty,
  type PropertiesPage,
  type Property,
  type PropertyInput,
} from "../domain/property.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface PropertiesQuery {
  readonly q?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly cursor?: string | undefined;
}

/** A page of the list. A read: no origin check, so a loader can call it. */
export const listProperties = createServerFn({ method: "GET" })
  .validator((query: PropertiesQuery) => query)
  .handler(async ({ data }): Promise<Result<PropertiesPage>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        api().properties.list(ctx, {
          ...(data.q ? { q: data.q.trim() } : {}),
          ...(data.ownerId ? { ownerId: data.ownerId } : {}),
          ...(data.cursor ? { cursor: data.cursor } : {}),
        }),
      ),
    ),
  );

export const getProperty = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<Property>> =>
    attempt(() => sessions().authorize(callContext(), (ctx) => api().properties.get(ctx, data))),
  );

/** Local rules first, in Portuguese; the API's answer after, translated. */
async function checked<T>(input: PropertyInput, run: () => Promise<T>): Promise<T> {
  const problems = validateProperty(input);
  if (problems.length > 0) throw new ValidationError(problems);
  try {
    return await run();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.fields.map(translatePropertyProblem));
    }
    throw error;
  }
}

export const createProperty = createServerFn({ method: "POST" })
  .validator((input: PropertyInput) => input)
  .handler(async ({ data }): Promise<Result<Property>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data, () => sessions().authorize(callContext(), (ctx) => api().properties.create(ctx, data)));
    }),
  );

export interface UpdatePropertyInput {
  readonly id: string;
  readonly version: number;
  readonly property: PropertyInput;
}

export const updateProperty = createServerFn({ method: "POST" })
  .validator((input: UpdatePropertyInput) => input)
  .handler(async ({ data }): Promise<Result<Property>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data.property, () =>
        sessions().authorize(callContext(), (ctx) =>
          api().properties.update(ctx, data.id, data.version, data.property),
        ),
      );
    }),
  );

export const deleteProperty = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().authorize(callContext(), (ctx) => api().properties.remove(ctx, data));
      return null;
    }),
  );
