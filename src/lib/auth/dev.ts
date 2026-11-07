/** Rules for the local, fake-counselor login. No framework imports, so tests can check them directly. */

/** The fake counselors the dev login offers. */
export const DEV_COUNSELORS = [
  { sub: "dev-counselor-1", email: "alex.rivera@example.test", displayName: "Alex Rivera" },
  { sub: "dev-counselor-2", email: "sam.patel@example.test", displayName: "Sam Patel" },
] as const;

/** Throws if the dev login is switched on in a production build. Never allowed. */
export function assertDevLoginSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") {
    throw new Error("AUTH_MODE=dev is not allowed in a production build.");
  }
}

/** Which sign-in is on: the fake local one ("dev"), AWS Cognito ("cognito"), or none ("off"). */
export type AuthMode = "dev" | "cognito" | "off";

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  assertDevLoginSafe(env); // dev + production is never allowed
  return env.AUTH_MODE === "dev" ? "dev" : env.AUTH_MODE === "cognito" ? "cognito" : "off";
}

/** True only for local development (and tests) with AUTH_MODE=dev. */
export function devLoginAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  assertDevLoginSafe(env);
  return env.AUTH_MODE === "dev";
}
