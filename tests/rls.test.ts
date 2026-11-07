import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateCounselor, withCounselor } from "@/lib/db";
import { setupTestDb, type TestDb } from "./helpers/db";

// Requires the local database: npm run db:up
let db: TestDb;

interface Seed {
  counselor: string;
  student: string;
  session: string;
  utterance: string;
  run: string;
  theme: string;
  evidence: string;
  recommendation: string;
  audit: string;
}

/** Inserts one full chain of fake rows for a counselor, as the database owner. */
async function seedCounselor(tag: string): Promise<Seed> {
  const q = async (sql: string, params: unknown[] = []) => (await db.admin.query(sql, params)).rows[0].id as string;
  const counselor = await q(
    "INSERT INTO counselors (cognito_sub, email, display_name) VALUES ($1,$2,$3) RETURNING id",
    [`sub-${tag}`, `${tag}@example.test`, `Counselor ${tag}`],
  );
  const student = await q(
    `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin, notes)
     VALUES ($1,$2,'Stanford School of Law','masters','Fake Program','Fakeland','fake note') RETURNING id`,
    [counselor, `Fake Student ${tag}`],
  );
  const session = await q(
    `INSERT INTO sessions (student_id, counselor_id, session_date, source, status)
     VALUES ($1,$2,'2026-11-06','pasted','complete') RETURNING id`,
    [student, counselor],
  );
  const utterance = await q(
    "INSERT INTO utterances (session_id, idx, speaker, text) VALUES ($1,0,'student','fake words') RETURNING id",
    [session],
  );
  const run = await q(
    `INSERT INTO analysis_runs (session_id, model_id, prompt_version, criteria_version, status)
     VALUES ($1,'mock','1','1.0','complete') RETURNING id`,
    [session],
  );
  const theme = await q(
    `INSERT INTO themes (analysis_run_id, session_id, sub_driver_id, domain_id, title, interpretation)
     VALUES ($1,$2,'loneliness','emotional_burden','A theme','An interpretation') RETURNING id`,
    [run, session],
  );
  const evidence = await q(
    "INSERT INTO theme_evidence (theme_id, utterance_id, quote) VALUES ($1,$2,'fake words') RETURNING id",
    [theme, utterance],
  );
  const recommendation = await q(
    `INSERT INTO recommendations (analysis_run_id, session_id, topic, open_question, suggested_approach, based_on_theme_ids)
     VALUES ($1,$2,'t','q','a',ARRAY[$3::uuid]) RETURNING id`,
    [run, session, theme],
  );
  const audit = await q(
    "INSERT INTO audit_events (counselor_id, student_id, session_id, action) VALUES ($1,$2,$3,'view_session') RETURNING id",
    [counselor, student, session],
  );
  return { counselor, student, session, utterance, run, theme, evidence, recommendation, audit };
}

// table -> which Seed field holds that table's row id
const TABLES: Array<[string, keyof Seed]> = [
  ["counselors", "counselor"],
  ["students", "student"],
  ["sessions", "session"],
  ["utterances", "utterance"],
  ["analysis_runs", "run"],
  ["themes", "theme"],
  ["theme_evidence", "evidence"],
  ["recommendations", "recommendation"],
  ["audit_events", "audit"],
];

let A: Seed;
let B: Seed;

beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.reset();
  A = await seedCounselor("a");
  B = await seedCounselor("b");
});

