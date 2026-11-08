import { describe, expect, it } from "vitest";
import { isSameSiteRequest } from "@/lib/remove-student";

const req = (site?: string) => new Request("https://studentcounseling.persimmon-care.com/api/students/x", { method: "DELETE", headers: site ? { "sec-fetch-site": site } : {} });

describe("button requests", () => {
  it("accepts requests from our own pages and refuses ones from other sites", () => {
    expect(isSameSiteRequest(req("same-origin"))).toBe(true);
    expect(isSameSiteRequest(req())).toBe(true); // older clients send no header; the session cookie is SameSite=Lax anyway
    expect(isSameSiteRequest(req("cross-site"))).toBe(false);
    expect(isSameSiteRequest(req("same-site"))).toBe(false);
  });
});
