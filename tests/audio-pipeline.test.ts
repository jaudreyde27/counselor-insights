import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysisForSession } from "@/lib/analysis/run";
import { loadCriteria } from "@/lib/criteria";
import { withCounselor } from "@/lib/db";
import { expireStaleSessions } from "@/lib/data/maintenance";
import { audioKeysForStudent, createAudioSession, getSessionView, swapSpeakers } from "@/lib/data/sessions";
import { MockLlmClient } from "@/lib/llm/mock";
import { LocalAudioStorage } from "@/lib/storage";
import { MockTranscriptionClient } from "@/lib/transcription/mock";
import { finishTranscription, startTranscription, type AudioDeps } from "@/lib/transcription/process";
import type { TranscriptionClient } from "@/lib/transcription/types";
import { WEBHOOK_HEADER_NAME } from "@/lib/transcription/types";
import { findSessionForTranscript, handleTranscriptionWebhook, secretsMatch } from "@/lib/transcription/webhook";
import { FIXTURE_NAMES, loadFixture } from "./helpers/llm";
import { setupTestDb, type TestDb } from "./helpers/db";

// Requires the local database: npm run db:up
const criteria = loadCriteria();
const SECRET = "webhook-secret-for-tests-0123456789";
const STORAGE_SECRET = "storage-secret-for-tests-0123456789";
const fx = (prefix: string) => FIXTURE_NAMES.find((n) => n.startsWith(prefix))!;

let db: TestDb;
let dir: string;
let storage: LocalAudioStorage;
let mock: MockTranscriptionClient;
let A: string;
let B: string;
let studentId: string;
let analyzed: string[]; // sessions the analysis was started for
let pending: Array<Promise<unknown>>; // work the webhook scheduled "after" its reply

