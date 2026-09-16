/**
 * The API as this platform's ports describe it.
 *
 * One transport underneath, four gateways over it, because the application
 * layer asks for what it needs rather than for "the API": a screen that lists
 * members does not need to see how a session is refreshed.
 *
 * Every response is mapped field by field rather than cast. The API's shapes
 * are stable, but a cast would make a change there a runtime surprise three
 * screens away, and the mapping is where an instant becomes a Date.
 */

import type {
  CallContext,
  ContractsGateway,
  CurrentAccount,
  IdentityGateway,
  Invitation,
  InvitationStatus,
  Member,
  OrganizationGateway,
  PasswordGateway,
  PeopleGateway,
  PrivacyGateway,
  PropertiesGateway,
  SecondFactorGateway,
} from "../../application/ports.ts";
import type {
  Membership,
  Organization,
  PendingInvitation,
  RegistrationInput,
  Role,
  Session,
  SignInInput,
  SignInOutcome,
  User,
} from "../../domain/user.ts";
import type {
  Address,
  AddressKind,
  Gender,
  MaritalStatus,
  PeoplePage,
  Person,
  PersonInput,
  PersonKind,
  PropertyRegime,
} from "../../domain/person.ts";
import {
  ownersToSave,
  parseShare,
  shareForApi,
  shareFromApi,
  type PropertiesPage,
  type Property,
  type PropertyAddress,
  type PropertyInput,
} from "../../domain/property.ts";
import {
  moneyForApi,
  parseMoney,
  parsePercent,
  partiesOf,
  percentForApi,
  type AdjustmentIndex,
  type Contract,
  type ContractInput,
  type ContractPreview,
  type ContractsPage,
  type ContractStatus,
  type ContractTerms,
  type GuaranteeKind,
  type NoticeCode,
  type PartyRole,
  type RentStatus,
} from "../../domain/contract.ts";
import { Transport } from "./transport.ts";

// --- the shapes the API answers with ----------------------------------------

interface UserBody {
  id: string;
  email: string;
  name: string;
  created_at: string;
  totp_enabled: boolean;
}

interface OrganizationBody {
  id: string;
  name: string;
}

interface SessionBody {
  user: UserBody;
  organization: OrganizationBody;
  role: Role;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  mfa_enrollment_required: boolean;
}

interface MembershipBody {
  organization: OrganizationBody;
  role: Role;
}

interface SignInBody {
  mfa_required: boolean;
  session?: SessionBody;
  challenge?: string;
  organizations: MembershipBody[];
}

interface MeBody {
  user: UserBody;
  organization: OrganizationBody;
  role: Role;
  organizations: MembershipBody[];
  mfa_enrollment_required: boolean;
  recovery_codes_left: number;
}

interface InvitationBody {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
}

// --- the mapping ------------------------------------------------------------

function toUser(body: UserBody): User {
  return {
    id: body.id,
    email: body.email,
    name: body.name,
    createdAt: new Date(body.created_at),
    totpEnabled: body.totp_enabled,
  };
}

function toOrganization(body: OrganizationBody): Organization {
  return { id: body.id, name: body.name };
}

function toMembership(body: MembershipBody): Membership {
  return { organization: toOrganization(body.organization), role: body.role };
}

function toSession(body: SessionBody): Session {
  return {
    user: toUser(body.user),
    organization: toOrganization(body.organization),
    role: body.role,
    accessToken: body.access_token,
    accessExpiresAt: new Date(body.access_expires_at),
    refreshToken: body.refresh_token,
    refreshExpiresAt: new Date(body.refresh_expires_at),
    mfaEnrollmentRequired: body.mfa_enrollment_required,
  };
}

function toInvitation(body: InvitationBody): Invitation {
  return {
    id: body.id,
    email: body.email,
    role: body.role,
    status: body.status,
    createdAt: new Date(body.created_at),
    expiresAt: new Date(body.expires_at),
  };
}

// --- the gateways -----------------------------------------------------------

