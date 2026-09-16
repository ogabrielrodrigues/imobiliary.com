// Everything a change has to pass before it ships, in one command.
//
// Run from the repository root with `pnpm security`. Steps run in order and the
// first failure stops the run with a non-zero exit, so a CI job added later can
// call this unchanged. Cheap checks go first: an advisory in a dependency is
// worth knowing before waiting on the integration suite.
//
// Tool versions are pinned. An unpinned `@latest` would make the result depend
// on the day it ran, which is the opposite of what a check is for.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "docgen-api");
const docs = join(root, "docs");
const imobiliary = join(root, "imobiliary-api");
const web = join(root, "web");
const ui = join(root, "packages", "ui");

const GOVULNCHECK = "golang.org/x/vuln/cmd/govulncheck@v1.8.0";
const REDOCLY = "@redocly/cli@2.52.0";

/** @type {{ name: string, cwd: string, command: string, args: string[], expectEmpty?: boolean }[]} */
const steps = [
  // --audit-level low: every advisory fails the run. A known one that is
  // accepted belongs in pnpm's auditConfig with a reason, not in a threshold.
  { name: "npm advisories", cwd: root, command: "pnpm", args: ["audit", "--audit-level", "low"] },
  // Reports only vulnerabilities the code can actually reach, and exits
  // non-zero when there is one.
  { name: "Go advisories", cwd: api, command: "go", args: ["run", GOVULNCHECK, "./..."] },
  // gofmt -l lists unformatted files and exits 0 either way, so the check is
  // that it printed nothing.
  { name: "gofmt", cwd: api, command: "gofmt", args: ["-l", "."], expectEmpty: true },
  { name: "go vet", cwd: api, command: "go", args: ["vet", "./..."] },
  { name: "go vet (integration)", cwd: api, command: "go", args: ["vet", "-tags=integration", "./..."] },
  { name: "Go tests, with integration", cwd: api, command: "go", args: ["test", "-tags=integration", "./..."] },
  { name: "imobiliary-api: Go advisories", cwd: imobiliary, command: "go", args: ["run", GOVULNCHECK, "./..."] },
  { name: "imobiliary-api: gofmt", cwd: imobiliary, command: "gofmt", args: ["-l", "."], expectEmpty: true },
  { name: "imobiliary-api: go vet", cwd: imobiliary, command: "go", args: ["vet", "./..."] },
  { name: "imobiliary-api: go vet (integration)", cwd: imobiliary, command: "go", args: ["vet", "-tags=integration", "./..."] },
  // The integration suite needs a local PostgreSQL. It reads its connection
  // from imobiliary-api/.env, and each test runs in a database of its own,
  // copied from a template.
  { name: "imobiliary-api: Go tests, with integration", cwd: imobiliary, command: "go", args: ["test", "-tags=integration", "./..."] },
  { name: "platform: types, layers, tests", cwd: docs, command: "pnpm", args: ["check"] },
  { name: "design package: types and tests", cwd: ui, command: "pnpm", args: ["check"] },
  { name: "web: types, layers, tests", cwd: web, command: "pnpm", args: ["check"] },
  // npx rather than pnpm dlx: dlx cannot choose between the package's two
  // binaries, and it records the version in pnpm-workspace.yaml as it goes.
  { name: "OpenAPI lint", cwd: api, command: "npx", args: ["--yes", REDOCLY, "lint", "openapi.yaml"] },
  { name: "imobiliary-api: OpenAPI lint", cwd: imobiliary, command: "npx", args: ["--yes", REDOCLY, "lint", "openapi.yaml"] },
];

for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n${label}`);

  // pnpm and npx are .cmd shims on Windows, which only a shell can start. The
  // arguments are this file's own constants, so joining them into one command
  // line quotes nothing it should not.
  const result = spawnSync([step.command, ...step.args].join(" "), {
    cwd: step.cwd,
    shell: true,
    stdio: step.expectEmpty ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });

  const printed = step.expectEmpty ? result.stdout.trim() : "";
  if (printed) console.log(printed);

  if (result.error || result.status !== 0 || printed) {
    console.error(`\n${label} failed.`);
    process.exit(result.status || 1);
  }
}

console.log(`\nAll ${steps.length} checks passed.`);
