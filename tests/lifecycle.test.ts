import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAnalysis } from "@/lib/analysis/start";
import {
  activeUntil,
  DEFAULT_ACTIVE_UNTIL,
  endedPageHtml,
  formatEndDate,
  isAppActive,
  isValidDate,
  pacificDate,
} from "@/lib/lifecycle";
import { finishTranscription, startTranscription, type AudioDeps } from "@/lib/transcription/process";
import { proxy } from "@/proxy";

const at = (iso: string) => new Date(iso);
const env = (v?: string) => ({ ...(v === undefined ? {} : { APP_ACTIVE_UNTIL: v }) }) as NodeJS.ProcessEnv;

describe("the end date: active through the END of December 15, Pacific time", () => {
  it("the default is December 15, 2026, so the app cannot stay on forever if the setting is missing", () => {
    expect(DEFAULT_ACTIVE_UNTIL).toBe("2026-12-15");
    expect(activeUntil(env())).toBe("2026-12-15");
  });

  it("is active before the deadline, including the due date of December 2", () => {
    for (const d of ["2026-11-06T18:00:00Z", "2026-12-02T20:00:00Z", "2026-12-14T12:00:00Z", "2026-12-15T12:00:00Z"]) {
      expect(isAppActive(env(), at(d)), d).toBe(true);
    }
  });

  it("is still active in the last second of December 15 in Pacific time (23:59:59 PST = 07:59:59 UTC on the 16th)", () => {
    expect(pacificDate(at("2026-12-16T07:59:59Z"))).toBe("2026-12-15");
    expect(isAppActive(env(), at("2026-12-16T07:59:59Z"))).toBe(true);
  });

  it("switches off at midnight Pacific on December 16 (08:00:00 UTC) and stays off", () => {
    expect(pacificDate(at("2026-12-16T08:00:00Z"))).toBe("2026-12-16");
    for (const d of ["2026-12-16T08:00:00Z", "2026-12-16T20:00:00Z", "2026-12-31T00:00:00Z", "2027-06-01T00:00:00Z", "2030-01-01T00:00:00Z"]) {
      expect(isAppActive(env(), at(d)), d).toBe(false);
    }
  });

  it("handles daylight saving: a July date ends at 07:00 UTC the next day (PDT)", () => {
    const e = env("2026-07-15");
    expect(isAppActive(e, at("2026-07-16T06:59:59Z"))).toBe(true);
    expect(isAppActive(e, at("2026-07-16T07:00:00Z"))).toBe(false);
  });

  it("the date can be changed with APP_ACTIVE_UNTIL", () => {
    expect(isAppActive(env("2026-12-02"), at("2026-12-03T12:00:00Z"))).toBe(false);
    expect(isAppActive(env("2027-01-31"), at("2027-01-20T12:00:00Z"))).toBe(true);
    expect(isAppActive(env(" 2026-12-20 "), at("2026-12-19T12:00:00Z"))).toBe(true); // stray spaces are fine
  });

  it("a malformed setting switches the app OFF (it fails closed, never open)", () => {
    for (const bad of ["", "soon", "off", "never", "2026-02-30", "2026-13-01", "2026-12-15T00:00:00", "12/15/2026", "2026-1-5"]) {
      expect(isValidDate(bad), bad).toBe(false);
      expect(isAppActive(env(bad), at("2026-11-06T12:00:00Z")), bad).toBe(false);
    }
  });

  it("only real calendar dates are valid", () => {
    expect(isValidDate("2026-12-15")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true); // a leap day
    expect(isValidDate("2027-02-29")).toBe(false);
  });

  it("formats the date for the notice", () => {
    expect(formatEndDate(env())).toBe("December 15, 2026");
    expect(formatEndDate(env("2026-12-02"))).toBe("December 2, 2026");
  });
});