export function createGateways(transport: Transport): {
  identity: IdentityGateway;
  passwords: PasswordGateway;
  secondFactor: SecondFactorGateway;
  organizations: OrganizationGateway;
  privacy: PrivacyGateway;
  people: PeopleGateway;
  properties: PropertiesGateway;
  contracts: ContractsGateway;
} {
  return {
    identity: new IdentityClient(transport),
    passwords: new PasswordClient(transport),
    secondFactor: new SecondFactorClient(transport),
    organizations: new OrganizationClient(transport),
    privacy: new PrivacyClient(transport),
    people: new PeopleClient(transport),
    properties: new PropertiesClient(transport),
    contracts: new ContractsClient(transport),
  };
}

class IdentityClient implements IdentityGateway {
  constructor(private readonly transport: Transport) {}

  async register(ctx: CallContext, input: RegistrationInput): Promise<void> {
    await this.transport.send(ctx, "POST", "/v1/accounts", {
      body: JSON.stringify({
        email: input.email,
        name: input.name,
        password: input.password,
        organization_name: input.organizationName,
        terms_version: input.termsVersion,
      }),
      contentType: "application/json",
    });
  }

  async signIn(ctx: CallContext, input: SignInInput): Promise<SignInOutcome> {
    const body = await this.transport.json<SignInBody>(ctx, "POST", "/v1/sessions", {
      email: input.email,
      password: input.password,
      ...(input.organizationId === undefined ? {} : { organization_id: input.organizationId }),
    });

    if (body.mfa_required || body.session === undefined) {
      return {
        kind: "second_factor",
        challenge: body.challenge ?? "",
        organizations: body.organizations.map(toMembership),
      };
    }
    return { kind: "session", session: toSession(body.session) };
  }

  async completeSecondFactor(
    ctx: CallContext,
    input: { challenge: string; code: string; organizationId?: string | undefined },
  ): Promise<Session> {
    const body = await this.transport.json<SessionBody>(ctx, "POST", "/v1/sessions/mfa", {
      challenge: input.challenge,
      code: input.code,
      ...(input.organizationId === undefined ? {} : { organization_id: input.organizationId }),
    });
    return toSession(body);
  }

  async refresh(ctx: CallContext, refreshToken: string): Promise<Session> {
    const body = await this.transport.json<SessionBody>(ctx, "POST", "/v1/sessions/refresh", {
      refresh_token: refreshToken,
    });
    return toSession(body);
  }

  async signOut(ctx: CallContext, refreshToken: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", "/v1/sessions", {
      body: JSON.stringify({ refresh_token: refreshToken }),
      contentType: "application/json",
    });
  }

  async switchOrganization(
    ctx: CallContext,
    input: { refreshToken: string; organizationId: string },
  ): Promise<Session> {
    const body = await this.transport.json<SessionBody>(ctx, "POST", "/v1/sessions/switch", {
      refresh_token: input.refreshToken,
      organization_id: input.organizationId,
    });
    return toSession(body);
  }

  async me(ctx: CallContext): Promise<CurrentAccount> {
    const body = await this.transport.json<MeBody>(ctx, "GET", "/v1/me");
    return {
      user: toUser(body.user),
      organization: toOrganization(body.organization),
      role: body.role,
      organizations: body.organizations.map(toMembership),
      mfaEnrollmentRequired: body.mfa_enrollment_required,
      recoveryCodesLeft: body.recovery_codes_left,
    };
  }
}

interface AddressBody {
  kind: AddressKind;
  is_primary: boolean;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  zip_code: string;
  observation: string;
}

interface PersonBody {
  id: string;
  kind: PersonKind;
  name: string;
  email: string;
  phone: string;
  cpf: string;
  nationality: string;
  marital_status: MaritalStatus | "";
  property_regime: PropertyRegime | "";
  spouse_id: string | null;
  occupation: string;
  birth_date: string | null;
  gender: Gender | "";
  cnpj: string;
  trade_name: string;
  representative_ids: string[];
  addresses: AddressBody[];
  version: number;
  created_at: string;
  updated_at: string;
}

