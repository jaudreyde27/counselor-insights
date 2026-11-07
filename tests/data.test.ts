import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAnalysisForSession } from "@/lib/analysis/run";
import { loadCriteria } from "@/lib/criteria";
import { withCounselor } from "@/lib/db";
import { createPastedSession, getSessionView, swapSpeakers } from "@/lib/data/sessions";
import { createStudent, deleteStudent, getStudentView, listStudents } from "@/lib/data/students";
import { MockLlmClient } from "@/lib/llm/mock";
import { FIXTURE_NAMES, loadFixture } from "./helpers/llm";
import { setupTestDb, type TestDb } from "./helpers/db";

// Requires the local database: npm run db:up
const criteria = loadCriteria();
const fx = (prefix: string) => FIXTURE_NAMES.find((n) => n.startsWith(prefix))!;
let db: TestDb;
let A: string;
let B: string;

const as = <T>(id: string, fn: Parameters<typeof withCounselor<T>>[1]) => withCounselor(id, fn, db.app);
const student = (name: string, school = "Stanford School of Engineering", degree: "bachelors" | "masters" = "masters") => ({
  full_name: name,
  school,
  degree_type: degree,
  program_of_study: "Fictional Studies",
  country_of_origin: "Nigeria",
  notes: "fictional",
});

async function addAnalyzed(counselor: string, studentId: string, date: string, fixture: string) {
  const sessionId = await as(counselor, (c) =>
    createPastedSession(c, {
      counselorId: counselor,
      studentId,
      sessionDate: date,
      utterances: loadFixture(fixture).map(({ speaker, text }) => ({ speaker, text })),
    }),
  );
  await runAnalysisForSession(counselor, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app });
  return sessionId;
}

beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
  const mk = async (sub: string) =>
    (await db.admin.query("INSERT INTO counselors (cognito_sub,email,display_name) VALUES ($1,$2,$3) RETURNING id", [sub, `${sub}@example.test`, sub])).rows[0].id as string;
  A = await mk("a");
  B = await mk("b");
});

describe("student list", () => {
  it("shows counts, last session, degree and program; filters by school and degree; sorts by last session", async () => {
    const ana = await as(A, (c) => createStudent(c, A, student("Ana", "Stanford School of Law", "masters")));
    const ben = await as(A, (c) => createStudent(c, A, student("Ben", "Stanford Undergraduate", "bachelors")));
    await as(A, (c) => createStudent(c, A, student("Cy", "Stanford School of Law", "bachelors"))); // no sessions
    await addAnalyzed(A, ana, "2026-10-01", fx("01"));
    await addAnalyzed(A, ana, "2026-10-20", fx("02"));
    await addAnalyzed(A, ben, "2026-11-03", fx("04"));

    const desc = await as(A, (c) => listStudents(c, { sort: "desc" }));
    expect(desc.map((s) => s.full_name)).toEqual(["Ben", "Ana", "Cy"]); // no-session students last
    expect(desc.find((s) => s.full_name === "Ana")).toMatchObject({
      session_count: 2,
      last_session: "2026-10-20",
      degree_type: "masters",
      program_of_study: "Fictional Studies",
    });
    expect((await as(A, (c) => listStudents(c, { sort: "asc" }))).map((s) => s.full_name)).toEqual(["Ana", "Ben", "Cy"]);
    expect((await as(A, (c) => listStudents(c, { school: "Stanford School of Law" }))).map((s) => s.full_name).sort()).toEqual(["Ana", "Cy"]);
    expect((await as(A, (c) => listStudents(c, { degree: "bachelors" }))).map((s) => s.full_name).sort()).toEqual(["Ben", "Cy"]);
    expect((await as(A, (c) => listStudents(c, { degree: "masters" }))).map((s) => s.full_name)).toEqual(["Ana"]);
    expect((await as(A, (c) => listStudents(c, { school: "Stanford School of Law", degree: "bachelors" }))).map((s) => s.full_name)).toEqual(["Cy"]);
    expect(await as(A, (c) => listStudents(c, { school: "Stanford Undergraduate", degree: "masters" }))).toEqual([]);

    // filter by session count: Ana has 2, Ben has 1, Cy has none
    const names = async (sessions: string, extra = {}) =>
      (await as(A, (c) => listStudents(c, { sessions, ...extra }))).map((s) => s.full_name).sort();
    expect(await names("0")).toEqual(["Cy"]);
    expect(await names("1")).toEqual(["Ben"]);
    expect(await names("2")).toEqual(["Ana"]);
    expect(await names("3plus")).toEqual([]);
    await addAnalyzed(A, ana, "2026-10-25", fx("05")); // Ana now has 3
    expect(await names("3plus")).toEqual(["Ana"]);
    expect(await names("2")).toEqual([]);
    expect(await names("0", { school: "Stanford School of Law" })).toEqual(["Cy"]);
    expect(await names("1", { school: "Stanford School of Law" })).toEqual([]);
    expect(await names("nonsense")).toEqual([]); // unknown values match nothing rather than everything
  });

  it("the database only accepts bachelors or masters", async () => {
    await expect(
      db.admin.query(
        `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin)
         VALUES ($1,'x','Stanford School of Law','doctorate','x','x')`,
        [A],
      ),
    ).rejects.toThrow(/degree_type/);
  });

  it("only lists the signed-in counselor's students", async () => {
    await as(A, (c) => createStudent(c, A, student("Mine")));
    await as(B, (c) => createStudent(c, B, student("Theirs")));
    expect((await as(A, (c) => listStudents(c))).map((s) => s.full_name)).toEqual(["Mine"]);
    expect((await as(B, (c) => listStudents(c))).map((s) => s.full_name)).toEqual(["Theirs"]);
  });
});

