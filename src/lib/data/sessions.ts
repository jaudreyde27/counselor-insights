import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { storeUtterances } from "../analysis/run";
import { audioKeyFor, type AudioExt } from "../storage/audio-types";
import type { Speaker } from "../analysis/types";
import type { ParsedUtterance } from "../transcript";
import { audit } from "./audit";
import { expireStaleSessions } from "./maintenance";

/**
 * Creates a session from a pasted transcript. Pasted transcripts go straight from
 * `created` to `transcribed` (SPEC.md section 4), so analysis can start right away.
 */
export async function createPastedSession(
  client: PoolClient,
  input: {
    counselorId: string;
    studentId: string;
    sessionDate: string;
    utterances: ParsedUtterance[];
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sessions (student_id, counselor_id, session_date, source, status)
     VALUES ($1,$2,$3,'pasted','transcribed') RETURNING id`,
    [input.studentId, input.counselorId, input.sessionDate],
  );
  const sessionId = rows[0].id;
  await storeUtterances(client, sessionId, input.utterances);
  await audit(client, input.counselorId, "session_created", { studentId: input.studentId, sessionId });
  return sessionId;
}

/**
 * Creates a session for an audio recording that is about to be uploaded (status `awaiting_upload`).
 * The consent tick is saved with a timestamp. The storage key has only the session id in it.
 */
export async function createAudioSession(
  client: PoolClient,
  input: { counselorId: string; studentId: string; sessionDate: string; ext: AudioExt },
): Promise<{ sessionId: string; key: string }> {
  const sessionId = randomUUID();
  const key = audioKeyFor(sessionId, input.ext);
  await client.query(
    `INSERT INTO sessions (id, student_id, counselor_id, session_date, source, status, audio_s3_key, consent_confirmed_at)
     VALUES ($1,$2,$3,$4,'audio','awaiting_upload',$5, now())`,
    [sessionId, input.studentId, input.counselorId, input.sessionDate, key],
  );
  await audit(client, input.counselorId, "session_created", { studentId: input.studentId, sessionId });
  return { sessionId, key };
}

/** Storage keys of every recording belonging to a student, so they can be deleted with the student. */
export async function audioKeysForStudent(client: PoolClient, studentId: string): Promise<string[]> {
  const { rows } = await client.query<{ audio_s3_key: string }>(
    "SELECT audio_s3_key FROM sessions WHERE student_id = $1 AND audio_s3_key IS NOT NULL",
    [studentId],
  );
  return rows.map((r) => r.audio_s3_key);
}

/**
 * Flips counselor <-> student on every stored utterance of a session (the fix for
 * wrong speaker labels). Existing themes were built on the old labels, so the
 * counselor should then press "Re-run analysis".
 */
export async function swapSpeakers(client: PoolClient, counselorId: string, sessionId: string): Promise<boolean> {
  const s = await client.query<{ student_id: string }>("SELECT student_id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
  if (s.rowCount === 0) return false;
  await client.query(
    `UPDATE utterances
        SET speaker = CASE speaker WHEN 'counselor' THEN 'student' ELSE 'counselor' END
      WHERE session_id = $1`,
    [sessionId],
  );
  // For a transcribed recording, also swap which of the service's own labels (A/B) is the student's.
  await client.query(
    `UPDATE sessions
        SET student_speaker_label = COALESCE(
          (SELECT u.raw_speaker_label FROM utterances u
            WHERE u.session_id = sessions.id AND u.raw_speaker_label IS NOT NULL
              AND u.raw_speaker_label <> sessions.student_speaker_label LIMIT 1),
          student_speaker_label)
      WHERE id = $1 AND student_speaker_label IS NOT NULL`,
    [sessionId],
  );
  await audit(client, counselorId, "swap_speakers", { studentId: s.rows[0].student_id, sessionId });
  return true;
}

export interface SessionTheme {
  id: string;
  sub_driver_id: string;
  domain_id: string;
  other_label: string | null;
  title: string;
  interpretation: string;
  evidence: Array<{ quote: string; utterance_idx: number }>;
}

export interface SessionView {
  id: string;
  student_id: string;
  student_name: string;
  session_date: string;
  source: "audio" | "pasted";
  status: string;
  error_message: string | null;
  utterances: Array<{ id: string; idx: number; speaker: Speaker; text: string }>;
  run: null | {
    id: string;
    model_id: string;
    prompt_version: string;
    criteria_version: string;
    dropped_quote_count: number;
  };
  themes: SessionTheme[];
}

/** Everything the session page shows. Returns null if it does not exist (or is not this counselor's). */
export async function getSessionView(client: PoolClient, counselorId: string, sessionId: string): Promise<SessionView | null> {
  await expireStaleSessions(client);
  const s = await client.query(
    `SELECT s.id, s.student_id, st.full_name AS student_name,
            to_char(s.session_date,'YYYY-MM-DD') AS session_date, s.source, s.status,
            s.error_message, s.current_analysis_run_id
       FROM sessions s JOIN students st ON st.id = s.student_id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (s.rowCount === 0) return null;
  const row = s.rows[0];

  const utterances = (
    await client.query("SELECT id, idx, speaker, text FROM utterances WHERE session_id = $1 ORDER BY idx", [sessionId])
  ).rows;

  let run: SessionView["run"] = null;
  let themes: SessionTheme[] = [];
  if (row.current_analysis_run_id) {
    const r = (await client.query("SELECT * FROM analysis_runs WHERE id = $1", [row.current_analysis_run_id])).rows[0];
    run = {
      id: r.id,
      model_id: r.model_id,
      prompt_version: r.prompt_version,
      criteria_version: r.criteria_version,
      dropped_quote_count: r.dropped_quote_count,
    };
    const t = (
      await client.query(
        "SELECT id, sub_driver_id, domain_id, other_label, title, interpretation FROM themes WHERE analysis_run_id = $1 ORDER BY position, id",
        [r.id],
      )
    ).rows;
    const ev = (
      await client.query(
        `SELECT e.theme_id, e.quote, u.idx AS utterance_idx
           FROM theme_evidence e JOIN utterances u ON u.id = e.utterance_id
           JOIN themes th ON th.id = e.theme_id WHERE th.analysis_run_id = $1 ORDER BY u.idx`,
        [r.id],
      )
    ).rows;
    themes = t.map((th) => ({
      ...th,
      evidence: ev.filter((e) => e.theme_id === th.id).map((e) => ({ quote: e.quote, utterance_idx: e.utterance_idx })),
    }));
  }

  await audit(client, counselorId, "view_session", { studentId: row.student_id, sessionId });
  return {
    id: row.id,
    student_id: row.student_id,
    student_name: row.student_name,
    session_date: row.session_date,
    source: row.source,
    status: row.status,
    error_message: row.error_message,
    utterances,
    run,
    themes,
  };
}