interface PeoplePageBody {
  people: { id: string; kind: PersonKind; name: string; trade_name: string }[];
  next_cursor?: string;
}

function toAddress(a: AddressBody): Address {
  return {
    kind: a.kind,
    isPrimary: a.is_primary,
    street: a.street,
    number: a.number,
    complement: a.complement,
    district: a.district,
    city: a.city,
    state: a.state,
    zipCode: a.zip_code,
    observation: a.observation,
  };
}

function toPerson(b: PersonBody): Person {
  return {
    id: b.id,
    kind: b.kind,
    name: b.name,
    email: b.email,
    phone: b.phone,
    cpf: b.cpf,
    nationality: b.nationality,
    maritalStatus: b.marital_status,
    propertyRegime: b.property_regime,
    spouseId: b.spouse_id ?? "",
    occupation: b.occupation,
    birthDate: b.birth_date ?? "",
    gender: b.gender,
    cnpj: b.cnpj,
    tradeName: b.trade_name,
    representativeIds: b.representative_ids,
    addresses: b.addresses.map(toAddress),
    version: b.version,
    createdAt: new Date(b.created_at),
    updatedAt: new Date(b.updated_at),
  };
}

/** The request body. Fields of the other kind go empty, as the API requires. */
function personPayload(p: PersonInput): string {
  const individual = p.kind === "individual";
  return JSON.stringify({
    kind: p.kind,
    name: p.name,
    email: p.email,
    phone: p.phone,
    cpf: individual ? p.cpf : "",
    nationality: individual ? p.nationality : "",
    marital_status: individual ? p.maritalStatus : "",
    property_regime: individual ? p.propertyRegime : "",
    spouse_id: individual && p.spouseId !== "" ? p.spouseId : null,
    occupation: individual ? p.occupation : "",
    birth_date: individual && p.birthDate !== "" ? p.birthDate : null,
    gender: individual ? p.gender : "",
    cnpj: individual ? "" : p.cnpj,
    trade_name: individual ? "" : p.tradeName,
    representative_ids: individual ? [] : p.representativeIds,
    addresses: p.addresses.map((a) => ({
      kind: a.kind,
      is_primary: a.isPrimary,
      street: a.street,
      number: a.number,
      complement: a.complement,
      district: a.district,
      city: a.city,
      state: a.state,
      zip_code: a.zipCode,
      observation: a.observation,
    })),
  });
}

class PeopleClient implements PeopleGateway {
  constructor(private readonly transport: Transport) {}

  async list(
    ctx: CallContext,
    query: { q?: string; kind?: PersonKind; cursor?: string; limit?: number },
  ): Promise<PeoplePage> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.kind) params.set("kind", query.kind);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.transport.json<PeoplePageBody>(ctx, "GET", `/v1/people${suffix}`);
    return {
      people: body.people.map((p) => ({ id: p.id, kind: p.kind, name: p.name, tradeName: p.trade_name })),
      nextCursor: body.next_cursor ?? null,
    };
  }

  async get(ctx: CallContext, id: string): Promise<Person> {
    return toPerson(await this.transport.json<PersonBody>(ctx, "GET", `/v1/people/${encodeURIComponent(id)}`));
  }

  async create(ctx: CallContext, input: PersonInput): Promise<Person> {
    const response = await this.transport.send(ctx, "POST", "/v1/people", {
      body: personPayload(input),
      contentType: "application/json",
    });
    return toPerson((await response.json()) as PersonBody);
  }

  async update(ctx: CallContext, id: string, version: number, input: PersonInput): Promise<Person> {
    const response = await this.transport.send(ctx, "PUT", `/v1/people/${encodeURIComponent(id)}`, {
      body: personPayload(input),
      contentType: "application/json",
      ifMatch: `"${version}"`,
    });
    return toPerson((await response.json()) as PersonBody);
  }

  async remove(ctx: CallContext, id: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", `/v1/people/${encodeURIComponent(id)}`);
  }
}

interface PropertyAddressBody {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  zip_code: string;
  observation: string;
}