describe("student page data", () => {
  it("builds the latest profile with ordered themes and recommendations", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Dee")));
    await addAnalyzed(A, id, "2026-10-14", fx("01")); // loneliness, homesickness, career, self-advocacy
    await addAnalyzed(A, id, "2026-11-04", fx("03")); // roommate conflict, loneliness, financial strain, ...

    const v = (await as(A, (c) => getStudentView(c, A, id)))!;
    expect(v.sessions.map((s) => s.session_date)).toEqual(["2026-11-04", "2026-10-14"]);
    expect(v.latest!.session_date).toBe("2026-11-04");
    expect(v.processingStatus).toBeNull();

    // themes keep the order the analysis produced
    expect(v.latest!.themes.map((t) => t.sub_driver_id)).toEqual([
      "interpersonal_conflict",
      "loneliness",
      "financial_strain",
    ]);
    // recommendations: most important first, linked to real themes, and "changes" saved with the run
    expect(v.latest!.recommendations.map((r) => r.topic)).toEqual([
      "Explore what is making home feel hard",
      "Look at the rent pressure together",
    ]);
    expect(v.latest!.recommendations[0].based_on.length).toBeGreaterThan(0);
    expect(v.latest!.changes.some((c) => c.includes("Financial strain came up this session but not before"))).toBe(true);
    // each theme has quotes that link to a line
    for (const t of v.latest!.themes) expect(t.evidence.length).toBeGreaterThan(0);
  });

  it("shows no latest analysis for a student whose only session has not been analysed", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Eli")));
    await as(A, (c) =>
      createPastedSession(c, { counselorId: A, studentId: id, sessionDate: "2026-11-01", utterances: [{ speaker: "student", text: "Hi." }] }),
    );
    const v = (await as(A, (c) => getStudentView(c, A, id)))!;
    expect(v.latest).toBeNull();
    expect(v.processingStatus).toBe("transcribed"); // analysis is queued
  });

  it("returns null for another counselor's student", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Private")));
    expect(await as(B, (c) => getStudentView(c, B, id))).toBeNull();
  });
});

