/**
 * The interfaces the application layer consumes.
 *
 * They are declared here, in the consumer, rather than beside the code that
 * implements them — the same discipline the Go API follows. That is what lets
 * `infrastructure` plug in without the inner layers ever importing it, and it
 * keeps each interface down to what one caller actually needs, so a test fake
 * is a few lines rather than a mock framework.
 */

import type { GeneratedDocument, GenerateInput } from "../domain/document.ts";
import type { Template, TemplateUploadInput } from "../domain/template.ts";
import type {
  LoginInput,
  RegistrationInput,
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

export interface AuthGateway {
  register(ctx: CallContext, input: RegistrationInput): Promise<User>;
  login(ctx: CallContext, input: LoginInput): Promise<Session>;
  /** Consumes the secret and returns a whole new session. */
  refresh(ctx: CallContext, refreshToken: string): Promise<Session>;
  /** Always succeeds, whether or not the secret matched a live session. */
  logout(ctx: CallContext, refreshToken: string): Promise<void>;
  currentUser(ctx: CallContext): Promise<User>;
}

export interface TemplateGateway {
  list(ctx: CallContext, page?: Page): Promise<Template[]>;
  get(ctx: CallContext, id: string): Promise<Template>;
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

export interface DocumentGateway {
  list(ctx: CallContext, page?: Page): Promise<GeneratedDocument[]>;
  get(ctx: CallContext, id: string): Promise<GeneratedDocument>;
  generate(ctx: CallContext, input: GenerateInput): Promise<GeneratedDocument>;
  download(ctx: CallContext, id: string): Promise<FileContent>;
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