interface PropertyBody {
  id: string;
  address: PropertyAddressBody;
  registry: string;
  registry_office: string;
  municipal_registration: string;
  water_code: string;
  energy_code: string;
  owners: { person_id: string; share: string; name: string; kind: PersonKind }[];
  version: number;
}

interface PropertiesPageBody {
  properties: { id: string; address: PropertyAddressBody; registry: string; owner_names: string[] }[];
  next_cursor?: string;
}

function toPropertyAddress(a: PropertyAddressBody): PropertyAddress {
  return {
    street: a.street,
    number: a.number,
    complement: a.complement,
    district: a.district,
    city: a.city,
    state: a.state,
    zipCode: a.zip_code,
    observation: a.observation,
  };
}

function toProperty(b: PropertyBody): Property {
  return {
    id: b.id,
    address: toPropertyAddress(b.address),
    registry: b.registry,
    registryOffice: b.registry_office,
    municipalRegistration: b.municipal_registration,
    waterCode: b.water_code,
    energyCode: b.energy_code,
    owners: b.owners.map((o) => ({ personId: o.person_id, share: shareFromApi(o.share), name: o.name, kind: o.kind })),
    version: b.version,
  };
}

/** Shares leave as the API reads a rate, with a dot: "33,3333" becomes "33.3333". */
function propertyPayload(p: PropertyInput): string {
  const a = p.address;
  return JSON.stringify({
    address: {
      street: a.street,
      number: a.number,
      complement: a.complement,
      district: a.district,
      city: a.city,
      state: a.state,
      zip_code: a.zipCode,
      observation: a.observation,
    },
    registry: p.registry,
    registry_office: p.registryOffice,
    municipal_registration: p.municipalRegistration,
    water_code: p.waterCode,
    energy_code: p.energyCode,
    owners: ownersToSave(p.owners).map((o) => {
      const share = parseShare(o.share);
      return { person_id: o.personId, share: share === null ? o.share : shareForApi(share) };
    }),
  });
}

class PropertiesClient implements PropertiesGateway {
  constructor(private readonly transport: Transport) {}

  async list(
    ctx: CallContext,
    query: { q?: string; ownerId?: string; cursor?: string; limit?: number },
  ): Promise<PropertiesPage> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.ownerId) params.set("owner_id", query.ownerId);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.transport.json<PropertiesPageBody>(ctx, "GET", `/v1/properties${suffix}`);
    return {
      properties: body.properties.map((p) => ({
        id: p.id,
        address: toPropertyAddress(p.address),
        registry: p.registry,
        ownerNames: p.owner_names,
      })),
      nextCursor: body.next_cursor ?? null,
    };
  }

  async get(ctx: CallContext, id: string): Promise<Property> {
    return toProperty(await this.transport.json<PropertyBody>(ctx, "GET", `/v1/properties/${encodeURIComponent(id)}`));
  }

  async create(ctx: CallContext, input: PropertyInput): Promise<Property> {
    const response = await this.transport.send(ctx, "POST", "/v1/properties", {
      body: propertyPayload(input),
      contentType: "application/json",
    });
    return toProperty((await response.json()) as PropertyBody);
  }

  async update(ctx: CallContext, id: string, version: number, input: PropertyInput): Promise<Property> {
    const response = await this.transport.send(ctx, "PUT", `/v1/properties/${encodeURIComponent(id)}`, {
      body: propertyPayload(input),
      contentType: "application/json",
      ifMatch: `"${version}"`,
    });
    return toProperty((await response.json()) as PropertyBody);
  }

  async remove(ctx: CallContext, id: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", `/v1/properties/${encodeURIComponent(id)}`);
  }
}

interface ContractTermsBody {
  property_id: string;
  registry: string;
  guarantee_kind: GuaranteeKind;
  deposit_amount: string;
  rent: string;
  current_rent: string;
  admin_fee: string;
  late_penalty_rate: string;
  late_interest_rate: string;
  due_day: number;
  adjustment_index: AdjustmentIndex;
  signed_on: string;
  starts_on: string;
  expires_on: string;
  terminated_on: string | null;
  status: ContractStatus;
}

