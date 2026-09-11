# Security policy

Imobiliary Docs handles personal data that belongs to people who never used it —
tenants, guarantors, owners — so a vulnerability here is someone else's problem
too. If you found one, thank you for reporting it here rather than publishing it.

## Reporting

Write to the privacy and security contact named in
`docs/src/domain/legal.ts` (`CONTROLLER.privacyEmail`), which is the same
address served at `/.well-known/security.txt`. Please include:

- what you found and where — endpoint, page, or file and line;
- how to reproduce it, with the smallest request that shows it;
- what an attacker could do with it, as you understand it.

Do not send real personal data. If a finding exposes some, describe it and stop.

We acknowledge a report within five business days, keep you informed while it is
being fixed, and credit you when it is published unless you would rather not be
named.

## Safe harbour

Research carried out in good faith and within this policy is welcome. We will
not pursue it, provided you:

- test only against accounts you own or have explicit permission to use;
- do not access, alter or keep other people's data beyond what proving the issue
  strictly requires;
- do not degrade the service — no load testing, no deliberate rate-limit
  exhaustion against production;
- give us reasonable time to fix before disclosing.

Social engineering, physical attacks and findings in third-party services are out
of scope.

## Known and accepted

Listed so that nobody spends time rediscovering them. Each is recorded, with its
reasoning, in `docgen-api/PRIVACIDADE.md` and `CLAUDE.md`.

- **No encryption at rest.** Document contents and generated files are stored
  unencrypted. The privacy policy states this.
- **`'unsafe-inline'` in the Content-Security-Policy `script-src`.** The
  framework inlines its router state and a bootstrap script; it escapes `<`, `>`
  and `&` in that state, and the application has no raw-HTML sinks. Removing it
  needs a per-request nonce, which is planned.
- **The API terminates no TLS.** It must sit behind a TLS-terminating proxy and
  stay unreachable from outside; see the deployment section of `README.md`.

## Checking a change

Run `pnpm security` at the repository root before shipping. It audits the npm
and Go dependencies, checks formatting and vet, runs both test suites, enforces
the platform layer rule and lints the API specification, stopping at the first
failure.
