/**
 * Runtime configuration, read once from the environment.
 *
 * Server-only. Nothing here may reach the browser bundle — the session secret
 * in particular.
 */

/** A sealed cookie is only as strong as its key. */
const MIN_SESSION_SECRET_LENGTH = 32;

export interface Config {
  /** Where the docgen API lives. Never exposed to the browser. */
  readonly apiUrl: string;
  /** Key that seals the session cookie. */
  readonly sessionSecret: string;
  /**
   * Whether this server itself sits behind a proxy that sets
   * `X-Forwarded-For`.
   *
   * Off by default. When this platform is the edge, the socket address is the
   * truth and the header is forgeable; honouring it then would let any client
   * choose the address the API rate-limits it by, which is the same as having
   * no per-IP limit at all.
   */
  readonly trustProxyHeaders: boolean;
  readonly isProduction: boolean;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const sessionSecret = process.env["SESSION_SECRET"] ?? "";
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    // Failing at boot is deliberate. A default would be shared by every
    // deployment that forgot to set one, which is worse than no secret at all.
    throw new Error(
      `SESSION_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters long. ` +
        "Generate one with: openssl rand -base64 48",
    );
  }

  cached = {
    apiUrl: process.env["DOCGEN_API_URL"] ?? "http://localhost:8080",
    sessionSecret,
    trustProxyHeaders: process.env["TRUST_PROXY_HEADERS"] === "true",
    isProduction: process.env["NODE_ENV"] === "production",
  };
  return cached;
}

/** Lets a test supply configuration without touching the environment. */
export function setConfigForTesting(config: Config | null): void {
  cached = config;
}
