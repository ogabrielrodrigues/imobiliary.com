/**
 * The office's instalments across contracts, payments, charges and the dashboard.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { ValidationError } from "../domain/errors.ts";
import {
  todayInSaoPaulo,
  translateRentProblem,
  validateCharge,
  validatePayment,
  type ChargeInput,
  type Dashboard,
  type PaymentInput,
  type PaymentPreview,
  type RentDetail,
  type RentsPage,
} from "../domain/rent.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface RentsQuery {
  readonly q?: string | undefined;
  readonly status?: "overdue" | "pending" | "open" | "paid" | undefined;
  readonly dueFrom?: string | undefined;
  readonly dueTo?: string | undefined;
  readonly contractId?: string | undefined;
  readonly cursor?: string | undefined;
}

/** A page of the list. A read: no origin check, so a loader can call it. */
export const listRents = createServerFn({ method: "GET" })
  .validator((query: RentsQuery) => query)
  .handler(async ({ data }): Promise<Result<RentsPage>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        api().rents.list(ctx, {
          ...(data.q ? { q: data.q.trim() } : {}),
          ...(data.status ? { status: data.status } : {}),
          ...(data.dueFrom ? { dueFrom: data.dueFrom } : {}),
          ...(data.dueTo ? { dueTo: data.dueTo } : {}),
          ...(data.contractId ? { contractId: data.contractId } : {}),
          ...(data.cursor ? { cursor: data.cursor } : {}),
        }),
      ),
    ),
  );

export const getRent = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<RentDetail>> =>
    attempt(() => sessions().authorize(callContext(), (ctx) => api().rents.get(ctx, data))),
  );

export const getDashboard = createServerFn({ method: "GET" })
  .handler(async (): Promise<Result<Dashboard>> =>
    attempt(() => sessions().authorize(callContext(), (ctx) => api().rents.dashboard(ctx))),
  );

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ValidationError) throw new ValidationError(error.fields.map(translateRentProblem));
    throw error;
  }
}

/** Writes nothing, but the API charges it as a write: a POST with the origin check. */
export const previewPayment = createServerFn({ method: "POST" })
  .validator((input: { readonly id: string; readonly paidOn: string }) => input)
  .handler(async ({ data }): Promise<Result<PaymentPreview>> =>
    attempt(async () => {
      assertSameOrigin();
      return translated(() =>
        sessions().authorize(callContext(), (ctx) => api().rents.previewPayment(ctx, data.id, data.paidOn)),
      );
    }),
  );

export const payRent = createServerFn({ method: "POST" })
  .validator((input: { readonly id: string; readonly payment: PaymentInput }) => input)
  .handler(async ({ data }): Promise<Result<RentDetail>> =>
    attempt(async () => {
      assertSameOrigin();
      const problems = validatePayment(data.payment, todayInSaoPaulo());
      if (problems.length > 0) throw new ValidationError(problems);
      return translated(() => sessions().authorize(callContext(), (ctx) => api().rents.pay(ctx, data.id, data.payment)));
    }),
  );

export const reversePayment = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<RentDetail>> =>
    attempt(async () => {
      assertSameOrigin();
      return translated(() => sessions().authorize(callContext(), (ctx) => api().rents.reverse(ctx, data)));
    }),
  );

export const addCharge = createServerFn({ method: "POST" })
  .validator((input: { readonly id: string; readonly charge: ChargeInput }) => input)
  .handler(async ({ data }): Promise<Result<RentDetail>> =>
    attempt(async () => {
      assertSameOrigin();
      const problems = validateCharge(data.charge);
      if (problems.length > 0) throw new ValidationError(problems);
      return translated(() => sessions().authorize(callContext(), (ctx) => api().rents.addCharge(ctx, data.id, data.charge)));
    }),
  );

export const removeCharge = createServerFn({ method: "POST" })
  .validator((input: { readonly id: string; readonly chargeId: string }) => input)
  .handler(async ({ data }): Promise<Result<RentDetail>> =>
    attempt(async () => {
      assertSameOrigin();
      return translated(() =>
        sessions().authorize(callContext(), (ctx) => api().rents.removeCharge(ctx, data.id, data.chargeId)),
      );
    }),
  );
