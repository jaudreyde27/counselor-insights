import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authorizeUrl,
  claimsToSession,
  cognitoConfig,
  createPkce,
  createVerifier,
  finishLogin,
  logoutUrl,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  sessionFromCookie,
  startLogin,
  type CognitoConfig,
} from "@/lib/auth/cognito";
import { authMode } from "@/lib/auth/dev";

// A FAKE identity provider: our own signing key stands in for Cognito's. No network, no AWS.
const cfg: CognitoConfig = {
  region: "us-west-2",
  userPoolId: "us-west-2_TESTPOOL1",
  clientId: "test-client-id-123",
  domain: "https://test-prefix.auth.us-west-2.amazoncognito.com",
  redirectUri: "https://studentcounseling.persimmon-care.com/auth/callback", // public address; the test requests below arrive on localhost, like the internal address behind the load balancer
  logoutUri: "https://studentcounseling.persimmon-care.com/login",
};
const ISSUER = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
const KID = "test-key-1";

let privateKey: KeyObject;
let otherPrivateKey: KeyObject;
let verify: (t: string) => Promise<Record<string, unknown>>;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(claims: Record<string, unknown> = {}, key: KeyObject = privateKey, kid = KID): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "11111111-2222-3333-4444-555555555555",
    email: "counselor@example.test",
    name: "Casey Counselor",
    token_use: "id",
    aud: cfg.clientId,
    iss: ISSUER,
    auth_time: now,
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const input = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key).toString("base64url");
  return `${input}.${sig}`;
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  otherPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const v = createVerifier(cfg);
  // Hand the verifier our fake provider's public key instead of fetching Cognito's.
  (v.jwks as unknown as { cacheJwks: (j: unknown) => void }).cacheJwks({
    keys: [{ ...(pair.publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }],
  });
  verify = v.verify;
});

const req = (path: string, cookie?: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie: Object.entries(cookie).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") } : {},
  });