interface ContractBody extends ContractTermsBody {
  id: string;
  property: { id: string; address: PropertyAddressBody };
  parties: { person_id: string; role: PartyRole; name: string; kind: PersonKind }[];
  acknowledgments: { code: NoticeCode; acknowledged_at: string }[];
  rents: {
    id: string;
    sequence: number;
    due_on: string;
    amount: string;
    late_fee: string;
    amount_paid: string | null;
    paid_on: string | null;
    status: RentStatus;
  }[];
  version: number;
}

interface ContractsPageBody {
  contracts: (ContractTermsBody & { id: string; address: PropertyAddressBody; tenant_names: string[] })[];
  next_cursor?: string;
}

interface ContractPreviewBody {
  schedule: { sequence: number; due_on: string; amount: string }[];
  notices: NoticeCode[];
  total: string;
}

function toContractTerms(b: ContractTermsBody): ContractTerms {
  return {
    propertyId: b.property_id,
    registry: b.registry,
    guaranteeKind: b.guarantee_kind,
    depositAmount: b.deposit_amount,
    rent: b.rent,
    currentRent: b.current_rent,
    adminFee: b.admin_fee,
    latePenaltyRate: b.late_penalty_rate,
    lateInterestRate: b.late_interest_rate,
    dueDay: b.due_day,
    adjustmentIndex: b.adjustment_index,
    signedOn: b.signed_on,
    startsOn: b.starts_on,
    expiresOn: b.expires_on,
    terminatedOn: b.terminated_on,
    status: b.status,
  };
}

function toContract(b: ContractBody): Contract {
  return {
    ...toContractTerms(b),
    id: b.id,
    address: toPropertyAddress(b.property.address),
    parties: b.parties.map((p) => ({ personId: p.person_id, role: p.role, name: p.name, kind: p.kind })),
    acknowledgments: b.acknowledgments.map((a) => ({ code: a.code, acknowledgedAt: a.acknowledged_at })),
    rents: b.rents.map((r) => ({
      id: r.id,
      sequence: r.sequence,
      dueOn: r.due_on,
      amount: r.amount,
      lateFee: r.late_fee,
      amountPaid: r.amount_paid,
      paidOn: r.paid_on,
      status: r.status,
    })),
    version: b.version,
  };
}

/**
 * Amounts and percentages leave as the API reads them, with a dot. A value
 * that does not parse is sent as typed, so the API's refusal lands on its field.
 */
function contractPayload(c: ContractInput): string {
  const money = (value: string) => {
    const cents = parseMoney(value);
    return cents === null ? value : moneyForApi(cents);
  };
  const percent = (value: string) => {
    const millionths = parsePercent(value);
    return millionths === null ? value : percentForApi(millionths);
  };
  return JSON.stringify({
    property_id: c.propertyId,
    registry: c.registry.trim(),
    guarantee_kind: c.guaranteeKind,
    ...(c.guaranteeKind === "deposit" ? { deposit_amount: money(c.depositAmount) } : {}),
    rent: money(c.rent),
    admin_fee: percent(c.adminFee),
    late_penalty_rate: percent(c.latePenaltyRate),
    late_interest_rate: percent(c.lateInterestRate),
    due_day: c.dueDay.trim() === "" ? 0 : Number(c.dueDay),
    adjustment_index: c.adjustmentIndex,
    signed_on: c.signedOn,
    starts_on: c.startsOn,
    expires_on: c.expiresOn,
    parties: partiesOf(c).map((p) => ({ person_id: p.personId, role: p.role })),
    acknowledgments: c.acknowledgments,
  });
}

class ContractsClient implements ContractsGateway {
  constructor(private readonly transport: Transport) {}

