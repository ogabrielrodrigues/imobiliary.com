/**
 * The owners' ledger and payouts (PLANO-REPASSE.md).
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import type { Administrator } from "../domain/administrator.ts";
import { ValidationError } from "../domain/errors.ts";
import {
  translatePayoutProblem,
  validateManualEntry,
  type Balance,
  type LedgerEntry,
  type ManualEntryInput,
  type PayoutDetail,
  type PayoutInput,
  type PayoutsPage,
  type PersonLedger,
} from "../domain/payout.ts";
import { maskCNPJ, maskCPF } from "../domain/person.ts";
import { todayInSaoPaulo } from "../domain/rent.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ValidationError) throw new ValidationError(error.fields.map(translatePayoutProblem));
    throw error;
  }
}

/** Who is owed, and the latest payouts, for /repasses. */
export interface PayoutsOverview {
  readonly balances: readonly Balance[];
  readonly recent: PayoutsPage;
}

export const payoutsOverview = createServerFn({ method: "GET" })
  .validator((cursor: string | undefined) => cursor)
  .handler(async ({ data }): Promise<Result<PayoutsOverview>> =>
    attempt(() =>
      sessions().authorize(callContext(), async (ctx) => {
        const [balances, recent] = await Promise.all([
          api().payouts.balances(ctx),
          api().payouts.list(ctx, { limit: 20, ...(data ? { cursor: data } : {}) }),
        ]);
        return { balances, recent };
      }),
    ),
  );

/** A person's pending lines and their payouts, for /repasses/pessoa/$personId. */
export interface PersonPayouts {
  readonly ledger: PersonLedger;
  readonly payouts: PayoutsPage;
}

export const personPayouts = createServerFn({ method: "GET" })
  .validator((personId: string) => personId)
  .handler(async ({ data }): Promise<Result<PersonPayouts>> =>
    attempt(() =>
      sessions().authorize(callContext(), async (ctx) => {
        const [ledger, payouts] = await Promise.all([
          api().payouts.ledger(ctx, data),
          api().payouts.list(ctx, { personId: data, limit: 50 }),
        ]);
        return { ledger, payouts };
      }),
    ),
  );

/** A payout with what its receipts print: the administrator and the office. */
export interface PayoutStatement {
  readonly payout: PayoutDetail;
  readonly administrator: Administrator | null;
  /** The beneficiary's CPF or CNPJ, as the receipts print it; empty if none. */
  readonly beneficiaryDocument: string;
}

export const payoutStatement = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<PayoutStatement>> =>
    attempt(() =>
      sessions().authorize(callContext(), async (ctx) => {
        const [payout, administrator] = await Promise.all([
          api().payouts.get(ctx, data),
          api().organizations.administrator(ctx),
        ]);
        const person = await api().people.get(ctx, payout.person.id);
        const beneficiaryDocument = person.kind === "company" ? maskCNPJ(person.cnpj) : maskCPF(person.cpf);
        return { payout, administrator, beneficiaryDocument };
      }),
    ),
  );

export const addLedgerEntry = createServerFn({ method: "POST" })
  .validator((input: { readonly personId: string; readonly entry: ManualEntryInput }) => input)
  .handler(async ({ data }): Promise<Result<LedgerEntry>> =>
    attempt(async () => {
      assertSameOrigin();
      const problems = validateManualEntry(data.entry, todayInSaoPaulo());
      if (problems.length > 0) throw new ValidationError(problems);
      return translated(() =>
        sessions().authorize(callContext(), (ctx) => api().payouts.addEntry(ctx, data.personId, data.entry)),
      );
    }),
  );

export const deleteLedgerEntry = createServerFn({ method: "POST" })
  .validator((entryId: string) => entryId)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await translated(() => sessions().authorize(callContext(), (ctx) => api().payouts.deleteEntry(ctx, data)));
      return null;
    }),
  );

export const createPayout = createServerFn({ method: "POST" })
  .validator((input: PayoutInput) => input)
  .handler(async ({ data }): Promise<Result<PayoutDetail>> =>
    attempt(async () => {
      assertSameOrigin();
      return translated(() => sessions().authorize(callContext(), (ctx) => api().payouts.create(ctx, data)));
    }),
  );

export const undoPayout = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await translated(() => sessions().authorize(callContext(), (ctx) => api().payouts.undo(ctx, data)));
      return null;
    }),
  );
