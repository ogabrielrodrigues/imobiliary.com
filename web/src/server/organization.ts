/**
 * The office: its members, and the invitations that bring new ones in.
 */

import { createServerFn } from "@tanstack/react-start";

import type { Invitation, Member } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import {
  translateAdministratorProblem,
  validateAdministrator,
  type Administrator,
} from "../domain/administrator.ts";
import { fieldError, ValidationError, type FieldError } from "../domain/errors.ts";
import {
  validateEmail,
  validateName,
  validateOrganizationName,
  validatePassword,
  type PendingInvitation,
  type Role,
} from "../domain/user.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";
import { TERMS_VERSION } from "./auth.ts";

/** Everything the Organização tab shows, in one call. */
export interface OrganizationView {
  readonly members: readonly Member[];
  /** Only an administrator may read these, so a member gets an empty list. */
  readonly invitations: readonly Invitation[];
  /** Who signs the receipts; null until the office says. */
  readonly administrator: Administrator | null;
}

export const organizationView = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<OrganizationView>> =>
    attempt(async () => {
      const manager = sessions();
      return manager.authorize(callContext(), async (ctx) => {
        const members = await api().organizations.members(ctx);
        // A member may see who they work with and may not see the
        // invitations. Asking and discarding a refusal keeps one call site
        // rather than two views of the same screen.
        const invitations = await api()
          .organizations.invitations(ctx)
          .catch(() => [] as readonly Invitation[]);
        const administrator = await api().organizations.administrator(ctx);
        return { members, invitations, administrator };
      });
    }),
);

export const renameOrganization = createServerFn({ method: "POST" })
  .validator((name: string) => name)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      const invalid = validateOrganizationName(data);
      if (invalid) throw fieldError("name", invalid.message);

      const manager = sessions();
      await manager.authorize(callContext(), (ctx) =>
        api().organizations.rename(ctx, data.trim()),
      );
      return null;
    }),
  );

export const setAdministrator = createServerFn({ method: "POST" })
  .validator((input: Administrator) => input)
  .handler(async ({ data }): Promise<Result<Administrator>> =>
    attempt(async () => {
      assertSameOrigin();
      const problems = validateAdministrator(data);
      if (problems.length > 0) throw new ValidationError(problems);
      try {
        return await sessions().authorize(callContext(), (ctx) => api().organizations.setAdministrator(ctx, data));
      } catch (error) {
        if (error instanceof ValidationError) throw new ValidationError(error.fields.map(translateAdministratorProblem));
        throw error;
      }
    }),
  );

export interface InviteInput {
  readonly email: string;
  readonly role: Role;
}

export const inviteMember = createServerFn({ method: "POST" })
  .validator((input: InviteInput) => input)
  .handler(async ({ data }): Promise<Result<Invitation>> =>
    attempt(async () => {
      assertSameOrigin();
      const email = data.email.trim();
      const invalid = validateEmail(email);
      if (invalid) throw fieldError(invalid.field, invalid.message);

      const manager = sessions();
      return manager.authorize(callContext(), (ctx) =>
        api().organizations.invite(ctx, { email, role: data.role }),
      );
    }),
  );

export const revokeInvitation = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      const manager = sessions();
      await manager.authorize(callContext(), (ctx) =>
        api().organizations.revokeInvitation(ctx, data),
      );
      return null;
    }),
  );

export interface ChangeRoleInput {
  readonly userId: string;
  readonly role: Role;
}

export const changeMemberRole = createServerFn({ method: "POST" })
  .validator((input: ChangeRoleInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      const manager = sessions();
      await manager.authorize(callContext(), (ctx) =>
        api().organizations.changeRole(ctx, data.userId, data.role),
      );
      return null;
    }),
  );

export const removeMember = createServerFn({ method: "POST" })
  .validator((userId: string) => userId)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      const manager = sessions();
      await manager.authorize(callContext(), (ctx) =>
        api().organizations.removeMember(ctx, data),
      );
      return null;
    }),
  );

// --- joining ----------------------------------------------------------------

/**
 * Reads an invitation by its secret, for the screen that shows it.
 *
 * Unauthenticated on purpose: whoever opens the link is not signed in yet, and
 * the secret in their inbox is the credential.
 *
 * No Origin check, unlike every other POST here. The screen's loader calls this
 * while the server renders the page, and a page request carries no Origin
 * header, so the check refused every invitation and the screen said it was
 * invalid. The check exists to stop a cross-site request acting on the session
 * cookie; this reads, changes nothing, and uses no session. It is a POST only
 * so the secret travels in a body rather than in a logged address.
 */
export const lookupInvitation = createServerFn({ method: "POST" })
  .validator((token: string) => token)
  .handler(async ({ data }): Promise<Result<PendingInvitation>> =>
    attempt(async () => {
      if (data.trim() === "") throw fieldError("request", "O convite está incompleto.");
      return api().organizations.lookupInvitation(callContext(), data);
    }),
  );

export interface AcceptInvitationInput {
  readonly token: string;
  /** Both empty when the address already has an account. */
  readonly name: string;
  readonly password: string;
  readonly acceptedTerms: boolean;
  readonly accountExists: boolean;
}

/**
 * Joins the office, creating the account when there is none.
 *
 * No session is minted from a link that arrived by mail: the person signs in
 * afterwards, with the password they have just chosen or the one they already
 * had.
 */
export const acceptInvitation = createServerFn({ method: "POST" })
  .validator((input: AcceptInvitationInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      if (data.token.trim() === "") throw fieldError("request", "O convite está incompleto.");

      if (!data.accountExists) {
        const problems = [
          validateName(data.name),
          validatePassword(data.password),
          data.acceptedTerms ? null : { field: "terms", message: "É preciso aceitar os termos." },
        ].filter((problem): problem is FieldError => problem !== null);
        const first = problems[0];
        if (first !== undefined) throw fieldError(first.field, first.message);
      }

      await api().organizations.acceptInvitation(callContext(), {
        token: data.token,
        ...(data.accountExists
          ? {}
          : { name: data.name.trim(), password: data.password, termsVersion: TERMS_VERSION }),
      });
      return null;
    }),
  );
