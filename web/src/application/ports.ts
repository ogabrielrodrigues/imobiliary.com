/**
 * The interfaces the application layer consumes.
 *
 * They are declared here, in the consumer, rather than beside the code that
 * implements them, which is the same discipline the Go API follows. That is
 * what lets `infrastructure` plug in without the inner layers ever importing
 * it, and it keeps each interface down to what one caller needs, so a test
 * fake is a few lines rather than a mock framework.
 */

import type {
  Balance,
  LedgerEntry,
  ManualEntryInput,
  PayoutDetail,
  PayoutInput,
  PayoutsPage,
  PersonLedger,
} from "../domain/payout.ts";
import type { Administrator } from "../domain/administrator.ts";
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
} from "../domain/user.ts";
import type {
  PeoplePage,
  Person,
  PersonInput,
  PersonKind,
} from "../domain/person.ts";
import type { PropertiesPage, Property, PropertyInput } from "../domain/property.ts";
import type {
  ChargeDestination,
  ChargeInput,
  Dashboard,
  PaymentInput,
  PaymentPreview,
  RentDetail,
  RentsPage,
} from "../domain/rent.ts";
import type {
  DocumentField,
  GeneratedDocument,
  GenerateInput,
  Template,
} from "../domain/document.ts";
import type {
  AmendmentInput,
  AmendmentPreview,
  Contract,
  ContractInput,
  ContractPreview,
  ContractsPage,
  ContractStatus,
} from "../domain/contract.ts";

/**
 * What a single call to the API needs beyond its arguments.
 *
 * `clientIp` is forwarded so the API's per-address rate limit still measures
 * real clients. Without it every request would arrive from this server's
 * address, and the limit that exists to stop password guessing would become
 * one shared bucket for everybody.
 */
export interface CallContext {
  readonly accessToken?: string | undefined;
  readonly clientIp?: string | undefined;
}

export interface Clock {
  now(): Date;
}

