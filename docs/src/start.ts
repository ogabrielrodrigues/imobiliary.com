/**
 * The Start instance.
 *
 * The framework looks for this file by convention and reads `startInstance`
 * from it. Its only job here is to register the request middleware that sets
 * the security headers on every response.
 */

import { createStart } from "@tanstack/react-start";

import { securityHeaders } from "./server/security-headers.ts";

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}));
