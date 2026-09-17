/**
 * The Imobiliary platform's client, for identity only.
 *
 * Accounts, passwords and second factors live on that platform. This platform
 * signs a person in against it, keeps the session, and asks it for a short
 * token whenever it needs to call the document service.
 *
 * Field names follow `imobiliary-api/openapi.yaml`, which is the contract.
 * Only the session routes are here: everything else that platform offers
 * belongs to its own screens.
 */

import type { CallContext } from "../../application/ports.ts";
import type {
  DocgenToken,
  IdentityGateway,
  SignInOutcome,
} from "../../application/ports.ts";
import type {
  LoginInput,
  Membership,
  Session,
} from "../../domain/user.ts";
import { Transport, type TransportOptions } from "./transport.ts";

interface ApiUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
  totp_enabled: boolean;
}

interface ApiOrganization {
  id: string;
  name: string;
}

interface ApiSession {
  user: ApiUser;
  organization: ApiOrganization;
  role: "admin" | "member";
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  mfa_enrollment_required: boolean;
}

interface ApiMembership {
  organization: ApiOrganization;
  role: "admin" | "member";
}

interface ApiSignIn {
  mfa_required: boolean;
  session?: ApiSession;
  challenge?: string;
  organizations: ApiMembership[];
}

interface ApiDocgenToken {
  token: string;
  expires_at: string;
}

function toSession(body: ApiSession): Session {
  return {
    accessToken: body.access_token,
    accessExpiresAt: new Date(body.access_expires_at),
    refreshToken: body.refresh_token,
    refreshExpiresAt: new Date(body.refresh_expires_at),
    user: {
      id: body.user.id,
      email: body.user.email,
      name: body.user.name,
      createdAt: new Date(body.user.created_at),
    },
    organization: { id: body.organization.id, name: body.organization.name },
    role: body.role,
  };
}

function toMembership(body: ApiMembership): Membership {
  return {
    organization: { id: body.organization.id, name: body.organization.name },
    role: body.role,
  };
}

export function createIdentityClient(options: TransportOptions): IdentityGateway {
  const http = new Transport(options);

  return {
    async signIn(ctx: CallContext, input: LoginInput): Promise<SignInOutcome> {
      const body = await http.json<ApiSignIn>(ctx, "POST", "/v1/sessions", {
        email: input.email,
        password: input.password,
      });

      // The platform answers either a session or a challenge. A challenge
      // without a session is the only shape the second factor arrives in, so a
      // missing session is read as one rather than as a malformed answer.
      if (body.mfa_required || body.session === undefined) {
        return {
          kind: "second_factor",
          challenge: body.challenge ?? "",
          organizations: body.organizations.map(toMembership),
        };
      }
      return { kind: "session", session: toSession(body.session) };
    },

    async completeSecondFactor(
      ctx: CallContext,
      input: { challenge: string; code: string; organizationId?: string | undefined },
    ): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/sessions/mfa", {
          challenge: input.challenge,
          code: input.code,
          ...(input.organizationId === undefined
            ? {}
            : { organization_id: input.organizationId }),
        }),
      );
    },

    async refresh(ctx: CallContext, refreshToken: string): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/sessions/refresh", {
          refresh_token: refreshToken,
        }),
      );
    },

    async logout(ctx: CallContext, refreshToken: string): Promise<void> {
      await http.send(ctx, "DELETE", "/v1/sessions", {
        body: JSON.stringify({ refresh_token: refreshToken }),
        contentType: "application/json",
      });
    },

    async switchOrganization(
      ctx: CallContext,
      input: { refreshToken: string; organizationId: string },
    ): Promise<Session> {
      return toSession(
        await http.json<ApiSession>(ctx, "POST", "/v1/sessions/switch", {
          refresh_token: input.refreshToken,
          organization_id: input.organizationId,
        }),
      );
    },

    async docgenToken(ctx: CallContext): Promise<DocgenToken> {
      const body = await http.json<ApiDocgenToken>(
        ctx,
        "POST",
        "/v1/sessions/docgen-token",
      );
      return { token: body.token, expiresAt: new Date(body.expires_at) };
    },
  };
}
