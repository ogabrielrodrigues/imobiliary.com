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