function deps(over: Partial<AudioDeps> = {}): AudioDeps {
  return {
    storage,
    transcription: mock,
    webhookSecret: SECRET,
    baseUrl: "http://localhost:3000",
    pool: db.app,
    analyze: async (cid, sid) => {
      analyzed.push(sid);
      await runAnalysisForSession(cid, sid, { llm: new MockLlmClient(), criteria, pool: db.app });
    },
    ...over,
  };
}
const schedule = (work: () => Promise<unknown>) => void pending.push(work());
const hook = (body: unknown, headers: Record<string, string> = { [WEBHOOK_HEADER_NAME]: SECRET }) =>
  new Request("http://localhost:3000/api/webhooks/assemblyai", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A recording for a student, already "uploaded" to the local storage, carrying a fixture marker. */
async function uploadedSession(counselor = A, student = studentId, marker = "fixture-03") {
  const made = await withCounselor(
    counselor,
    (c) => createAudioSession(c, { counselorId: counselor, studentId: student, sessionDate: "2026-11-01", ext: "wav" }),
    db.app,
  );
  await storage.put(made.key, Buffer.from(`RIFF....WAVE ${marker}`));
  return made;
}
const sessionRow = async (id: string) =>
  (await db.admin.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
  dir = await mkdtemp(path.join(tmpdir(), "audio-pipeline-"));
  storage = new LocalAudioStorage(dir, STORAGE_SECRET, "http://localhost:3000");
  mock = new MockTranscriptionClient(storage, { delayMs: 0, autoWebhook: false });
  analyzed = [];
  pending = [];
  const mk = async (sub: string) =>
    (await db.admin.query("INSERT INTO counselors (cognito_sub,email,display_name) VALUES ($1,$2,$3) RETURNING id", [sub, `${sub}@example.test`, sub])).rows[0].id as string;
  A = await mk("a");
  B = await mk("b");
  studentId = (
    await db.admin.query(
      `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin)
       VALUES ($1,'Fictional Student','Stanford School of Law','masters','Fictional Studies','Fakeland') RETURNING id`,
      [A],
    )
  ).rows[0].id;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("creating an audio session", () => {
  it("starts as awaiting_upload with consent saved with a timestamp and a key made only from the session id", async () => {
    const { sessionId, key } = await withCounselor(A, (c) => createAudioSession(c, { counselorId: A, studentId, sessionDate: "2026-11-01", ext: "m4a" }), db.app);
    const s = await sessionRow(sessionId);
    expect(s).toMatchObject({ status: "awaiting_upload", source: "audio", audio_s3_key: key, student_speaker_label: null, assemblyai_transcript_id: null });
    expect(key).toBe(`audio/${sessionId}.m4a`);
    expect(Date.now() - new Date(s.consent_confirmed_at).getTime()).toBeLessThan(60_000);
    expect((await db.admin.query("SELECT 1 FROM audit_events WHERE session_id = $1 AND action = 'session_created'", [sessionId])).rowCount).toBe(1);
  });

  it("collects a student's recording keys so they can be deleted with the student", async () => {
    const a = await uploadedSession();
    const b = await uploadedSession();
    const keys = await withCounselor(A, (c) => audioKeysForStudent(c, studentId), db.app);
    expect(keys.sort()).toEqual([a.key, b.key].sort());
  });
});

describe("upload-complete: starting the transcription", () => {
  it("checks the file exists, then moves uploaded -> transcribing and saves the transcript id", async () => {
    const { sessionId } = await uploadedSession();
    expect(await startTranscription(A, sessionId, deps())).toBe("transcribing");
    const s = await sessionRow(sessionId);
    expect(s.status).toBe("transcribing");
    expect(s.assemblyai_transcript_id).toMatch(/^mock-/);
    expect(s.error_message).toBeNull();
  });

  it("marks the session failed if the file never reached storage", async () => {
    const made = await withCounselor(A, (c) => createAudioSession(c, { counselorId: A, studentId, sessionDate: "2026-11-01", ext: "wav" }), db.app);
    expect(await startTranscription(A, made.sessionId, deps())).toBe("failed");
    const s = await sessionRow(made.sessionId);
    expect(s.status).toBe("failed");
    expect(s.error_message).toBe("The upload did not finish. Please add the session again.");
  });

  it("marks the session failed, with a plain message, if the transcription service refuses", async () => {
    const { sessionId } = await uploadedSession();
    const broken: TranscriptionClient = { ...mock, createJob: async () => { throw new Error("secret detail: Back home I was an accountant"); } } as never;
    expect(await startTranscription(A, sessionId, deps({ transcription: broken }))).toBe("failed");
    const s = await sessionRow(sessionId);
    expect(s.status).toBe("failed");
    expect(s.error_message).toContain('Press "Re-run analysis"');
    expect(s.error_message).not.toContain("accountant");
  });

  it("can be retried from failed, and ignores a session that is already past that stage", async () => {
    const { sessionId } = await uploadedSession();
    const broken = { ...mock, createJob: async () => { throw new Error("down"); } } as never;
    await startTranscription(A, sessionId, deps({ transcription: broken }));
    expect((await sessionRow(sessionId)).status).toBe("failed");
    expect(await startTranscription(A, sessionId, deps())).toBe("transcribing"); // the service is back
    expect(await startTranscription(A, sessionId, deps())).toBe("ignored"); // already transcribing
  });

  it("another counselor cannot start transcription on this counselor's session", async () => {
    const { sessionId } = await uploadedSession();
    expect(await startTranscription(B, sessionId, deps())).toBe("ignored");
    expect((await sessionRow(sessionId)).status).toBe("awaiting_upload");
  });
});

describe("the webhook", () => {
  it("rejects a missing secret header, a wrong one, and a near-miss, and does no work", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const id = (await sessionRow(sessionId)).assemblyai_transcript_id;

    const badHeaders: Array<Record<string, string>> = [{}, { [WEBHOOK_HEADER_NAME]: "wrong" }, { [WEBHOOK_HEADER_NAME]: SECRET + "x" }, { [WEBHOOK_HEADER_NAME]: SECRET.slice(0, -1) }, { [WEBHOOK_HEADER_NAME]: "" }, { "x-other-header": SECRET }];
    for (const headers of badHeaders) {
      const res = await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }, headers), deps(), schedule);
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(pending).toHaveLength(0);
    expect((await sessionRow(sessionId)).status).toBe("transcribing"); // untouched
  });

  it("never accepts a call when no secret is configured", async () => {
    const res = await handleTranscriptionWebhook(hook({ transcript_id: "x", status: "completed" }, { [WEBHOOK_HEADER_NAME]: "" }), deps({ webhookSecret: "" }), schedule);
    expect(res.status).toBe(500);
    expect(pending).toHaveLength(0);
  });

  it("compares secrets exactly", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET + " ", SECRET)).toBe(false);
    expect(secretsMatch(null, SECRET)).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch(SECRET, "")).toBe(false);
  });

  it("answers 400 to a bad body and 200 (with nothing to do) to an unknown transcript", async () => {
    expect((await handleTranscriptionWebhook(hook("not json"), deps(), schedule)).status).toBe(400);
    expect((await handleTranscriptionWebhook(hook({ status: "completed" }), deps(), schedule)).status).toBe(400);
    expect((await handleTranscriptionWebhook(hook({ transcript_id: "tr_unknown", status: "completed" }), deps(), schedule)).status).toBe(200);
    expect(pending).toHaveLength(0);
  });

  it("looks up the owner with the narrow database function", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const id = (await sessionRow(sessionId)).assemblyai_transcript_id;
    expect(await findSessionForTranscript(id, db.app)).toEqual({ sessionId, counselorId: A });
    expect(await findSessionForTranscript("nope", db.app)).toBeNull();
  });

  it("replies at once and does the work afterwards: transcript saved, speakers mapped, analysis started", async () => {
    const { sessionId } = await uploadedSession(A, studentId, "fixture-03");
    await startTranscription(A, sessionId, deps());
    const id = (await sessionRow(sessionId)).assemblyai_transcript_id;

    const res = await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }), deps(), schedule);
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1); // the work was handed off, not done inline
    await Promise.all(pending);

    const s = await sessionRow(sessionId);
    expect(s).toMatchObject({ status: "complete", student_speaker_label: "B", error_message: null });
    const u = (await db.admin.query("SELECT idx, speaker, raw_speaker_label, start_ms, end_ms, text FROM utterances WHERE session_id = $1 ORDER BY idx", [sessionId])).rows;
    const expected = loadFixture(fx("03"));
    expect(u.map((r) => r.text)).toEqual(expected.map((e) => e.text));
    expect(u.map((r) => r.speaker)).toEqual(expected.map((e) => e.speaker));
    expect(u[0]).toMatchObject({ raw_speaker_label: "A", start_ms: 0, end_ms: 5500 });
    expect(u[1].raw_speaker_label).toBe("B");
    expect(analyzed).toEqual([sessionId]);
    expect((await db.admin.query("SELECT 1 FROM themes WHERE session_id = $1", [sessionId])).rowCount).toBe(3); // the mocked Bedrock ran
    expect(await mock.getTranscript(id)).toEqual({ status: "error" }); // our copy at the provider was deleted
  });

  it("is safe to call twice: the second call finds nothing to do", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const id = (await sessionRow(sessionId)).assemblyai_transcript_id;
    await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }), deps(), schedule);
    await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }), deps(), schedule);
    await Promise.all(pending);
    expect(analyzed).toHaveLength(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM utterances WHERE session_id = $1", [sessionId])).rows[0].n).toBe(loadFixture(fx("03")).length);
  });
});

