/**
 * The owners' ledger and payouts over the API: /v1/payouts, /v1/people/{id}/ledger
 * and /v1/ledger/{id}.
 */

import type { CallContext, PayoutsGateway } from "../../application/ports.ts";
import { moneyForApi, parseMoney } from "../../domain/contract.ts";
import type {
  Balance,
  EntryKind,
  LedgerEntry,
  ManualEntryInput,
  Payout,
  PayoutDetail,
  PayoutInput,
  PayoutMethod,
  PayoutsPage,
  PersonLedger,
  PersonRef,
} from "../../domain/payout.ts";
import type { DocumentField } from "../../domain/document.ts";
import type { ChargeKind } from "../../domain/rent.ts";
import { toPropertyAddress, type PropertyAddressBody } from "./imobiliary-client.ts";
import type { Transport } from "./transport.ts";

interface EntryBody {
  id: string;
  person_id: string;
  kind: EntryKind;
  amount: string;
  signed: string;
  occurred_on: string;
  description: string;
  property_id: string | null;
  address: PropertyAddressBody | null;
  contract_id: string | null;
  registry?: string;
  rent_id: string | null;
  rent?: { sequence: number; due_on: string };
  charge_id: string | null;
  charge?: { kind: ChargeKind; description: string };
  payout_id: string | null;
}

interface PayoutBody {
  id: string;
  number: string;
  person: PersonRef;
  paid_on: string;
  total: string;
  method: PayoutMethod;
  note: string;
  created_at: string;
}

function toEntry(b: EntryBody): LedgerEntry {
  return {
    id: b.id,
    personId: b.person_id,
    kind: b.kind,
    amount: b.amount,
    signed: b.signed,
    occurredOn: b.occurred_on,
    description: b.description,
    propertyId: b.property_id,
    address: b.address === null ? null : toPropertyAddress(b.address),
    contractId: b.contract_id,
    registry: b.registry ?? "",
    rent: b.rent === undefined ? null : { sequence: b.rent.sequence, dueOn: b.rent.due_on },
    charge: b.charge ?? null,
    payoutId: b.payout_id,
  };
}

function toPayout(b: PayoutBody): Payout {
  return {
    id: b.id,
    number: b.number,
    person: b.person,
    paidOn: b.paid_on,
    total: b.total,
    method: b.method,
    note: b.note,
    createdAt: b.created_at,
  };
}

export class PayoutsClient implements PayoutsGateway {
  constructor(private readonly transport: Transport) {}

  async balances(ctx: CallContext): Promise<readonly Balance[]> {
    const b = await this.transport.json<{
      balances: { person: PersonRef; pending: string; lines: number; oldest_on: string }[];
    }>(ctx, "GET", "/v1/payouts/balances");
    return b.balances.map((x) => ({ person: x.person, pending: x.pending, lines: x.lines, oldestOn: x.oldest_on }));
  }

  async ledger(ctx: CallContext, personId: string): Promise<PersonLedger> {
    const b = await this.transport.json<{ person: PersonRef; balance: string; pending: EntryBody[]; today: string }>(
      ctx,
      "GET",
      `/v1/people/${encodeURIComponent(personId)}/ledger`,
    );
    return { person: b.person, balance: b.balance, pending: b.pending.map(toEntry), today: b.today };
  }

  async addEntry(ctx: CallContext, personId: string, input: ManualEntryInput): Promise<LedgerEntry> {
    const cents = parseMoney(input.amount);
    const response = await this.transport.send(ctx, "POST", `/v1/people/${encodeURIComponent(personId)}/ledger`, {
      body: JSON.stringify({
        kind: input.kind,
        amount: cents === null ? input.amount : moneyForApi(cents),
        description: input.description.trim(),
        occurred_on: input.occurredOn,
        ...(input.propertyId === "" ? {} : { property_id: input.propertyId }),
      }),
      contentType: "application/json",
    });
    return toEntry((await response.json()) as EntryBody);
  }

  async deleteEntry(ctx: CallContext, entryId: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", `/v1/ledger/${encodeURIComponent(entryId)}`);
  }

  async create(ctx: CallContext, input: PayoutInput): Promise<PayoutDetail> {
    const response = await this.transport.send(ctx, "POST", "/v1/payouts", {
      body: JSON.stringify({
        person_id: input.personId,
        paid_on: input.paidOn,
        entry_ids: input.entryIds,
        method: input.method,
        note: input.note.trim(),
      }),
      contentType: "application/json",
    });
    return this.detail((await response.json()) as PayoutBody & { entries: EntryBody[] });
  }

  async get(ctx: CallContext, id: string): Promise<PayoutDetail> {
    return this.detail(
      await this.transport.json<PayoutBody & { entries: EntryBody[] }>(ctx, "GET", `/v1/payouts/${encodeURIComponent(id)}`),
    );
  }

  private detail(b: PayoutBody & { entries: EntryBody[] }): PayoutDetail {
    return { ...toPayout(b), entries: b.entries.map(toEntry) };
  }

  async list(ctx: CallContext, query: { personId?: string; cursor?: string; limit?: number }): Promise<PayoutsPage> {
    const params = new URLSearchParams();
    if (query.personId) params.set("person_id", query.personId);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const b = await this.transport.json<{ payouts: PayoutBody[]; next_cursor?: string }>(ctx, "GET", `/v1/payouts${suffix}`);
    return { payouts: b.payouts.map(toPayout), nextCursor: b.next_cursor ?? null };
  }

  async undo(ctx: CallContext, id: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", `/v1/payouts/${encodeURIComponent(id)}`);
  }

  async documentFields(ctx: CallContext, id: string): Promise<DocumentField[]> {
    const body = await this.transport.json<{ fields: { name: string; value: string }[] }>(
      ctx,
      "GET",
      `/v1/payouts/${encodeURIComponent(id)}/document-fields`,
    );
    return body.fields.map((field) => ({ name: field.name, value: field.value }));
  }
}
