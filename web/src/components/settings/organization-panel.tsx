import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { IconMail, IconTrash } from "@tabler/icons-react";

import type { Invitation, Member } from "@/application/ports";
import { summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import type { Role } from "@/domain/user";
import type { CurrentUser } from "@/server/auth";
import {
  changeMemberRole,
  inviteMember,
  removeMember,
  revokeInvitation,
} from "@/server/organization";

/**
 * The office: who works here, and who has been invited.
 *
 * Every member sees the list of colleagues, because they work together. Only
 * an administrator sees the invitations or can change anything, and the API
 * refuses the rest anyway: this hides what a member cannot do rather than
 * letting them find out through a refusal.
 */
export function OrganizationPanel({
  user,
  members,
  invitations,
}: {
  readonly user: CurrentUser;
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [working, setWorking] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");

  const isAdmin = user.role === "admin";
  const pending = invitations.filter((invitation) => invitation.status === "pending");

  async function run(action: () => Promise<{ ok: boolean; failure?: Failure }>) {
    setWorking(true);
    setFailure(null);
    const result = await action();
    setWorking(false);
    if (!result.ok && result.failure !== undefined) {
      setFailure(result.failure);
      return;
    }
    await router.invalidate();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {summaryOf(failure) !== null && (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failure)}
        </p>
      )}

      <section
        aria-labelledby="members-title"
        className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
      >
        <h2 id="members-title" className="text-sm font-semibold">
          {user.organization.name}
        </h2>
        <p className="font-reading text-small text-muted-foreground">
          {members.length === 1 ? "1 pessoa" : `${members.length} pessoas`} no escritório.
        </p>

        <ul className="flex flex-col divide-y divide-border">
          {members.map((member) => (
            <li key={member.user.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-small font-medium">{member.user.name}</span>
                <span className="truncate text-caption text-faint">{member.user.email}</span>
              </div>

              <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">
                {member.role === "admin" ? "administrador" : "membro"}
              </span>

              {isAdmin && member.user.id !== user.user.id && (
                <div className="flex gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={working}
                    onClick={() =>
                      run(async () => {
                        const next: Role = member.role === "admin" ? "member" : "admin";
                        const result = await changeMemberRole({
                          data: { userId: member.user.id, role: next },
                        });
                        return result.ok ? { ok: true } : { ok: false, failure: result.failure };
                      })
                    }
                  >
                    {member.role === "admin" ? "Tornar membro" : "Tornar administrador"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remover ${member.user.name}`}
                    disabled={working}
                    onClick={() =>
                      run(async () => {
                        const result = await removeMember({ data: member.user.id });
                        return result.ok ? { ok: true } : { ok: false, failure: result.failure };
                      })
                    }
                  >
                    <IconTrash aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && (
        <section
          aria-labelledby="invitations-title"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
        >
          <h2 id="invitations-title" className="text-sm font-semibold">
            Convites
          </h2>
          <p className="font-reading text-small text-muted-foreground">
            Quem for convidado recebe um link para criar a própria senha. O link vale por sete dias
            e serve uma vez.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <FormField
                name="email"
                label="E-mail"
                type="email"
                value={email}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setEmail(next);
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="role" className="text-small leading-none font-medium">
                Papel
              </label>
              <select
                id="role"
                value={role}
                onChange={(event) => setRole(event.currentTarget.value === "admin" ? "admin" : "member")}
                className="h-9.5 rounded-md border border-input-border bg-input px-3 text-sm"
              >
                <option value="member">Membro</option>
                <option value="admin">Administrador</option>
              </select>
            </div>

            <Button
              disabled={working || email === ""}
              onClick={() =>
                run(async () => {
                  const result = await inviteMember({ data: { email, role } });
                  if (result.ok) setEmail("");
                  return result.ok ? { ok: true } : { ok: false, failure: result.failure };
                })
              }
            >
              <IconMail aria-hidden="true" className="size-4" />
              Convidar
            </Button>
          </div>

          {pending.length > 0 && (
            <ul className="flex flex-col divide-y divide-border">
              {pending.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-small">{invitation.email}</span>
                    <span className="text-caption text-faint">
                      {invitation.role === "admin" ? "Administrador" : "Membro"} · expira em{" "}
                      {invitation.expiresAt.toLocaleDateString("pt-BR")}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={working}
                    onClick={() =>
                      run(async () => {
                        const result = await revokeInvitation({ data: invitation.id });
                        return result.ok ? { ok: true } : { ok: false, failure: result.failure };
                      })
                    }
                  >
                    Cancelar
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
