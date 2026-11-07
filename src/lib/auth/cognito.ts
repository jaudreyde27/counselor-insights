/**
 * Sign-in with AWS Cognito Managed Login (the hosted page), SPEC.md section 8:
 * authorization code flow with PKCE. Users are created by an admin in the Cognito console (no
 * self sign-up). The server checks the ID token's signature and claims (aws-jwt-verify) and keeps
 * the session in an httpOnly cookie.
 *
 * Written and fully tested against a FAKE identity provider, but NOT yet run against a real Cognito
 * user pool (that needs the AWS setup in docs/AWS_SETUP.md). No framework imports except
 * next/server's NextResponse, so it can be tested directly.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { NextResponse, type NextRequest } from "next/server";
import { logEvent } from "../log";

export const SESSION_COOKIE = "ci_session";
export const OAUTH_COOKIE = "ci_oauth";

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Hosted UI address, e.g. https://name.auth.us-east-2.amazoncognito.com */
  domain: string;
  /** Where Cognito sends the browser back, e.g. https://studentcounseling.persimmon-care.com/auth/callback */
  redirectUri: string;
  /** Where Cognito sends the browser after sign-out. */
  logoutUri: string;
}

/** Reads the Cognito settings from the environment, with a plain message for anything missing. */
export function cognitoConfig(env: NodeJS.ProcessEnv = process.env): CognitoConfig {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set. Cognito sign-in needs it (see .env.example).`);
    return v;
  };
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  let domain = need("COGNITO_DOMAIN").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(domain)) domain = `https://${domain}`;
  return {
    region: need("COGNITO_REGION"),
    userPoolId: need("COGNITO_USER_POOL_ID"),
    clientId: need("COGNITO_CLIENT_ID"),
    domain,
    redirectUri: `${base}/auth/callback`,
    logoutUri: `${base}/login`,
  };
}

// ---------------------------------------------------------------- PKCE

const b64url = (b: Buffer) => b.toString("base64url");

/** A fresh PKCE pair: a random verifier, and its SHA-256 challenge (the S256 method). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 characters, within the 43 to 128 the standard allows
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(cfg: CognitoConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${cfg.domain}/oauth2/authorize?${q}`;
}

export function logoutUrl(cfg: CognitoConfig): string {
  return `${cfg.domain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.logoutUri })}`;
}

// ---------------------------------------------------------------- tokens

export interface SessionClaims {
  sub: string;
  email: string;
  displayName: string;
}

export type Verify = (token: string) => Promise<Record<string, unknown>>;

/** Verifies an ID token's signature, issuer, audience, token type and expiry against the user pool's keys. */
export function createVerifier(cfg: CognitoConfig): { verify: Verify; jwks: CognitoJwtVerifier<never, never, never> } {
  const jwks = CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, tokenUse: "id", clientId: cfg.clientId }) as never;
  return { verify: (t) => (jwks as { verify: Verify }).verify(t), jwks };
}

let shared: { cfgKey: string; verify: Verify } | undefined;
/** The app-wide verifier (keeps Cognito's signing keys cached between requests). */
export function getVerifier(cfg = cognitoConfig()): Verify {
  const key = `${cfg.userPoolId}|${cfg.clientId}`;
  if (shared?.cfgKey !== key) shared = { cfgKey: key, verify: createVerifier(cfg).verify };
  return shared.verify;
}

/** From a verified token's claims, or null if it lacks what we need. Never throws. */
export function claimsToSession(claims: Record<string, unknown>): SessionClaims | null {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!sub || !email) return null;
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { sub, email, displayName: name };
}

/** The signed-in person for a session cookie value, or null (missing, expired, tampered or wrong pool). */
export async function sessionFromCookie(value: string | undefined, verify: Verify): Promise<SessionClaims | null> {
  if (!value) return null;
  try {
    return claimsToSession(await verify(value));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the flow

const secureCookies = (env: NodeJS.ProcessEnv = process.env) => env.NODE_ENV === "production";

/** Step 1: remember a one-time state and PKCE verifier, then send the browser to the hosted sign-in page. */
export function startLogin(cfg: CognitoConfig, env: NodeJS.ProcessEnv = process.env): NextResponse {
  const state = b64url(randomBytes(24));
  const { verifier, challenge } = createPkce();
  const res = NextResponse.redirect(authorizeUrl(cfg, state, challenge));
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier }), {
    httpOnly: true,
    sameSite: "lax", // must survive the redirect back from Cognito
    secure: secureCookies(env),
    path: "/auth",
    maxAge: 10 * 60,
  });
  return res;
}

const back = (request: NextRequest, error: string) => {
  const res = NextResponse.redirect(new URL(`/login?error=${error}`, request.url));
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/auth" });
  return res;
};

const sameString = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export interface CallbackDeps {
  fetchFn?: typeof fetch;
  verify: Verify;
  env?: NodeJS.ProcessEnv;
}

/**
 * Step 2 (/auth/callback): check the state, swap the code (with the PKCE verifier) for tokens,
 * verify the ID token, and start a session cookie that lasts as long as the token. Anything that
 * goes wrong sends the person back to /login with a short code, and starts no session.
 */
export async function finishLogin(request: NextRequest, cfg: CognitoConfig, deps: CallbackDeps): Promise<NextResponse> {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back(request, "cancelled");

  let saved: { state?: string; verifier?: string } = {};
  try {
    saved = JSON.parse(request.cookies.get(OAUTH_COOKIE)?.value ?? "{}");
  } catch {
    // treated as missing below
  }
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!saved.state || !saved.verifier || !code || !state || !sameString(state, saved.state)) {
    logEvent("login_state_mismatch");
    return back(request, "expired");
  }

  let idToken: string | undefined;
  try {
    const res = await (deps.fetchFn ?? fetch)(`${cfg.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId, // a public client with PKCE: there is no client secret
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: saved.verifier,
      }),
    });
    if (!res.ok) throw new Error("token exchange refused");
    idToken = ((await res.json()) as { id_token?: string }).id_token;
  } catch {
    logEvent("login_token_exchange_failed");
    return back(request, "failed");
  }

  let claims: Record<string, unknown>;
  try {
    claims = await deps.verify(idToken ?? "");
  } catch {
    logEvent("login_token_rejected");
    return back(request, "failed");
  }
  const session = claimsToSession(claims);
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  const maxAge = exp - Math.floor(Date.now() / 1000);
  if (!session || !idToken || maxAge <= 0) return back(request, "failed");

  const res = NextResponse.redirect(new URL("/students", request.url));
  res.cookies.set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(deps.env),
    path: "/",
    maxAge,
  });
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/auth" });
  logEvent("login_succeeded");
  return res;
}
