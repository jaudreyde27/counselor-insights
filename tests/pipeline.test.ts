import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysisForSession, storeUtterances } from "@/lib/analysis/run";
import { loadCriteria } from "@/lib/criteria";
import { withCounselor } from "@/lib/db";
import { logEvent } from "@/lib/log";
import { buildConverseInput } from "@/lib/llm/bedrock";
import { MockLlmClient } from "@/lib/llm/mock";
import type { LlmClient, LlmRequest } from "@/lib/llm";
import { FIXTURE_NAMES, loadFixture } from "./helpers/llm";
import { setupTestDb, type TestDb } from "./helpers/db";

// Requires the local database: npm run db:up
const criteria = loadCriteria();

// Distinctive fake values, so any leak is easy to spot.
const FAKE = {
  studentName: "Zanzibar Quillfeather",
  school: "Stanford School of Medicine", // a real option in the app, so the check below is on the exact value
  program: "Zzyzx Hypothetical Studies",
  country: "Ruritania",
  studentNotes: "XYZZY-student-note-do-not-share",
  counselorName: "Counselor Plughole",
  counselorEmail: "plughole@example.test",
};

let db: TestDb;
let counselorId: string;
let studentId: string;

/** Wraps the mock and records everything that would be sent to the model. */
class SpyLlm implements LlmClient {
  readonly modelId = "mock";
  readonly requests: LlmRequest[] = [];
  private inner = new MockLlmClient();
  async completeJson(req: LlmRequest) {
    this.requests.push(req);
    return this.inner.completeJson(req);
  }
}

async function addSession(date: string, fixtureName: string, opts: { counselor?: string; student?: string } = {}) {
  const cid = opts.counselor ?? counselorId;
  const sid = opts.student ?? studentId;
  const { rows } = await db.admin.query(
    `INSERT INTO sessions (student_id, counselor_id, session_date, source, status)
     VALUES ($1,$2,$3,'pasted','transcribed') RETURNING id`,
    [sid, cid, date],
  );
  const sessionId = rows[0].id as string;
  await withCounselor(
    cid,
    (c) => storeUtterances(c, sessionId, loadFixture(fixtureName).map(({ speaker, text }) => ({ speaker, text }))),
    db.app,
  );
  return sessionId;
}

const fixtureNamed = (prefix: string) => FIXTURE_NAMES.find((n) => n.startsWith(prefix))!;

beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
  counselorId = (
    await db.admin.query(
      "INSERT INTO counselors (cognito_sub, email, display_name) VALUES ('sub-1',$1,$2) RETURNING id",
      [FAKE.counselorEmail, FAKE.counselorName],
    )
  ).rows[0].id;
  studentId = (
    await db.admin.query(
      `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin, notes)
       VALUES ($1,$2,$3,'masters',$4,$5,$6) RETURNING id`,
      [counselorId, FAKE.studentName, FAKE.school, FAKE.program, FAKE.country, FAKE.studentNotes],
    )
  ).rows[0].id;
});