  async list(
    ctx: CallContext,
    query: { q?: string; propertyId?: string; personId?: string; status?: ContractStatus; cursor?: string; limit?: number },
  ): Promise<ContractsPage> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.propertyId) params.set("property_id", query.propertyId);
    if (query.personId) params.set("person_id", query.personId);
    if (query.status) params.set("status", query.status);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const body = await this.transport.json<ContractsPageBody>(ctx, "GET", `/v1/contracts${suffix}`);
    return {
      contracts: body.contracts.map((c) => ({
        ...toContractTerms(c),
        id: c.id,
        address: toPropertyAddress(c.address),
        tenantNames: c.tenant_names,
      })),
      nextCursor: body.next_cursor ?? null,
    };
  }

  async preview(ctx: CallContext, input: ContractInput): Promise<ContractPreview> {
    const response = await this.transport.send(ctx, "POST", "/v1/contracts/preview", {
      body: contractPayload(input),
      contentType: "application/json",
    });
    const body = (await response.json()) as ContractPreviewBody;
    return {
      schedule: body.schedule.map((i) => ({ sequence: i.sequence, dueOn: i.due_on, amount: i.amount })),
      notices: body.notices,
      total: body.total,
    };
  }

  async get(ctx: CallContext, id: string): Promise<Contract> {
    return toContract(await this.transport.json<ContractBody>(ctx, "GET", `/v1/contracts/${encodeURIComponent(id)}`));
  }

  async create(ctx: CallContext, input: ContractInput): Promise<Contract> {
    const response = await this.transport.send(ctx, "POST", "/v1/contracts", {
      body: contractPayload(input),
      contentType: "application/json",
    });
    return toContract((await response.json()) as ContractBody);
  }

  async update(ctx: CallContext, id: string, version: number, input: ContractInput): Promise<Contract> {
    const response = await this.transport.send(ctx, "PUT", `/v1/contracts/${encodeURIComponent(id)}`, {
      body: contractPayload(input),
      contentType: "application/json",
      ifMatch: `"${version}"`,
    });
    return toContract((await response.json()) as ContractBody);
  }

  async terminate(ctx: CallContext, id: string, version: number, on: string): Promise<Contract> {
    const response = await this.transport.send(ctx, "POST", `/v1/contracts/${encodeURIComponent(id)}/termination`, {
      body: JSON.stringify({ terminated_on: on }),
      contentType: "application/json",
      ifMatch: `"${version}"`,
    });
    return toContract((await response.json()) as ContractBody);
  }

  async remove(ctx: CallContext, id: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", `/v1/contracts/${encodeURIComponent(id)}`);
  }
}

class PrivacyClient implements PrivacyGateway {
  constructor(private readonly transport: Transport) {}

  async exportData(ctx: CallContext): Promise<string> {
    const response = await this.transport.send(ctx, "GET", "/v1/me/export");
    return response.text();
  }

  async deleteAccount(ctx: CallContext, password: string): Promise<void> {
    // A POST with a body rather than DELETE on /v1/me: the API chose it so a
    // proxy cannot drop the password on the way.
    await this.transport.send(ctx, "POST", "/v1/me/deletion", {
      body: JSON.stringify({ password }),
      contentType: "application/json",
    });
  }
}

class PasswordClient implements PasswordGateway {
  constructor(private readonly transport: Transport) {}

  async change(
    ctx: CallContext,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    await this.transport.send(ctx, "POST", "/v1/me/password", {
      body: JSON.stringify({
        current_password: input.currentPassword,
        new_password: input.newPassword,
      }),
      contentType: "application/json",
    });
  }

  async forget(ctx: CallContext, email: string): Promise<void> {
    await this.transport.send(ctx, "POST", "/v1/password/forgot", {
      body: JSON.stringify({ email }),
      contentType: "application/json",
    });
  }

  async reset(ctx: CallContext, input: { token: string; password: string }): Promise<void> {
    await this.transport.send(ctx, "POST", "/v1/password/reset", {
      body: JSON.stringify({ token: input.token, password: input.password }),
      contentType: "application/json",
    });
  }
}

class SecondFactorClient implements SecondFactorGateway {
  constructor(private readonly transport: Transport) {}

