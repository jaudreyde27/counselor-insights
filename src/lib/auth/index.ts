/**
 * All sign-in logic lives behind this one small module (SPEC.md section 8), so it
 * can be swapped (Cognito now planned, Clerk as the fallback) without touching pages.
 *
 * Today only the DEV login exists: fake counselors, for local work. It is
 * impossible to turn on in a production build (see dev.ts). Cognito arrives in Phase 3.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { findOrCreateCounselor } from "../db";
import { isAppActive } from "../lifecycle";
import { getVerifier, SESSION_COOKIE, sessionFromCookie } from "./cognito";
import { authMode, DEV_COUNSELORS, devLoginAllowed } from "./dev";

export { authMode, DEV_COUNSELORS, devLoginAllowed } from "./dev";

export interface CurrentCounselor {
  id: string;
  email: string;
  displayName: string;
}

const DEV_COOKIE = "ci_dev_login";

/** The signed-in counselor, or null. Cached per request. */
export const getCurrentCounselor = cache(async (): Promise<CurrentCounselor | null> => {
  // Always read the request's cookies first, so every page that asks who is signed in
  // is rendered per request, never prerendered at build time.
  const store = await cookies();
  if (!isAppActive()) return null; // after the end date nobody is signed in (see src/lib/lifecycle.ts)

  if (authMode() === "cognito") {
    // The session cookie holds Cognito's ID token; check its signature and claims on every request.
    const who = await sessionFromCookie(store.get(SESSION_COOKIE)?.value, getVerifier());
    if (!who) return null;
    const id = await findOrCreateCounselor(who.sub, who.email, who.displayName);
    return { id, email: who.email, displayName: who.displayName };
  }

  if (!devLoginAllowed()) return null; // Cognito goes here in Phase 3
  const sub = store.get(DEV_COOKIE)?.value;
  const dev = DEV_COUNSELORS.find((d) => d.sub === sub);
  if (!dev) return null;
  const id = await findOrCreateCounselor(dev.sub, dev.email, dev.displayName);
  return { id, email: dev.email, displayName: dev.displayName };
});

/** For pages and server actions that need a signed-in counselor. Sends everyone else to /login. */
export async function requireCounselor(): Promise<CurrentCounselor> {
  const c = await getCurrentCounselor();
  if (!c) redirect("/login");
  return c;
}

/** Dev login: remembers which fake counselor you chose (httpOnly cookie). */
export async function signInDev(sub: string): Promise<boolean> {
  if (!devLoginAllowed() || !DEV_COUNSELORS.some((d) => d.sub === sub)) return false;
  (await cookies()).set(DEV_COOKIE, sub, { httpOnly: true, sameSite: "lax", path: "/" });
  return true;
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(DEV_COOKIE);
  store.delete({ name: SESSION_COOKIE, path: "/" });
}