describe("analysis pipeline with the database (mock AI)", () => {
  it("runs end to end and saves a complete, reproducible run", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("03"));
    const out = await runAnalysisForSession(counselorId, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app });
    expect(out.status).toBe("complete");

    const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
    const [session] = await q("SELECT status, current_analysis_run_id, error_message FROM sessions WHERE id=$1", [sessionId]);
    expect(session).toMatchObject({ status: "complete", current_analysis_run_id: out.runId, error_message: null });

    const [run] = await q("SELECT * FROM analysis_runs WHERE id=$1", [out.runId]);
    expect(run).toMatchObject({
      model_id: "mock",
      prompt_version: "v3",
      criteria_version: "1.1",
      status: "complete",
      dropped_quote_count: 0,
    });

    const themes = await q("SELECT id, sub_driver_id, domain_id FROM themes WHERE analysis_run_id=$1", [out.runId]);
    expect(themes.length).toBe(3);
    // every saved quote points at a real student utterance of this session and sits inside it
    const evidence = await q(
      `SELECT e.quote, u.text, u.speaker, u.session_id
         FROM theme_evidence e JOIN utterances u ON u.id = e.utterance_id
         JOIN themes t ON t.id = e.theme_id WHERE t.analysis_run_id=$1`,
      [out.runId],
    );
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    for (const e of evidence) {
      expect(e.speaker).toBe("student");
      expect(e.session_id).toBe(sessionId);
      expect(e.text).toContain(e.quote.replace(/\.$/, ""));
    }
    const recs = await q("SELECT based_on_theme_ids FROM recommendations WHERE analysis_run_id=$1", [out.runId]);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(2);
    const themeIds = new Set(themes.map((t) => t.id));
    for (const r of recs) for (const id of r.based_on_theme_ids) expect(themeIds.has(id)).toBe(true);
  });

  it("re-running keeps the earlier run and points the session at the new one", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("01"));
    const deps = { llm: new MockLlmClient(), criteria, pool: db.app };
    const first = await runAnalysisForSession(counselorId, sessionId, deps);
    const second = await runAnalysisForSession(counselorId, sessionId, deps);
    expect(second.runId).not.toBe(first.runId);

    const runs = (await db.admin.query("SELECT id FROM analysis_runs WHERE session_id=$1", [sessionId])).rows.map((r) => r.id);
    expect(runs.sort()).toEqual([first.runId, second.runId].sort());
    const cur = (await db.admin.query("SELECT current_analysis_run_id FROM sessions WHERE id=$1", [sessionId])).rows[0];
    expect(cur.current_analysis_run_id).toBe(second.runId);
    // the first run's themes are still there
    expect((await db.admin.query("SELECT 1 FROM themes WHERE analysis_run_id=$1", [first.runId])).rowCount).toBeGreaterThan(0);
  });

  it("uses earlier sessions' verified themes for call 2 and saves the 'changes' note", async () => {
    const earlier = await addSession("2026-10-01", fixtureNamed("01")); // loneliness, career norms, ...
    const later = await addSession("2026-11-01", fixtureNamed("03")); // loneliness again, financial strain (new), ...
    const spy = new SpyLlm();
    const deps = { llm: spy, criteria, pool: db.app };
    await runAnalysisForSession(counselorId, earlier, deps);
    spy.requests.length = 0;
    const out = await runAnalysisForSession(counselorId, later, deps);

    const call2 = JSON.parse(spy.requests.find((r) => r.schemaName === "report_recommendations")!.user);
    expect(call2.earlier_sessions.length).toBeGreaterThan(0);
    expect(call2.earlier_sessions.every((e: { session_date: string }) => e.session_date === "2026-10-01")).toBe(true);

    const [run] = (await db.admin.query("SELECT changes_since_earlier_sessions AS c FROM analysis_runs WHERE id=$1", [out.runId])).rows;
    expect(run.c.some((c: string) => c.includes("Financial strain came up this session but not before"))).toBe(true);
  });

  it("does not use a LATER session as 'earlier'", async () => {
    const early = await addSession("2026-10-01", fixtureNamed("01"));
    const late = await addSession("2026-12-01", fixtureNamed("03"));
    const spy = new SpyLlm();
    const deps = { llm: spy, criteria, pool: db.app };
    await runAnalysisForSession(counselorId, late, deps);
    spy.requests.length = 0;
    await runAnalysisForSession(counselorId, early, deps);
    const call2 = JSON.parse(spy.requests.find((r) => r.schemaName === "report_recommendations")!.user);
    expect(call2.earlier_sessions).toEqual([]);
  });

  it("another counselor cannot run analysis on this counselor's session", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("01"));
    const otherId = (
      await db.admin.query("INSERT INTO counselors (cognito_sub,email,display_name) VALUES ('sub-2','b@example.test','B') RETURNING id")
    ).rows[0].id;
    await expect(
      runAnalysisForSession(otherId, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app }),
    ).rejects.toThrow("Session not found.");
  });

  it("marks the session failed, with a generic message, when the model call breaks", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("01"));
    const boom: LlmClient = {
      modelId: "mock",
      async completeJson() {
        throw new Error("explosion that mentions: Back home I was an accountant");
      },
    };
    const out = await runAnalysisForSession(counselorId, sessionId, { llm: boom, criteria, pool: db.app });
    expect(out.status).toBe("failed");
    const [s] = (await db.admin.query("SELECT status, error_message FROM sessions WHERE id=$1", [sessionId])).rows;
    expect(s.status).toBe("failed");
    expect(s.error_message).toContain("Re-run analysis");
    expect(s.error_message).not.toContain("accountant");
    expect((await db.admin.query("SELECT status FROM analysis_runs WHERE id=$1", [out.runId])).rows[0].status).toBe("failed");

    // and "Re-run analysis" works afterwards
    const retry = await runAnalysisForSession(counselorId, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app });
    expect(retry.status).toBe("complete");
  });
});