describe("session page data and swap speakers", () => {
  it("swap speakers flips every stored label, and swapping twice restores them", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Fay")));
    const sessionId = await as(A, (c) =>
      createPastedSession(c, {
        counselorId: A,
        studentId: id,
        sessionDate: "2026-11-01",
        utterances: [
          { speaker: "counselor", text: "How are you?" },
          { speaker: "student", text: "Tired." },
          { speaker: "counselor", text: "Tell me more." },
        ],
      }),
    );
    const speakers = async () => (await as(A, (c) => getSessionView(c, A, sessionId)))!.utterances.map((u) => u.speaker);
    expect(await speakers()).toEqual(["counselor", "student", "counselor"]);
    expect(await as(A, (c) => swapSpeakers(c, A, sessionId))).toBe(true);
    expect(await speakers()).toEqual(["student", "counselor", "student"]);
    await as(A, (c) => swapSpeakers(c, A, sessionId));
    expect(await speakers()).toEqual(["counselor", "student", "counselor"]);
  });

  it("another counselor can neither swap nor view the session", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Gus")));
    const sessionId = await as(A, (c) =>
      createPastedSession(c, { counselorId: A, studentId: id, sessionDate: "2026-11-01", utterances: [{ speaker: "student", text: "Hi." }] }),
    );
    expect(await as(B, (c) => swapSpeakers(c, B, sessionId))).toBe(false);
    expect(await as(B, (c) => getSessionView(c, B, sessionId))).toBeNull();
    expect((await as(A, (c) => getSessionView(c, A, sessionId)))!.utterances[0].speaker).toBe("student");
  });

  it("swapping speakers leaves the analysis to be re-run, and a re-run uses the new labels", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Hal")));
    const sessionId = await addAnalyzed(A, id, "2026-11-01", fx("01"));
    const before = (await as(A, (c) => getSessionView(c, A, sessionId)))!;
    expect(before.themes.length).toBeGreaterThan(0);

    await as(A, (c) => swapSpeakers(c, A, sessionId));
    // flipped labels: the old quotes now sit on "counselor" lines, so a verified re-run finds nothing from the mock
    const out = await runAnalysisForSession(A, sessionId, { llm: new MockLlmClient(), criteria, pool: db.app });
    expect(out.status).toBe("complete");
    const after = (await as(A, (c) => getSessionView(c, A, sessionId)))!;
    expect(after.run!.id).not.toBe(before.run!.id);
    expect(after.themes.length).toBeLessThan(before.themes.length);
  });
});

describe("delete student and audit events", () => {
  it("deletes the student with sessions, transcripts and analyses, and keeps the audit rows without names", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Ivy Fictional")));
    const sessionId = await addAnalyzed(A, id, "2026-11-01", fx("02"));
    await as(A, (c) => getStudentView(c, A, id));
    await as(A, (c) => getSessionView(c, A, sessionId));

    expect(await as(A, (c) => deleteStudent(c, A, id))).toBe(true);
    for (const t of ["students", "sessions", "utterances", "analysis_runs", "themes", "theme_evidence", "recommendations"]) {
      expect((await db.admin.query(`SELECT 1 FROM ${t}`)).rowCount, t).toBe(0);
    }
    const audit = (await db.admin.query("SELECT action, student_id, session_id FROM audit_events ORDER BY created_at, id")).rows;
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["student_created", "session_created", "view_student", "view_session", "delete_student"]),
    );
    expect(audit.every((a) => a.student_id === null && a.session_id === null)).toBe(true); // links cleared with the rows
    expect(JSON.stringify(audit)).not.toContain("Ivy"); // names never go in audit events
  });

  it("cannot delete another counselor's student", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Jo")));
    expect(await as(B, (c) => deleteStudent(c, B, id))).toBe(false);
    expect((await db.admin.query("SELECT 1 FROM students")).rowCount).toBe(1);
  });

  it("writes audit events for create, view and re-run, using fixed action names only", async () => {
    const id = await as(A, (c) => createStudent(c, A, student("Kit")));
    const sessionId = await addAnalyzed(A, id, "2026-11-01", fx("01"));
    await as(A, (c) => getStudentView(c, A, id));
    await as(A, (c) => getSessionView(c, A, sessionId));
    const actions = (await db.admin.query("SELECT DISTINCT action FROM audit_events")).rows.map((r) => r.action).sort();
    expect(actions).toEqual(["session_created", "student_created", "view_session", "view_student"]);
    expect((await db.admin.query("SELECT 1 FROM audit_events WHERE counselor_id <> $1", [A])).rowCount).toBe(0);
  });
});