const cookiesSet = (res: Response) => res.headers.getSetCookie();
const sessionCookie = (res: Response) => cookiesSet(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe("PKCE and the sign-in addresses", () => {
  it("makes a random verifier of a legal length, and a challenge that is its SHA-256 (S256)", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("builds the authorization URL: code flow, PKCE S256, our redirect, openid email profile", () => {
    const u = new URL(authorizeUrl(cfg, "state-abc", "challenge-xyz"));
    expect(u.origin + u.pathname).toBe(`${cfg.domain}/oauth2/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: "openid email profile",
      state: "state-abc",
      code_challenge: "challenge-xyz",
      code_challenge_method: "S256",
    });
  });

  it("builds the sign-out URL", () => {
    const u = new URL(logoutUrl(cfg));
    expect(u.pathname).toBe("/logout");
    expect(u.searchParams.get("client_id")).toBe(cfg.clientId);
    expect(u.searchParams.get("logout_uri")).toBe(cfg.logoutUri);
  });

  it("reads its settings from the environment, with a plain message for anything missing", () => {
    const env = { COGNITO_REGION: "us-west-2", COGNITO_USER_POOL_ID: "us-west-2_X", COGNITO_CLIENT_ID: "c", COGNITO_DOMAIN: "p.auth.us-west-2.amazoncognito.com", APP_BASE_URL: "https://studentcounseling.persimmon-care.com/" } as unknown as NodeJS.ProcessEnv;
    expect(cognitoConfig(env)).toMatchObject({
      domain: "https://p.auth.us-west-2.amazoncognito.com",
      redirectUri: "https://studentcounseling.persimmon-care.com/auth/callback",
      logoutUri: "https://studentcounseling.persimmon-care.com/login",
    });
    expect(() => cognitoConfig({ ...env, COGNITO_CLIENT_ID: "" })).toThrow(/COGNITO_CLIENT_ID is not set/);
  });

  it("the sign-in mode is dev, cognito or off, and dev is impossible in production", () => {
    expect(authMode({ AUTH_MODE: "dev", NODE_ENV: "development" } as never)).toBe("dev");
    expect(authMode({ AUTH_MODE: "cognito", NODE_ENV: "production" } as never)).toBe("cognito");
    expect(authMode({ NODE_ENV: "production" } as never)).toBe("off");
    expect(authMode({ AUTH_MODE: "anything", NODE_ENV: "development" } as never)).toBe("off");
    expect(() => authMode({ AUTH_MODE: "dev", NODE_ENV: "production" } as never)).toThrow();
  });
});

describe("starting sign-in", () => {
  it("redirects to the hosted page and remembers state + verifier in a short-lived httpOnly cookie", () => {
    const res = startLogin(cfg, { NODE_ENV: "development" } as never);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(cfg.domain);
    const c = cookiesSet(res).find((x) => x.startsWith(`${OAUTH_COOKIE}=`))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=lax/i);
    expect(c).toMatch(/Path=\/auth/);
    expect(c).toMatch(/Max-Age=600/);
    expect(c).not.toMatch(/Secure/i); // plain http is fine on localhost
    const saved = JSON.parse(decodeURIComponent(c.split(";")[0].slice(OAUTH_COOKIE.length + 1)));
    expect(saved.state).toBe(loc.searchParams.get("state"));
    expect(createHash("sha256").update(saved.verifier).digest("base64url")).toBe(loc.searchParams.get("code_challenge"));
  });

  it("marks the cookie Secure in production", () => {
    const c = cookiesSet(startLogin(cfg, { NODE_ENV: "production" } as never))[0];
    expect(c).toMatch(/Secure/i);
  });

  it("every sign-in gets a different state", () => {
    const state = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("state");
    expect(state(startLogin(cfg))).not.toBe(state(startLogin(cfg)));
  });
});

describe("finishing sign-in (against the fake provider)", () => {
  const saved = { state: "the-state-value", verifier: "the-verifier-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  // `null` means "send no cookie at all" (passing undefined would silently use the default).
  const callback = (extra = "", cookie: Record<string, string> | null = { [OAUTH_COOKIE]: JSON.stringify(saved) }) =>
    req(`/auth/callback?code=the-code&state=${saved.state}${extra}`, cookie ?? undefined);
  const idp = (token: string, calls: Array<{ url: string; body: URLSearchParams }> = []) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: init.body as URLSearchParams });
      return Response.json({ id_token: token, access_token: "ignored", refresh_token: "ignored" });
    }) as unknown as typeof fetch;
  const failed = (res: Response, code: string) => {
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(`/login?error=${code}`);
    // The redirect goes to the app's PUBLIC address, not the address the request arrived on (behind the load balancer that is internal).
    expect(new URL(res.headers.get("location")!).origin).toBe("https://studentcounseling.persimmon-care.com");
    expect(sessionCookie(res)).toBeUndefined(); // no session is ever started on a failure
  };

  it("swaps the code (with the PKCE verifier, no client secret) for a token, verifies it, and starts the session", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const token = mint();
    const res = await finishLogin(callback(), cfg, { verify, fetchFn: idp(token, calls), env: { NODE_ENV: "production" } as never });

    expect(new URL(res.headers.get("location")!).pathname).toBe("/students");
    expect(new URL(res.headers.get("location")!).origin).toBe("https://studentcounseling.persimmon-care.com"); // not the request's own (internal) address
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${cfg.domain}/oauth2/token`);
    expect(Object.fromEntries(calls[0].body)).toEqual({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code: "the-code",
      redirect_uri: cfg.redirectUri,
      code_verifier: saved.verifier,
    });
    const c = sessionCookie(res)!;
    expect(c.startsWith(`${SESSION_COOKIE}=${token}`)).toBe(true);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=lax/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/Path=\//);
    const maxAge = Number(/Max-Age=(\d+)/.exec(c)![1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600); // the session lasts exactly as long as the token
    // the one-time sign-in cookie is cleared
    expect(cookiesSet(res).some((x) => x.startsWith(`${OAUTH_COOKIE}=`) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(x))).toBe(true);
  });

  it("turns a cancelled sign-in into a plain message and starts nothing", async () => {
    failed(await finishLogin(callback("&error=access_denied"), cfg, { verify, fetchFn: idp(mint()) }), "cancelled");
  });

  it("refuses a state that does not match, a missing sign-in cookie, a missing code, and a mangled cookie", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const f = idp(mint(), calls);
    failed(await finishLogin(req(`/auth/callback?code=c&state=WRONG`, { [OAUTH_COOKIE]: JSON.stringify(saved) }), cfg, { verify, fetchFn: f }), "expired");
    failed(await finishLogin(callback("", null), cfg, { verify, fetchFn: f }), "expired");
    failed(await finishLogin(req(`/auth/callback?state=${saved.state}`, { [OAUTH_COOKIE]: JSON.stringify(saved) }), cfg, { verify, fetchFn: f }), "expired");
    failed(await finishLogin(callback("", { [OAUTH_COOKIE]: "{not json" }), cfg, { verify, fetchFn: f }), "expired");
    failed(await finishLogin(callback("", { [OAUTH_COOKIE]: JSON.stringify({ state: saved.state }) }), cfg, { verify, fetchFn: f }), "expired");
    expect(calls).toHaveLength(0); // the code was never even exchanged
  });

  it("fails cleanly when the token exchange is refused or the provider is unreachable", async () => {
    const refused = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    failed(await finishLogin(callback(), cfg, { verify, fetchFn: refused }), "failed");
    failed(await finishLogin(callback(), cfg, { verify, fetchFn: down }), "failed");
    failed(await finishLogin(callback(), cfg, { verify, fetchFn: (async () => Response.json({})) as unknown as typeof fetch }), "failed"); // no id_token
  });

  it("rejects a token that is forged, for another app, from another pool, expired, or the wrong kind", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: Record<string, string> = {
      "signed with a different key": mint({}, otherPrivateKey),
      "unknown key id": mint({}, privateKey, "other-kid"),
      "another app client": mint({ aud: "someone-elses-client" }),
      "another user pool": mint({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHERPOOL" }),
      expired: mint({ iat: now - 7200, exp: now - 3600 }),
      "an access token, not an ID token": mint({ token_use: "access" }),
      "garbage": "not.a.jwt",
    };
    for (const [why, token] of Object.entries(bad)) {
      const res = await finishLogin(callback(), cfg, { verify, fetchFn: idp(token) });
      expect(sessionCookie(res), why).toBeUndefined();
      expect(new URL(res.headers.get("location")!).search, why).toBe("?error=failed");
    }
  });

  it("rejects a valid token that has no email, because it cannot make an account from it", async () => {
    failed(await finishLogin(callback(), cfg, { verify, fetchFn: idp(mint({ email: undefined })) }), "failed");
  });
});

describe("reading the session on later requests", () => {
  it("gives the counselor's id, email and name for a valid session cookie", async () => {
    expect(await sessionFromCookie(mint(), verify)).toEqual({
      sub: "11111111-2222-3333-4444-555555555555",
      email: "counselor@example.test",
      displayName: "Casey Counselor",
    });
  });

  it("falls back to the email when there is no name", async () => {
    expect((await sessionFromCookie(mint({ name: undefined }), verify))?.displayName).toBe("counselor@example.test");
    expect((await sessionFromCookie(mint({ name: "   " }), verify))?.displayName).toBe("counselor@example.test");
  });

  it("is null for no cookie, an expired token, a tampered token, another key, or garbage", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = mint();
    const [h, p, s] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), email: "attacker@example.test" })).toString("base64url");
    for (const token of [undefined, "", mint({ iat: now - 7200, exp: now - 60 }), `${h}.${forgedPayload}.${s}`, mint({}, otherPrivateKey), "x.y.z", good.slice(0, -4) + "AAAA"]) {
      expect(await sessionFromCookie(token, verify), String(token).slice(0, 20)).toBeNull();
    }
  });

  it("claimsToSession needs both a subject and an email", () => {
    expect(claimsToSession({ sub: "s", email: "e@x.test" })).toEqual({ sub: "s", email: "e@x.test", displayName: "e@x.test" });
    expect(claimsToSession({ sub: "s" })).toBeNull();
    expect(claimsToSession({ email: "e@x.test" })).toBeNull();
    expect(claimsToSession({ sub: 5, email: {} })).toBeNull();
  });
});