describe("privacy: what the model sees", () => {
  it("the payload contains none of the student record, counselor notes or counselor details", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("02"));
    const spy = new SpyLlm();
    await runAnalysisForSession(counselorId, sessionId, { llm: spy, criteria, pool: db.app });
    expect(spy.requests.map((r) => r.schemaName)).toEqual(["report_themes", "report_recommendations"]);

    for (const req of spy.requests) {
      // the exact request text, and the exact Bedrock Converse payload built from it
      const everything = JSON.stringify([req, buildConverseInput("model-id", req)]);
      for (const [field, value] of Object.entries(FAKE)) expect(everything, field).not.toContain(value);
      expect(everything).not.toContain("masters"); // degree type
      expect(everything).not.toContain(studentId);
      expect(everything).not.toContain(counselorId);
    }
    // call 1 sees only utterances; call 2 sees only themes
    expect(Object.keys(JSON.parse(spy.requests[0].user))).toEqual(["utterances"]);
    expect(Object.keys(JSON.parse(spy.requests[1].user)).sort()).toEqual(["earlier_sessions", "this_session"]);
  });

  it("the Bedrock payload has only the prompt, the transcript text and the forced tool", () => {
    const input = buildConverseInput("us.example-model", {
      schemaName: "report_themes",
      system: "SYSTEM",
      user: '{"utterances":[]}',
      jsonSchema: { type: "object" },
      temperature: 0.1,
    });
    expect(Object.keys(input).sort()).toEqual(["inferenceConfig", "messages", "modelId", "system", "toolConfig"]);
    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: "report_themes" } });
    expect(input.inferenceConfig?.temperature).toBe(0.1);
  });
});

describe("privacy: logs", () => {
  const written: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    written.length = 0;
    const grab = (chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    };
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation(grab as never));
    spies.push(vi.spyOn(process.stderr, "write").mockImplementation(grab as never));
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(" "))));
    }
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("running the whole pipeline logs no names, quotes, notes or transcript text", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("03"));
    const utterances = loadFixture(fixtureNamed("03"));
    const out = await runAnalysisForSession(counselorId, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app });
    const captured = written.join("");
    spies.splice(0).forEach((s) => s.mockRestore());

    expect(out.status).toBe("complete");
    expect(captured).toContain("analysis_complete"); // events were logged, so this test is meaningful
    for (const value of Object.values(FAKE)) expect(captured).not.toContain(value);
    for (const u of utterances) {
      // no transcript line, and no 20-character slice of one, appears in the logs
      for (let i = 0; i + 20 <= u.text.length; i += 10) expect(captured).not.toContain(u.text.slice(i, i + 20));
    }
    for (const theme of (await db.admin.query("SELECT title, interpretation FROM themes")).rows) {
      expect(captured).not.toContain(theme.title);
      expect(captured).not.toContain(theme.interpretation);
    }
  });

  it("a failing model call logs an error code, never the error message", async () => {
    const sessionId = await addSession("2026-11-01", fixtureNamed("01"));
    const boom: LlmClient = {
      modelId: "mock",
      async completeJson() {
        throw new Error("secret detail: Back home I was an accountant");
      },
    };
    await runAnalysisForSession(counselorId, sessionId, { llm: boom, criteria, pool: db.app });
    const captured = written.join("");
    spies.splice(0).forEach((s) => s.mockRestore());
    expect(captured).toContain("analysis_failed");
    expect(captured).not.toContain("accountant");
    expect(captured).not.toContain("secret detail");
  });

  it("logEvent keeps ids, numbers and booleans and redacts anything that looks like text", () => {
    logEvent("test_event", {
      session_id: "3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c",
      count: 3,
      ok: true,
      name: FAKE.studentName,
      sentence: "I miss my mother's cooking so much.",
      long: "a".repeat(80),
    });
    const line = JSON.parse(written.join("").trim());
    spies.splice(0).forEach((s) => s.mockRestore());
    expect(line).toEqual({
      event: "test_event",
      session_id: "3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c",
      count: 3,
      ok: true,
      name: "[redacted]",
      sentence: "[redacted]",
      long: "[redacted]",
    });
  });
});
