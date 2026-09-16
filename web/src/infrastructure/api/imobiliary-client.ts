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
  CurrentAccount,
  IdentityGateway,
  Invitation,
  InvitationStatus,
  Member,
  OrganizationGateway,
  PasswordGateway,
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
} {
  return {
    identity: new IdentityClient(transport),
    passwords: new PasswordClient(transport),
    secondFactor: new SecondFactorClient(transport),
    organizations: new OrganizationClient(transport),
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