describe("row-level security: counselor A cannot reach counselor B", () => {
  it("the app connects as a non-superuser that cannot bypass RLS", async () => {
    const { rows } = await db.app.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  for (const [table, field] of TABLES) {
    it(`${table}: A sees only A's row, never B's`, async () => {
      const ids = await withCounselor(
        A.counselor,
        async (c) => (await c.query(`SELECT id FROM ${table}`)).rows.map((r) => r.id),
        db.app,
      );
      expect(ids).toEqual([A[field]]);
      expect(ids).not.toContain(B[field]);
    });
  }

  it("A cannot fetch B's student, session or theme even by exact id", async () => {
    await withCounselor(
      A.counselor,
      async (c) => {
        for (const [table, id] of [
          ["students", B.student],
          ["sessions", B.session],
          ["themes", B.theme],
        ]) {
          const { rowCount } = await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
          expect(rowCount, table).toBe(0);
        }
      },
      db.app,
    );
  });

  it("with no counselor set, nothing is visible", async () => {
    for (const [table] of TABLES) {
      const { rowCount } = await db.app.query(`SELECT 1 FROM ${table}`);
      expect(rowCount, table).toBe(0);
    }
  });

  it("A cannot update or delete B's rows (they are invisible, so 0 rows change)", async () => {
    await withCounselor(
      A.counselor,
      async (c) => {
        const upd = await c.query("UPDATE students SET school = 'Hacked' WHERE id = $1", [B.student]);
        expect(upd.rowCount).toBe(0);
        const del = await c.query("DELETE FROM students WHERE id = $1", [B.student]);
        expect(del.rowCount).toBe(0);
      },
      db.app,
    );
    const { rows } = await db.admin.query("SELECT school FROM students WHERE id = $1", [B.student]);
    expect(rows).toEqual([{ school: "Stanford School of Law" }]);
  });

  it("A cannot insert rows that belong to B", async () => {
    const attempt = (fn: (c: import("pg").PoolClient) => Promise<unknown>) =>
      withCounselor(A.counselor, fn, db.app);

    // A student owned by B
    await expect(
      attempt((c) =>
        c.query(
          `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin)
           VALUES ($1,'x','Stanford School of Law','masters','x','x')`,
          [B.counselor],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // A session of A's own, but attached to B's student
    await expect(
      attempt((c) =>
        c.query(
          `INSERT INTO sessions (student_id, counselor_id, session_date, source)
           VALUES ($1,$2,'2026-11-06','pasted')`,
          [B.student, A.counselor],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // An utterance inside B's session
    await expect(
      attempt((c) =>
        c.query("INSERT INTO utterances (session_id, idx, speaker, text) VALUES ($1,99,'student','x')", [B.session]),
      ),
    ).rejects.toThrow(/row-level security/);

    // A theme inside B's session
    await expect(
      attempt((c) =>
        c.query(
          `INSERT INTO themes (analysis_run_id, session_id, sub_driver_id, domain_id, title, interpretation)
           VALUES ($1,$2,'loneliness','emotional_burden','x','x')`,
          [B.run, B.session],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("A can create and read their own data", async () => {
    const id = await withCounselor(
      A.counselor,
      async (c) =>
        (
          await c.query(
            `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin)
             VALUES ($1,'New Fake','Stanford School of Law','bachelors','Fake Program','Fakeland') RETURNING id`,
            [A.counselor],
          )
        ).rows[0].id as string,
      db.app,
    );
    const names = await withCounselor(
      A.counselor,
      async (c) => (await c.query("SELECT full_name FROM students ORDER BY full_name")).rows.map((r) => r.full_name),
      db.app,
    );
    expect(names).toEqual(["Fake Student a", "New Fake"]);
    expect(id).toBeTruthy();
  });

  it("the setting does not leak between requests on a reused connection", async () => {
    await withCounselor(A.counselor, async (c) => void (await c.query("SELECT 1")), db.app);
    const { rowCount } = await db.app.query("SELECT 1 FROM students");
    expect(rowCount).toBe(0);
  });
});

describe("first sign-in", () => {
  it("creates the counselor row once and returns the same id next time", async () => {
    const first = await findOrCreateCounselor("sub-new", "new@example.test", "New Counselor", db.app);
    const second = await findOrCreateCounselor("sub-new", "new@example.test", "New Counselor", db.app);
    expect(second).toBe(first);
    const { rows } = await db.admin.query("SELECT count(*)::int AS n FROM counselors WHERE cognito_sub = 'sub-new'");
    expect(rows[0].n).toBe(1);
  });

  it("the app role cannot create counselors directly", async () => {
    await expect(
      db.app.query("INSERT INTO counselors (cognito_sub, email, display_name) VALUES ('x','x@x.test','x')"),
    ).rejects.toThrow(/permission denied/);
  });
});
