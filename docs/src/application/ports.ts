/**
 * The interfaces the application layer consumes.
 *
 * They are declared here, in the consumer, rather than beside the code that
 * implements them — the same discipline the Go API follows. That is what lets
 * `infrastructure` plug in without the inner layers ever importing it, and it
 * keeps each interface down to what one caller actually needs, so a test fake
 * is a few lines rather than a mock framework.
 */

import type { Batch, HistoryEntry } from "../domain/batch.ts";
import type { GeneratedDocument, GenerateInput } from "../domain/document.ts";
import type { DashboardStats, StatsPeriod } from "../domain/stats.ts";
import type {
  Template,
  TemplateUploadInput,
  TemplateVersion,
} from "../domain/template.ts";
import type {
  LoginInput,
  Membership,
  Organization,
  Role,
  Session,
  User,
} from "../domain/user.ts";

/**
 * What a single call to the API needs to know beyond its arguments.
 *
 * `clientIp` is forwarded so the API's per-IP rate limit still measures real
 * clients. Without it every request would arrive from this server's address and
 * the limit that exists to stop password guessing would become one shared
 * bucket for every user at once.
 */
export interface CallContext {
  readonly accessToken?: string | undefined;
  readonly clientIp?: string | undefined;
}

export interface Page {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** The dashboard's figures, counted in the viewer's time zone. */
export interface StatsGateway {
  get(
    ctx: CallContext,
    query: { readonly days: StatsPeriod; readonly timeZone: string },
  ): Promise<DashboardStats>;
}

/**
 * What a sign-in attempt earns: either a session, or a challenge the second
 * factor's code is answered with.
 */
export type SignInOutcome =
  | { readonly kind: "session"; readonly session: Session }
  | {
      readonly kind: "second_factor";
      readonly challenge: string;
      readonly organizations: readonly Membership[];
    };

/** A short token for the document service, and when it stops being accepted. */
export interface DocgenToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * The Imobiliary platform, which owns identity.
 *
 * There is no sign-up, no password change and no recovery here: those belong
 * to that platform's own screens, and this one links to them.
 */
export interface IdentityGateway {
  signIn(ctx: CallContext, input: LoginInput): Promise<SignInOutcome>;
  /** One challenge is one attempt; a refused code sends the person back. */
  completeSecondFactor(
    ctx: CallContext,
    input: {
      readonly challenge: string;
      readonly code: string;
      readonly organizationId?: string | undefined;
    },
  ): Promise<Session>;
  /** Consumes the secret and returns a whole new session. */
  refresh(ctx: CallContext, refreshToken: string): Promise<Session>;
  /** Always succeeds, whether or not the secret matched a live session. */
  logout(ctx: CallContext, refreshToken: string): Promise<void>;
  /** Moves the session to another office the same account belongs to. */
  switchOrganization(
    ctx: CallContext,
    input: { readonly refreshToken: string; readonly organizationId: string },
  ): Promise<Session>;
  /**
   * Mints a token for the document service from the session's own access
   * token, which `ctx` carries. It lasts five minutes and is the only
   * credential the document service ever sees.
   */
  docgenToken(ctx: CallContext): Promise<DocgenToken>;
}

/** Who a document-service token speaks for. */
export interface Caller {
  readonly user: User;
  readonly office: Organization;
  readonly role: Role;
}

/** The office, as the document service holds it. */
export interface OfficeGateway {
  /** Useful for confirming a token is accepted, and whose office it names. */
  current(ctx: CallContext): Promise<Caller>;
  /** Everything the office holds there, as a file. Article 18, II and V. */
  exportOffice(ctx: CallContext): Promise<FileContent>;
}

export interface TemplateGateway {
  list(ctx: CallContext, page?: Page): Promise<Template[]>;
  get(ctx: CallContext, id: string): Promise<Template>;
  /**
   * Every version of one template, newest first.
   *
   * `get` reports only the latest, so this is the only way to learn what an
   * earlier version's placeholder schema was — which is what a caller needs in
   * order to offer a choice of version rather than only the newest.
   */
  versions(ctx: CallContext, id: string, page?: Page): Promise<TemplateVersion[]>;
  create(ctx: CallContext, input: TemplateUploadInput): Promise<Template>;
  addVersion(ctx: CallContext, id: string, file: File): Promise<Template>;
  remove(ctx: CallContext, id: string): Promise<void>;
  /** The stored archive, used to render a preview or reopen for editing. */
  downloadVersion(
    ctx: CallContext,
    id: string,
    version: number,
  ): Promise<Uint8Array>;
}

/** A file on its way to the browser. */
export interface FileContent {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** Narrows a listing. An absent field does not filter. */
export interface DocumentFilter {
  readonly templateId?: string | undefined;
  readonly batchId?: string | undefined;
  /** "oldest" lists in generation order; the API's default is newest first. */
  readonly order?: "newest" | "oldest" | undefined;
}

export interface BatchGateway {
  create(
    ctx: CallContext,
    input: { readonly templateId: string; readonly version?: number; readonly name: string },
  ): Promise<Batch>;
  get(ctx: CallContext, id: string): Promise<Batch>;
  /** Loose documents and batches, mixed, newest first. */
  history(
    ctx: CallContext,
    page?: Page,
    filter?: { readonly templateId?: string | undefined },
  ): Promise<HistoryEntry[]>;
  /** The batch as a ZIP of its documents. */
  download(ctx: CallContext, id: string): Promise<FileContent>;
  remove(ctx: CallContext, id: string): Promise<void>;
}

export interface DocumentGateway {
  list(ctx: CallContext, page?: Page, filter?: DocumentFilter): Promise<GeneratedDocument[]>;
  get(ctx: CallContext, id: string): Promise<GeneratedDocument>;
  generate(ctx: CallContext, input: GenerateInput): Promise<GeneratedDocument>;
  download(ctx: CallContext, id: string): Promise<FileContent>;
  /** Erases one document, its values and its file when nothing else uses it. */
  remove(ctx: CallContext, id: string): Promise<void>;
}

/**
 * Where the session lives between requests.
 *
 * The implementation is an encrypted httpOnly cookie, so page JavaScript never
 * sees a token and an XSS cannot lift a session.
 */
export interface SessionStore {
  read(): Promise<Session | null>;
  write(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** Injected so expiry can be tested by moving time rather than waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
