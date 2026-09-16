/**
 * The office's contracts: listing, previewing, registering, editing,
 * terminating and deleting.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import {
  translateContractProblem,
  translateTerminationProblem,
  validateContract,
  validateTermination,
  type Contract,
  type ContractInput,
  type ContractPreview,
  type ContractsPage,
  type ContractStatus,
} from "../domain/contract.ts";
import { ValidationError } from "../domain/errors.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface ContractsQuery {
  readonly q?: string | undefined;
  readonly propertyId?: string | undefined;
  readonly personId?: string | undefined;
  readonly status?: ContractStatus | undefined;
  readonly cursor?: string | undefined;
}

/** A page of the list. A read: no origin check, so a loader can call it. */
export const listContracts = createServerFn({ method: "GET" })
  .validator((query: ContractsQuery) => query)
  .handler(async ({ data }): Promise<Result<ContractsPage>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        api().contracts.list(ctx, {
          ...(data.q ? { q: data.q.trim() } : {}),
          ...(data.propertyId ? { propertyId: data.propertyId } : {}),
          ...(data.personId ? { personId: data.personId } : {}),
          ...(data.status ? { status: data.status } : {}),
          ...(data.cursor ? { cursor: data.cursor } : {}),
        }),
      ),
    ),
  );

export const getContract = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<Contract>> =>
    attempt(() => sessions().authorize(callContext(), (ctx) => api().contracts.get(ctx, data))),
  );

/** Local rules first, in Portuguese; the API's answer after, translated. */
async function checked<T>(input: ContractInput, run: () => Promise<T>): Promise<T> {
  const problems = validateContract(input);
  if (problems.length > 0) throw new ValidationError(problems);
  try {
    return await run();
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.fields.map(translateContractProblem));
    }
    throw error;
  }
}

/**
 * The schedule and notices for the review step. It writes nothing, but the
 * API counts it against the write budget, so it is a POST with the origin check.
 */
export const previewContract = createServerFn({ method: "POST" })
  .validator((input: ContractInput) => input)
  .handler(async ({ data }): Promise<Result<ContractPreview>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data, () => sessions().authorize(callContext(), (ctx) => api().contracts.preview(ctx, data)));
    }),
  );

export const createContract = createServerFn({ method: "POST" })
  .validator((input: ContractInput) => input)
  .handler(async ({ data }): Promise<Result<Contract>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data, () => sessions().authorize(callContext(), (ctx) => api().contracts.create(ctx, data)));
    }),
  );

export interface UpdateContractInput {
  readonly id: string;
  readonly version: number;
  readonly contract: ContractInput;
}

export const updateContract = createServerFn({ method: "POST" })
  .validator((input: UpdateContractInput) => input)
  .handler(async ({ data }): Promise<Result<Contract>> =>
    attempt(async () => {
      assertSameOrigin();
      return checked(data.contract, () =>
        sessions().authorize(callContext(), (ctx) =>
          api().contracts.update(ctx, data.id, data.version, data.contract),
        ),
      );
    }),
  );

export interface TerminateContractInput {
  readonly id: string;
  readonly version: number;
  readonly startsOn: string;
  readonly expiresOn: string;
  readonly terminatedOn: string;
}

export const terminateContract = createServerFn({ method: "POST" })
  .validator((input: TerminateContractInput) => input)
  .handler(async ({ data }): Promise<Result<Contract>> =>
    attempt(async () => {
      assertSameOrigin();
      const problem = validateTermination(data, data.terminatedOn);
      if (problem !== null) throw new ValidationError([{ field: "terminated_on", message: problem }]);
      try {
        return await sessions().authorize(callContext(), (ctx) =>
          api().contracts.terminate(ctx, data.id, data.version, data.terminatedOn),
        );
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(
            error.fields.map((f) => ({ field: "terminated_on", message: translateTerminationProblem(f.message) })),
          );
        }
        throw error;
      }
    }),
  );

export const deleteContract = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().authorize(callContext(), (ctx) => api().contracts.remove(ctx, data));
      return null;
    }),
  );