describe("Check status (when the webhook never arrives)", () => {
  it("reports pending while the transcript is not ready, then saves it when it is", async () => {
    const slow = new MockTranscriptionClient(storage, { delayMs: 150, autoWebhook: false });
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps({ transcription: slow }));
    expect(await finishTranscription(A, sessionId, deps({ transcription: slow }))).toBe("pending");
    expect((await sessionRow(sessionId)).status).toBe("transcribing");

    await new Promise((r) => setTimeout(r, 200));
    expect(await finishTranscription(A, sessionId, deps({ transcription: slow }))).toBe("saved");
    expect((await sessionRow(sessionId)).status).toBe("complete");
    expect(await finishTranscription(A, sessionId, deps({ transcription: slow }))).toBe("ignored"); // nothing left to fetch
  });

  it("only the owner can check: another counselor gets nothing", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    expect(await finishTranscription(B, sessionId, deps())).toBe("ignored");
    expect((await sessionRow(sessionId)).status).toBe("transcribing");
  });

  it("a provider error fails the session with a plain message; a service outage just stays pending", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const down = { ...mock, getTranscript: async () => { throw new Error("503"); } } as never;
    expect(await finishTranscription(A, sessionId, deps({ transcription: down }))).toBe("pending");
    expect((await sessionRow(sessionId)).status).toBe("transcribing");

    const erroring = { ...mock, getTranscript: async () => ({ status: "error" }) } as never;
    expect(await finishTranscription(A, sessionId, deps({ transcription: erroring }))).toBe("failed");
    const s = await sessionRow(sessionId);
    expect(s.status).toBe("failed");
    expect(s.error_message).toBe('Transcription failed. Press "Re-run analysis" to try again.');
  });

  it("a recording with no speech fails the session instead of analysing nothing", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const silent = { ...mock, getTranscript: async () => ({ status: "completed", utterances: [{ speaker: "A", text: "   " }] }) } as never;
    expect(await finishTranscription(A, sessionId, deps({ transcription: silent }))).toBe("failed");
    expect((await sessionRow(sessionId)).error_message).toBe("The recording had no speech that could be transcribed.");
    expect(analyzed).toHaveLength(0);
  });
});

describe("swap speakers on a transcribed recording", () => {
  it("flips every stored line AND which service label (A/B) is the student, and flipping twice restores both", async () => {
    const { sessionId } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    await finishTranscription(A, sessionId, deps({ analyze: async () => undefined }));
    const labels = async () => (await sessionRow(sessionId)).student_speaker_label;
    const speakers = async () => (await withCounselor(A, (c) => getSessionView(c, A, sessionId), db.app))!.utterances.map((u) => u.speaker);

    const before = await speakers();
    expect(await labels()).toBe("B");
    await withCounselor(A, (c) => swapSpeakers(c, A, sessionId), db.app);
    expect(await speakers()).toEqual(before.map((s) => (s === "student" ? "counselor" : "student")));
    expect(await labels()).toBe("A");
    await withCounselor(A, (c) => swapSpeakers(c, A, sessionId), db.app);
    expect(await speakers()).toEqual(before);
    expect(await labels()).toBe("B");
  });
});

