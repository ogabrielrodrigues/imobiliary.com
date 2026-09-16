import { useState } from "react";
import { IconShieldCheck, IconShieldOff } from "@tabler/icons-react";

import { summaryOf, type Failure } from "@/application/result";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import type { CurrentUser } from "@/server/auth";
import {
  confirmEnrollment,
  disableSecondFactor,
  regenerateRecoveryCodes,
  startEnrollment,
} from "@/server/mfa";

/**
 * The second factor.
 *
 * An administrator must have one and may not remove it, which is the API's
 * rule and the reason this panel is the only thing such an account can reach
 * until it is on. A member chooses, and the panel says what each state means
 * rather than showing a bare switch.
 */
export function SecondFactorPanel({
  user,
  recoveryCodesLeft,
}: {
  readonly user: CurrentUser;
  readonly recoveryCodesLeft: number;
}) {
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [working, setWorking] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const enabled = user.user.totpEnabled;
  const required = user.mfaEnrollmentRequired;

  async function start() {
    setWorking(true);
    setFailure(null);
    const result = await startEnrollment();
    setWorking(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setEnrollment(result.value);
  }

  async function confirm() {
    setWorking(true);
    setFailure(null);
    const result = await confirmEnrollment({ data: code });
    setWorking(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setCodes(result.value);
    setEnrollment(null);
    setCode("");
  }

  return (
    <section
      aria-labelledby="totp-title"
      className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex items-center gap-2">
        {enabled ? (
          <IconShieldCheck aria-hidden="true" className="size-5 text-success" />
        ) : (
          <IconShieldOff aria-hidden="true" className="size-5 text-faint" />
        )}
        <h2 id="totp-title" className="text-sm font-semibold">
          Verificação em duas etapas
        </h2>
      </div>

      <p className="font-reading text-small leading-relaxed text-muted-foreground">
        {enabled
          ? "Está ativa. Ao entrar, além da senha, pedimos um código do seu aplicativo de autenticação."
          : required
            ? "Administradores precisam ativar a verificação em duas etapas. Até ativar, esta é a única tela disponível."
            : "Ative para pedir um código do aplicativo de autenticação além da senha."}
      </p>

      {summaryOf(failure, {
        authentication: "Código ou senha incorretos.",
        forbidden: "Administradores não podem desativar a verificação em duas etapas.",
      }) !== null && (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failure, {
            authentication: "Código ou senha incorretos.",
            forbidden: "Administradores não podem desativar a verificação em duas etapas.",
          })}
        </p>
      )}

      {codes !== null && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {!enabled && enrollment === null && codes === null && (
        <Button onClick={start} disabled={working} className="self-start">
          {working ? "Preparando..." : "Ativar"}
        </Button>
      )}

      {enrollment !== null && (
        <div className="flex flex-col gap-4">
          <ol className="flex list-decimal flex-col gap-2 pl-5 font-reading text-small text-muted-foreground">
            <li>
              Abra seu aplicativo de autenticação e cadastre esta chave:
              <code className="mt-1 block font-mono text-small break-all text-foreground">
                {enrollment.secret}
              </code>
            </li>
            <li>Digite o código de seis dígitos que o aplicativo mostrar.</li>
          </ol>

          <FormField
            name="code"
            label="Código do aplicativo"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            onChange={(event) => {
              const next = event.currentTarget.value;
              setCode(next);
            }}
          />

          <div className="flex gap-2">
            <Button onClick={confirm} disabled={working}>
              {working ? "Confirmando..." : "Confirmar"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEnrollment(null);
                setCode("");
              }}
              disabled={working}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {enabled && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted-foreground">
            Códigos de recuperação disponíveis: <strong>{recoveryCodesLeft}</strong>
          </p>

          <FormField
            name="password"
            label="Sua senha"
            type="password"
            autoComplete="current-password"
            value={password}
            hint="Pedimos a senha para gerar novos códigos ou desativar."
            onChange={(event) => {
              const next = event.currentTarget.value;
              setPassword(next);
            }}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={working || password === ""}
              onClick={async () => {
                setWorking(true);
                setFailure(null);
                const result = await regenerateRecoveryCodes({ data: password });
                setWorking(false);
                setPassword("");
                if (!result.ok) {
                  setFailure(result.failure);
                  return;
                }
                setCodes(result.value);
              }}
            >
              Gerar novos códigos
            </Button>

            {user.role !== "admin" && (
              <Button
                variant="destructive"
                disabled={working || password === ""}
                onClick={async () => {
                  setWorking(true);
                  setFailure(null);
                  const result = await disableSecondFactor({ data: password });
                  setWorking(false);
                  setPassword("");
                  if (!result.ok) {
                    setFailure(result.failure);
                    return;
                  }
                  window.location.reload();
                }}
              >
                Desativar
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The recovery codes, shown once.
 *
 * The API keeps only their digests, so this is the only moment they exist in
 * readable form. Saying so is the difference between a list someone copies and
 * one they close.
 */
function RecoveryCodes({
  codes,
  onDone,
}: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-docs/40 bg-docs/10 px-4 py-3">
      <p className="text-small font-medium text-docs-soft">
        Guarde estes códigos agora. Eles não aparecem de novo.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-small">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <p className="font-reading text-caption text-muted-foreground">
        Cada código serve uma vez, no lugar do aplicativo. Gerar uma lista nova invalida esta.
      </p>
      <Button variant="secondary" size="sm" onClick={onDone} className="self-start">
        Guardei
      </Button>
    </div>
  );
}