describe("the notice page", () => {
  const html = endedPageHtml(env());
  it("says the prototype ended, gives the date, and holds no student information", () => {
    expect(html).toContain("This prototype has been switched off");
    expect(html).toContain("December 15, 2026");
    expect(html).toContain("noindex");
    expect(html).toContain("Prototype");
    expect(html).not.toMatch(/<form|<input|href=/i); // nothing to sign in to or click
  });
});

describe("the request filter (src/proxy.ts)", () => {
  const saved = process.env.APP_ACTIVE_UNTIL;
  afterEach(() => {
    process.env.APP_ACTIVE_UNTIL = saved;
  });
  const req = (path: string, method = "GET") => new NextRequest(`http://localhost:3000${path}`, { method });
  const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

  describe("while active", () => {
    beforeEach(() => {
      process.env.APP_ACTIVE_UNTIL = "2099-12-31";
    });
    it("lets every request through", () => {
      for (const p of ["/", "/students", "/login", "/healthz", "/api/webhooks/assemblyai", "/api/sessions/x/upload-complete"]) {
        expect(passesThrough(proxy(req(p))), p).toBe(true);
      }
    });
  });

  describe("after the end date", () => {
    beforeEach(() => {
      process.env.APP_ACTIVE_UNTIL = "2020-01-01";
    });

    it("refuses every page with 410 and the notice, and tells search engines to stay away", async () => {
      for (const p of ["/", "/login", "/students", "/students/new", "/students/3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c", "/sessions/x", "/anything-else"]) {
        const res = proxy(req(p));
        expect(res.status, p).toBe(410);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("x-robots-tag")).toContain("noindex");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toContain("switched off");
      }
    });

    it("refuses form submissions and server actions (POSTs to a page)", async () => {
      for (const p of ["/students", "/students/new", "/login", "/students/3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c"]) {
        expect(proxy(req(p, "POST")).status, p).toBe(410);
      }
    });

    it("refuses uploads, the transcription webhook and local storage with a JSON 410", async () => {
      for (const [p, m] of [
        ["/api/webhooks/assemblyai", "POST"],
        ["/api/sessions/3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c/upload-complete", "POST"],
        ["/api/local-storage/audio/3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c.wav", "PUT"],
        ["/api/local-storage/audio/3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c.wav", "GET"],
      ] as const) {
        const res = proxy(req(p, m));
        expect(res.status, `${m} ${p}`).toBe(410);
        expect(await res.json()).toEqual({ error: "This prototype has been deactivated." });
      }
    });

    it("still answers the health check, so the load balancer does not keep restarting the app", () => {
      expect(passesThrough(proxy(req("/healthz")))).toBe(true);
    });
  });

  it("a malformed date also refuses everything (fails closed)", () => {
    process.env.APP_ACTIVE_UNTIL = "not-a-date";
    expect(proxy(req("/students")).status).toBe(410);
    expect(proxy(req("/api/webhooks/assemblyai", "POST")).status).toBe(410);
  });
});

describe("backup guards: background jobs do nothing after the end date", () => {
  const saved = process.env.APP_ACTIVE_UNTIL;
  const written: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.APP_ACTIVE_UNTIL = "2020-01-01";
    written.length = 0;
    spy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => (written.push(String(c)), true)) as never);
  });
  afterEach(() => {
    spy.mockRestore();
    process.env.APP_ACTIVE_UNTIL = saved;
  });

  it("no analysis (no model call) is started", async () => {
    await expect(startAnalysis("counselor", "session")).resolves.toBeUndefined();
    expect(written.join("")).toContain("analysis_skipped_deactivated");
    expect(written.join("")).not.toContain("analysis_started");
  });

  it("no transcription is started or finished, and nothing is touched", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("must not be used after the end date"); } });
    const deps = { storage: untouchable, transcription: untouchable, webhookSecret: "s", baseUrl: "http://x", pool: untouchable } as unknown as AudioDeps;
    await expect(startTranscription("c", "s", deps)).resolves.toBe("ignored");
    await expect(finishTranscription("c", "s", deps)).resolves.toBe("ignored");
  });
});
