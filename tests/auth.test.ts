import { describe, expect, it } from "vitest";
import { assertDevLoginSafe, DEV_COUNSELORS, devLoginAllowed } from "@/lib/auth/dev";

describe("dev login bypass", () => {
  it("is allowed in local development with AUTH_MODE=dev", () => {
    expect(devLoginAllowed({ AUTH_MODE: "dev", NODE_ENV: "development" } as never)).toBe(true);
  });

  it("is off unless AUTH_MODE=dev", () => {
    expect(devLoginAllowed({ NODE_ENV: "development" } as never)).toBe(false);
    expect(devLoginAllowed({ AUTH_MODE: "cognito", NODE_ENV: "production" } as never)).toBe(false);
    expect(devLoginAllowed({ NODE_ENV: "production" } as never)).toBe(false);
  });

  it("is impossible to enable in a production build", () => {
    const prod = { AUTH_MODE: "dev", NODE_ENV: "production" } as never;
    expect(() => devLoginAllowed(prod)).toThrow(/not allowed in a production build/);
    expect(() => assertDevLoginSafe(prod)).toThrow();
  });

  it("only offers clearly fake counselors", () => {
    for (const d of DEV_COUNSELORS) expect(d.email.endsWith("@example.test")).toBe(true);
  });
});
