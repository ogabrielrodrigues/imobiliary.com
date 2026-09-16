/**
 * Settings the server reads from its environment.
 *
 * Read through a function rather than at module load, so a test can set the
 * environment first and so an import never fixes a value at build time. It
 * grows in phase 1 with the session secret and the API's address, both of
 * which will fail closed the way the API's own configuration does.
 */
export interface Config {
  readonly isProduction: boolean;
}

export function getConfig(): Config {
  return { isProduction: process.env["NODE_ENV"] === "production" };
}
