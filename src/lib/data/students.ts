import type { PoolClient } from "pg";
import type { DegreeType } from "../student-options";
import { audit } from "./audit";
import { expireStaleSessions } from "./maintenance";

export interface StudentInput {
  full_name: string;
  school: string;
  degree_type: DegreeType;
  program_of_study: string;
  country_of_origin: string;
  notes: string;
}

export async function createStudent(client: PoolClient, counselorId: string, s: StudentInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO students (counselor_id, full_name, school, degree_type, program_of_study, country_of_origin, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [counselorId, s.full_name, s.school, s.degree_type, s.program_of_study, s.country_of_origin, s.notes],
  );
  await audit(client, counselorId, "student_created", { studentId: rows[0].id });
  return rows[0].id;
}

/** Deletes a student and, by cascade, their sessions, transcripts and analyses. The audit row is kept. */
export async function deleteStudent(client: PoolClient, counselorId: string, studentId: string): Promise<boolean> {
  const res = await client.query("DELETE FROM students WHERE id = $1", [studentId]);
  if (res.rowCount === 0) return false;
  await audit(client, counselorId, "delete_student"); // ids are gone with the student; no names are recorded
  return true;
}

// ---------------------------------------------------------------- student list

export interface StudentRow {
  id: string;
  full_name: string;
  school: string;
  degree_type: DegreeType;
  program_of_study: string;
  country_of_origin: string;
  session_count: number;
  last_session: string | null;
}

export async function listStudents(
  client: PoolClient,
  opts: { school?: string; degree?: string; sessions?: string; sort?: "asc" | "desc" } = {},
): Promise<StudentRow[]> {
  const dir = opts.sort === "asc" ? "ASC" : "DESC";
  const { rows } = await client.query<StudentRow>(
    `SELECT * FROM (
       SELECT st.id, st.full_name, st.school, st.degree_type, st.program_of_study, st.country_of_origin,
              (SELECT count(*)::int FROM sessions s WHERE s.student_id = st.id) AS session_count,
              (SELECT to_char(max(s.session_date),'YYYY-MM-DD') FROM sessions s WHERE s.student_id = st.id) AS last_session
         FROM students st
        WHERE ($1::text IS NULL OR st.school = $1) AND ($2::text IS NULL OR st.degree_type = $2)
     ) t
      WHERE $3::text IS NULL
         OR ($3 = '0' AND t.session_count = 0)
         OR ($3 = '1' AND t.session_count = 1)
         OR ($3 = '2' AND t.session_count = 2)
         OR ($3 = '3plus' AND t.session_count >= 3)
      ORDER BY t.last_session ${dir} NULLS LAST, t.full_name`,
    [opts.school || null, opts.degree || null, opts.sessions || null],
  );
  return rows;
}

// ---------------------------------------------------------------- student page

export interface ThemeView {
  id: string;
  sub_driver_id: string;
  domain_id: string;
  other_label: string | null;
  title: string;
  interpretation: string;
  evidence: Array<{ quote: string; utterance_idx: number }>;
}

export interface RecommendationView {
  id: string;
  topic: string;
  open_question: string;
  suggested_approach: string;
  based_on: Array<{ sub_driver_id: string; other_label: string | null }>;
}

export interface StudentView {
  student: {
    id: string;
    full_name: string;
    school: string;
    degree_type: DegreeType;
    program_of_study: string;
    country_of_origin: string;
    notes: string;
    session_count: number;
    last_session: string | null;
  };
  sessions: Array<{ id: string; session_date: string; source: "audio" | "pasted"; status: string }>;
  /** Most recent session that has an analysis. */
  latest: null | {
    session_id: string;
    session_date: string;
    themes: ThemeView[];
    recommendations: RecommendationView[];
    changes: string[];
  };
  /** Status of a session that is still being processed (drives the banner text), or null. */
  processingStatus: string | null;
}

const PROCESSING = ["created", "awaiting_upload", "uploaded", "transcribing", "transcribed", "analyzing"];

export async function getStudentView(client: PoolClient, counselorId: string, studentId: string): Promise<StudentView | null> {
  await expireStaleSessions(client);
  const st = await client.query(
    `SELECT st.id, st.full_name, st.school, st.degree_type, st.program_of_study, st.country_of_origin, st.notes,
            (SELECT count(*)::int FROM sessions s WHERE s.student_id = st.id) AS session_count,
            (SELECT to_char(max(s.session_date),'YYYY-MM-DD') FROM sessions s WHERE s.student_id = st.id) AS last_session
       FROM students st WHERE st.id = $1`,
    [studentId],
  );
  if (st.rowCount === 0) return null;

  const sessions = (
    await client.query(
      `SELECT id, to_char(session_date,'YYYY-MM-DD') AS session_date, source, status
         FROM sessions WHERE student_id = $1 ORDER BY session_date DESC, created_at DESC`,
      [studentId],
    )
  ).rows;

  // Latest session that has an analysis (a re-run in progress still shows the previous result).
  const cur = (
    await client.query(
      `SELECT s.id, to_char(s.session_date,'YYYY-MM-DD') AS session_date, s.current_analysis_run_id AS run_id,
              r.changes_since_earlier_sessions AS changes
         FROM sessions s JOIN analysis_runs r ON r.id = s.current_analysis_run_id
        WHERE s.student_id = $1
        ORDER BY s.session_date DESC, s.created_at DESC LIMIT 1`,
      [studentId],
    )
  ).rows[0];

  let latest: StudentView["latest"] = null;
  if (cur) {
    const themeRows = (
      await client.query(
        "SELECT id, sub_driver_id, domain_id, other_label, title, interpretation FROM themes WHERE analysis_run_id = $1 ORDER BY position, id",
        [cur.run_id],
      )
    ).rows;
    const ev = (
      await client.query(
        `SELECT e.theme_id, e.quote, u.idx AS utterance_idx
           FROM theme_evidence e JOIN utterances u ON u.id = e.utterance_id
           JOIN themes th ON th.id = e.theme_id WHERE th.analysis_run_id = $1 ORDER BY u.idx`,
        [cur.run_id],
      )
    ).rows;
    const themes: ThemeView[] = themeRows.map((t) => ({
      ...t,
      evidence: ev.filter((e) => e.theme_id === t.id).map((e) => ({ quote: e.quote, utterance_idx: e.utterance_idx })),
    }));
    const byId = new Map(themes.map((t) => [t.id, t]));

    const recs = (
      await client.query(
        "SELECT id, topic, open_question, suggested_approach, based_on_theme_ids FROM recommendations WHERE analysis_run_id = $1 ORDER BY position, id",
        [cur.run_id],
      )
    ).rows;
    latest = {
      session_id: cur.id,
      session_date: cur.session_date,
      themes,
      recommendations: recs.map((r) => ({
        id: r.id,
        topic: r.topic,
        open_question: r.open_question,
        suggested_approach: r.suggested_approach,
        based_on: (r.based_on_theme_ids as string[])
          .map((id) => byId.get(id))
          .filter((t): t is ThemeView => !!t)
          .map((t) => ({ sub_driver_id: t.sub_driver_id, other_label: t.other_label })),
      })),
      changes: cur.changes ?? [],
    };
  }

  await audit(client, counselorId, "view_student", { studentId });
  return {
    student: st.rows[0],
    sessions,
    latest,
    processingStatus: sessions.find((s) => PROCESSING.includes(s.status))?.status ?? null,
  };
}