/** Where the session is kept between requests. */
export interface SessionStore {
  read(): Promise<Session | null>;
  write(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** Signing in, and everything that keeps a session alive. */
export interface IdentityGateway {
  /**
   * Answers the same whether or not the address already had an account, so
   * nothing comes back to tell the two apart.
   */
  register(ctx: CallContext, input: RegistrationInput): Promise<void>;
  signIn(ctx: CallContext, input: SignInInput): Promise<SignInOutcome>;
  /** Finishes a sign-in with a code from the app or a recovery code. */
  completeSecondFactor(
    ctx: CallContext,
    input: { challenge: string; code: string; organizationId?: string | undefined },
  ): Promise<Session>;
  /** Consumes the secret and returns a whole new session. */
  refresh(ctx: CallContext, refreshToken: string): Promise<Session>;
  /** Always succeeds, whether or not the secret matched a live session. */
  signOut(ctx: CallContext, refreshToken: string): Promise<void>;
  /** Moves the session to another office the same account belongs to. */
  switchOrganization(
    ctx: CallContext,
    input: { refreshToken: string; organizationId: string },
  ): Promise<Session>;
  me(ctx: CallContext): Promise<CurrentAccount>;
  /**
   * Mints a token for the document service from the session's own access
   * token, which `ctx` carries. It lasts five minutes, names the office, and
   * is the only credential the document service ever sees.
   */
  docgenToken(ctx: CallContext): Promise<DocgenToken>;
}

/** A short token for the document service, and when it stops being accepted. */
export interface DocgenToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** What /v1/me answers: the account, where it is working, and what it may do. */
export interface CurrentAccount {
  readonly user: User;
  readonly organization: Organization;
  readonly role: Role;
  readonly organizations: readonly Membership[];
  readonly mfaEnrollmentRequired: boolean;
  readonly recoveryCodesLeft: number;
}

export interface PasswordGateway {
  /** Ends every session of the account, this one included. */
  change(ctx: CallContext, input: { currentPassword: string; newPassword: string }): Promise<void>;
  /** Always succeeds, whether or not the address belongs to anyone. */
  forget(ctx: CallContext, email: string): Promise<void>;
  reset(ctx: CallContext, input: { token: string; password: string }): Promise<void>;
}

/** The office's register of people. */
export interface PeopleGateway {
  /**
   * A page of the alphabetical list. A query that is a CPF or CNPJ finds that
   * document exactly; anything else matches a fragment of the name.
   */
  list(
    ctx: CallContext,
    query: { q?: string; kind?: PersonKind; cursor?: string; limit?: number },
  ): Promise<PeoplePage>;
  get(ctx: CallContext, id: string): Promise<Person>;
  create(ctx: CallContext, input: PersonInput): Promise<Person>;
  /** Replaces the person as of `version`; a newer one is a StaleVersionError. */
  update(ctx: CallContext, id: string, version: number, input: PersonInput): Promise<Person>;
  /** A person something still links to is an InUseError. */
  remove(ctx: CallContext, id: string): Promise<void>;
}

/** The office's register of properties. */
export interface PropertiesGateway {
  list(
    ctx: CallContext,
    query: { q?: string; ownerId?: string; cursor?: string; limit?: number },
  ): Promise<PropertiesPage>;
  get(ctx: CallContext, id: string): Promise<Property>;
  create(ctx: CallContext, input: PropertyInput): Promise<Property>;
  update(ctx: CallContext, id: string, version: number, input: PropertyInput): Promise<Property>;
  remove(ctx: CallContext, id: string): Promise<void>;
}

/** The office's leases. */
export interface ContractsGateway {
  list(
    ctx: CallContext,
    query: { q?: string; propertyId?: string; personId?: string; status?: ContractStatus; cursor?: string; limit?: number },
  ): Promise<ContractsPage>;
  /** The schedule and the notices the terms raise, without saving anything. */
  preview(ctx: CallContext, input: ContractInput): Promise<ContractPreview>;
  get(ctx: CallContext, id: string): Promise<Contract>;
  create(ctx: CallContext, input: ContractInput): Promise<Contract>;
  update(ctx: CallContext, id: string, version: number, input: ContractInput): Promise<Contract>;
  terminate(ctx: CallContext, id: string, version: number, on: string): Promise<Contract>;
  /** A contract with a paid rent is an InUseError. */
  remove(ctx: CallContext, id: string): Promise<void>;
  /** What a rent adjustment would do, recording nothing. */
  previewAmendment(ctx: CallContext, id: string, input: AmendmentInput): Promise<AmendmentPreview>;
  amend(ctx: CallContext, id: string, version: number, input: AmendmentInput): Promise<Contract>;
  undoAmendment(ctx: CallContext, id: string, amendmentId: string, version: number): Promise<Contract>;
  /**
   * The values a lease template is filled with: the qualification of each
   * party, the money in words, the guarantee, the dates and the forum.
   */
  documentFields(ctx: CallContext, id: string): Promise<DocumentField[]>;
}

/** A file on its way to the browser. */
export interface FileContent {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * The document service, which holds the templates and renders the files.
 *
 * Every call carries a token minted for the office, never this API's own
 * session, so the service knows the office and nothing else about a lease.
 */
export interface DocumentsGateway {
  /** The office's templates, with the latest version's placeholders. */
  listTemplates(ctx: CallContext): Promise<Template[]>;
  getTemplate(ctx: CallContext, id: string): Promise<Template>;
  /** The stored archive, read to draw the preview of a template. */
  downloadTemplateVersion(ctx: CallContext, id: string, version: number): Promise<Uint8Array>;
  generate(ctx: CallContext, input: GenerateInput): Promise<GeneratedDocument>;
  /** Every document generated for one record, such as a contract. */
  listByReference(ctx: CallContext, reference: string): Promise<GeneratedDocument[]>;
  download(ctx: CallContext, id: string): Promise<FileContent>;
  remove(ctx: CallContext, id: string): Promise<void>;
}

/** The office's instalments across contracts, and the dashboard. */
export interface RentsGateway {
  list(
    ctx: CallContext,
    query: {
      q?: string;
      status?: "overdue" | "pending" | "open" | "paid";
      dueFrom?: string;
      dueTo?: string;
      contractId?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<RentsPage>;
  get(ctx: CallContext, id: string): Promise<RentDetail>;
  previewPayment(ctx: CallContext, id: string, paidOn: string): Promise<PaymentPreview>;
  /** One already paid, even by a simultaneous request, is a ConflictError. */
  pay(ctx: CallContext, id: string, input: PaymentInput): Promise<RentDetail>;
  reverse(ctx: CallContext, id: string): Promise<RentDetail>;
  addCharge(ctx: CallContext, id: string, input: ChargeInput): Promise<RentDetail>;
  removeCharge(ctx: CallContext, id: string, chargeId: string): Promise<RentDetail>;
  /** Also on a paid rent, until it is in a payout. */
  setChargeDestination(ctx: CallContext, id: string, chargeId: string, destination: ChargeDestination): Promise<RentDetail>;
  dashboard(ctx: CallContext): Promise<Dashboard>;
}

/** What the LGPD lets a person ask about their own account. */
export interface PrivacyGateway {
  /**
   * The copy of everything held about the account, as the API's JSON text.
   * Kept as text: it is handed to the person as a file, not read here.
   */
  exportData(ctx: CallContext): Promise<string>;
  /** Erases the account. Refused while it is an office's only administrator. */
  deleteAccount(ctx: CallContext, password: string): Promise<void>;
}

export interface SecondFactorGateway {
  /** Starts an enrolment: a secret, and the otpauth address behind the QR code. */
  start(ctx: CallContext): Promise<{ secret: string; uri: string }>;
  /** Proves a code and turns it on, returning the recovery codes once. */
  confirm(ctx: CallContext, code: string): Promise<readonly string[]>;
  disable(ctx: CallContext, password: string): Promise<void>;
  regenerateRecoveryCodes(ctx: CallContext, password: string): Promise<readonly string[]>;
}

export interface Member {
  readonly user: User;
  readonly role: Role;
  readonly joinedAt: Date;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface OrganizationGateway {
  rename(ctx: CallContext, name: string): Promise<void>;
  /** Who signs the receipts; null until the office says. */
  administrator(ctx: CallContext): Promise<Administrator | null>;
  /** Administrators only. */
  setAdministrator(ctx: CallContext, input: Administrator): Promise<Administrator>;
  members(ctx: CallContext): Promise<readonly Member[]>;
  changeRole(ctx: CallContext, userId: string, role: Role): Promise<void>;
  removeMember(ctx: CallContext, userId: string): Promise<void>;
  invitations(ctx: CallContext): Promise<readonly Invitation[]>;
  invite(ctx: CallContext, input: { email: string; role: Role }): Promise<Invitation>;
  revokeInvitation(ctx: CallContext, id: string): Promise<void>;
  /** Reads an invitation by its secret, for the screen that shows it. */
  lookupInvitation(ctx: CallContext, token: string): Promise<PendingInvitation>;
  acceptInvitation(
    ctx: CallContext,
    input: {
      token: string;
      name?: string | undefined;
      password?: string | undefined;
      termsVersion?: string | undefined;
    },
  ): Promise<void>;
}

/** The owners' ledger and the payouts the office records. */
export interface PayoutsGateway {
  balances(ctx: CallContext): Promise<readonly Balance[]>;
  ledger(ctx: CallContext, personId: string): Promise<PersonLedger>;
  addEntry(ctx: CallContext, personId: string, input: ManualEntryInput): Promise<LedgerEntry>;
  deleteEntry(ctx: CallContext, entryId: string): Promise<void>;
  /** A line another payout took meanwhile is a ConflictError or a ValidationError. */
  create(ctx: CallContext, input: PayoutInput): Promise<PayoutDetail>;
  get(ctx: CallContext, id: string): Promise<PayoutDetail>;
  list(ctx: CallContext, query: { personId?: string; cursor?: string; limit?: number }): Promise<PayoutsPage>;
  undo(ctx: CallContext, id: string): Promise<void>;
  /** What a statement template is filled with. */
  documentFields(ctx: CallContext, id: string): Promise<DocumentField[]>;
}
