/**
 * The Start instance.
 *
 * The framework looks for this file by convention and reads `startInstance`
 * from it. Its only job here is to register the request middleware that sets
 * the security headers on every response.
 */

import { createStart } from "@tanstack/react-start";

import { assertLegalIdentityComplete } from "./domain/legal.ts";
import { securityHeaders } from "./server/security-headers.ts";

// A production deployment that has not filled in who the controller is would
// serve a privacy policy addressed to nobody. It is stopped at the door, the
// same way a missing session secret is.
if (process.env["NODE_ENV"] === "production") {
  assertLegalIdentityComplete();
}

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}));