describe("stale sessions are closed out", () => {
  const age = (id: string, minutes: number) =>
    db.admin.query("UPDATE sessions SET created_at = now() - make_interval(mins => $2) WHERE id = $1", [id, minutes]);
  const setStatus = (id: string, status: string) => db.admin.query("UPDATE sessions SET status = $2 WHERE id = $1", [id, status]);

  it("an upload still waiting after 30 minutes is failed; a recent one and a transcribing one are left alone", async () => {
    const old = await withCounselor(A, (c) => createAudioSession(c, { counselorId: A, studentId, sessionDate: "2026-11-01", ext: "wav" }), db.app);
    const recent = await withCounselor(A, (c) => createAudioSession(c, { counselorId: A, studentId, sessionDate: "2026-11-01", ext: "wav" }), db.app);
    const transcribing = await uploadedSession();
    await startTranscription(A, transcribing.sessionId, deps());
    await age(old.sessionId, 31);
    await age(recent.sessionId, 5);
    await age(transcribing.sessionId, 600);

    await withCounselor(A, (c) => expireStaleSessions(c), db.app);
    expect(await sessionRow(old.sessionId)).toMatchObject({ status: "failed", error_message: "The upload was not completed. Please add the session again." });
    expect((await sessionRow(recent.sessionId)).status).toBe("awaiting_upload");
    expect((await sessionRow(transcribing.sessionId)).status).toBe("transcribing"); // "Check status" can still fetch it
  });

  it("an analysis with no sign of life for 15 minutes is failed (a restart mid-run), a fresh one is not", async () => {
    const stuck = await uploadedSession();
    const fresh = await uploadedSession();
    for (const s of [stuck, fresh]) await setStatus(s.sessionId, "analyzing");
    await db.admin.query("INSERT INTO analysis_runs (session_id, model_id, prompt_version, criteria_version, status, created_at) VALUES ($1,'mock','v3','1.1','running', now() - interval '20 minutes')", [stuck.sessionId]);
    await db.admin.query("INSERT INTO analysis_runs (session_id, model_id, prompt_version, criteria_version, status) VALUES ($1,'mock','v3','1.1','running')", [fresh.sessionId]);

    await withCounselor(A, (c) => expireStaleSessions(c), db.app);
    expect(await sessionRow(stuck.sessionId)).toMatchObject({ status: "failed", error_message: 'The analysis was interrupted. Press "Re-run analysis" to try again.' });
    expect((await sessionRow(fresh.sessionId)).status).toBe("analyzing");
    expect((await db.admin.query("SELECT status FROM analysis_runs WHERE session_id = $1", [stuck.sessionId])).rows[0].status).toBe("failed");
  });

  it("only touches the signed-in counselor's own sessions", async () => {
    const mine = await withCounselor(A, (c) => createAudioSession(c, { counselorId: A, studentId, sessionDate: "2026-11-01", ext: "wav" }), db.app);
    await age(mine.sessionId, 60);
    await withCounselor(B, (c) => expireStaleSessions(c), db.app);
    expect((await sessionRow(mine.sessionId)).status).toBe("awaiting_upload");
  });
});

describe("privacy: the audio pipeline logs no transcript text, names or secrets", () => {
  const written: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    written.length = 0;
    const grab = (chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    };
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation(grab as never), vi.spyOn(process.stderr, "write").mockImplementation(grab as never));
    for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(" "))));
  });
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it("upload, webhook (including a rejected one) and analysis log only ids, counts and event names", async () => {
    const { sessionId, key } = await uploadedSession();
    await startTranscription(A, sessionId, deps());
    const id = (await sessionRow(sessionId)).assemblyai_transcript_id;
    await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }, { [WEBHOOK_HEADER_NAME]: "wrong-secret-value" }), deps(), schedule);
    await handleTranscriptionWebhook(hook({ transcript_id: id, status: "completed" }), deps(), schedule);
    await Promise.all(pending);
    const captured = written.join("");
    spies.splice(0).forEach((s) => s.mockRestore());

    for (const event of ["transcription_started", "webhook_rejected", "transcript_saved", "webhook_processed"]) expect(captured).toContain(event);
    for (const secret of [SECRET, STORAGE_SECRET, "wrong-secret-value", key, "Fictional Student", "Fakeland"]) expect(captured).not.toContain(secret);
    for (const u of loadFixture(fx("03"))) for (let i = 0; i + 20 <= u.text.length; i += 10) expect(captured).not.toContain(u.text.slice(i, i + 20));
  });
});