  start(ctx: CallContext): Promise<{ secret: string; uri: string }> {
    return this.transport.json<{ secret: string; uri: string }>(ctx, "POST", "/v1/me/totp", {});
  }

  async confirm(ctx: CallContext, code: string): Promise<readonly string[]> {
    const body = await this.transport.json<{ recovery_codes: string[] }>(
      ctx,
      "POST",
      "/v1/me/totp/confirm",
      { code },
    );
    return body.recovery_codes;
  }

  async disable(ctx: CallContext, password: string): Promise<void> {
    await this.transport.send(ctx, "DELETE", "/v1/me/totp", {
      body: JSON.stringify({ password }),
      contentType: "application/json",
    });
  }

  async regenerateRecoveryCodes(ctx: CallContext, password: string): Promise<readonly string[]> {
    const body = await this.transport.json<{ recovery_codes: string[] }>(
      ctx,
      "POST",
      "/v1/me/totp/recovery-codes",
      { password },
    );
    return body.recovery_codes;
  }
}

class OrganizationClient implements OrganizationGateway {
  constructor(private readonly transport: Transport) {}

  async rename(ctx: CallContext, name: string): Promise<void> {
    await this.transport.send(ctx, "PATCH", "/v1/organization", {
      body: JSON.stringify({ name }),
      contentType: "application/json",
    });
  }

  async members(ctx: CallContext): Promise<readonly Member[]> {
    const body = await this.transport.json<{
      members: { user: UserBody; role: Role; joined_at: string }[];
    }>(ctx, "GET", "/v1/organization/members");
    return body.members.map((member) => ({
      user: toUser(member.user),
      role: member.role,
      joinedAt: new Date(member.joined_at),
    }));
  }

  async changeRole(ctx: CallContext, userId: string, role: Role): Promise<void> {
    await this.transport.send(ctx, "PATCH", `/v1/organization/members/${encodeURIComponent(userId)}`, {
      body: JSON.stringify({ role }),
      contentType: "application/json",
    });
  }

  async removeMember(ctx: CallContext, userId: string): Promise<void> {
    await this.transport.send(
      ctx,
      "DELETE",
      `/v1/organization/members/${encodeURIComponent(userId)}`,
    );
  }

  async invitations(ctx: CallContext): Promise<readonly Invitation[]> {
    const body = await this.transport.json<{ invitations: InvitationBody[] }>(
      ctx,
      "GET",
      "/v1/organization/invitations",
    );
    return body.invitations.map(toInvitation);
  }

  async invite(ctx: CallContext, input: { email: string; role: Role }): Promise<Invitation> {
    const body = await this.transport.json<InvitationBody>(
      ctx,
      "POST",
      "/v1/organization/invitations",
      { email: input.email, role: input.role },
    );
    return toInvitation(body);
  }

  async revokeInvitation(ctx: CallContext, id: string): Promise<void> {
    await this.transport.send(
      ctx,
      "DELETE",
      `/v1/organization/invitations/${encodeURIComponent(id)}`,
    );
  }

  async lookupInvitation(ctx: CallContext, token: string): Promise<PendingInvitation> {
    // A POST with the secret in the body, never a GET with it in the path: a
    // path reaches access logs, browser history and every proxy in between,
    // and this secret is enough to join an office.
    const body = await this.transport.json<{
      organization: OrganizationBody;
      email: string;
      role: Role;
      account_exists: boolean;
    }>(ctx, "POST", "/v1/invitations/lookup", { token });

    return {
      organization: toOrganization(body.organization),
      email: body.email,
      role: body.role,
      accountExists: body.account_exists,
    };
  }

  async acceptInvitation(
    ctx: CallContext,
    input: {
      token: string;
      name?: string | undefined;
      password?: string | undefined;
      termsVersion?: string | undefined;
    },
  ): Promise<void> {
    await this.transport.send(ctx, "POST", "/v1/invitations/accept", {
      body: JSON.stringify({
        token: input.token,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.termsVersion === undefined ? {} : { terms_version: input.termsVersion }),
      }),
      contentType: "application/json",
    });
  }
}
