import type { Pool, PoolClient } from "pg";
import type { Criteria } from "../criteria";
import { getPool, withCounselor } from "../db";
import type { LlmClient } from "../llm";
import { logEvent } from "../log";
import type { ParsedUtterance } from "../transcript";
import { analyzeTranscript, AnalysisError } from "./analyze";
import { promptVersion } from "./prompts";
import type { AnalysisResult, EarlierTheme, Utterance } from "./types";

export interface RunDeps {
  llm: LlmClient;
  criteria: Criteria;
  pool?: Pool;
  promptVersion?: string;
  temperature?: number;
}

/** Saves a parsed transcript as utterances. Utterances are the unit of storage (SPEC.md step 4). */
export async function storeUtterances(
  client: PoolClient,
  sessionId: string,
  utterances: ParsedUtterance[],
): Promise<void> {
  for (const [idx, u] of utterances.entries()) {
    await client.query("INSERT INTO utterances (session_id, idx, speaker, text) VALUES ($1,$2,$3,$4)", [
      sessionId,
      idx,
      u.speaker,
      u.text,
    ]);
  }
}

/**
 * Runs the analysis for one stored session and saves it as a NEW analysis run
 * (earlier runs are kept). Reads only utterances and earlier verified themes:
 * the student record and all notes are never loaded here, so they cannot reach the model.
 * Session status: transcribed|complete|failed -> analyzing -> complete (or failed).
 */
export async function runAnalysisForSession(
  counselorId: string,
  sessionId: string,
  deps: RunDeps,
): Promise<{ runId: string; status: "complete" | "failed"; result?: AnalysisResult }> {
  const pool = deps.pool ?? getPool();
  const version = deps.promptVersion ?? promptVersion();

  // 1. Read what the model may see, mark the session as analyzing, and open a run.
  const { runId, utterances, earlierThemes } = await withCounselor(
    counselorId,
    async (c) => {
      const s = await c.query<{ student_id: string; status: string }>(
        "SELECT student_id, status FROM sessions WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      if (s.rowCount === 0) throw new Error("Session not found.");
      if (!["transcribed", "complete", "failed"].includes(s.rows[0].status)) {
        throw new Error("Session is not ready to analyze.");
      }

      const u = await c.query<Utterance>(
        "SELECT id, speaker, text FROM utterances WHERE session_id = $1 ORDER BY idx",
        [sessionId],
      );
      if (u.rowCount === 0) throw new Error("Session has no transcript.");

      // Verified themes from this student's earlier sessions (each session's current run only).
      const e = await c.query<EarlierTheme>(
        `SELECT to_char(s.session_date, 'YYYY-MM-DD') AS session_date,
                t.sub_driver_id, t.domain_id, t.other_label, t.title, t.interpretation
           FROM sessions cur
           JOIN sessions s ON s.student_id = cur.student_id AND s.id <> cur.id
           JOIN themes t ON t.analysis_run_id = s.current_analysis_run_id
          WHERE cur.id = $1
            AND (s.session_date < cur.session_date
                 OR (s.session_date = cur.session_date AND s.created_at < cur.created_at))
          ORDER BY s.session_date, t.created_at`,
        [sessionId],
      );

      const run = await c.query<{ id: string }>(
        `INSERT INTO analysis_runs (session_id, model_id, prompt_version, criteria_version, status)
         VALUES ($1,$2,$3,$4,'running') RETURNING id`,
        [sessionId, deps.llm.modelId, version, deps.criteria.version],
      );
      await c.query("UPDATE sessions SET status = 'analyzing', error_message = NULL WHERE id = $1", [sessionId]);
      return { runId: run.rows[0].id, utterances: u.rows, earlierThemes: e.rows };
    },
    pool,
  );

  logEvent("analysis_started", { session_id: sessionId, run_id: runId, utterances: utterances.length });

  // 2. Call the model (outside any database transaction; this can take a while).
  let result: AnalysisResult;
  try {
    result = await analyzeTranscript(
      { utterances, earlierThemes },
      { llm: deps.llm, criteria: deps.criteria, promptVersion: version, temperature: deps.temperature },
    );
  } catch (err) {
    // Only an error code is saved and logged, never the message (it could contain content).
    const code = err instanceof AnalysisError ? err.code : "unexpected_error";
    await withCounselor(
      counselorId,
      async (c) => {
        await c.query("UPDATE analysis_runs SET status = 'failed' WHERE id = $1", [runId]);
        await c.query("UPDATE sessions SET status = 'failed', error_message = $2 WHERE id = $1", [
          sessionId,
          `Analysis failed (${code}). Press "Re-run analysis" to try again.`,
        ]);
      },
      pool,
    );
    logEvent("analysis_failed", { session_id: sessionId, run_id: runId, code });
    return { runId, status: "failed" };
  }

  // 3. Save the verified result.
  await withCounselor(
    counselorId,
    async (c) => {
      for (const [position, t] of result.themes.entries()) {
        await c.query(
          `INSERT INTO themes (id, analysis_run_id, session_id, sub_driver_id, domain_id, other_label, title, interpretation, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [t.id, runId, sessionId, t.sub_driver_id, t.domain_id, t.other_label, t.title, t.interpretation, position],
        );
        for (const ev of t.evidence) {
          await c.query("INSERT INTO theme_evidence (theme_id, utterance_id, quote) VALUES ($1,$2,$3)", [
            t.id,
            ev.utterance_id,
            ev.quote,
          ]);
        }
      }
      for (const [position, r] of result.recommendations.entries()) {
        await c.query(
          `INSERT INTO recommendations (analysis_run_id, session_id, topic, open_question, suggested_approach, based_on_theme_ids, position)
           VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7)`,
          [runId, sessionId, r.topic, r.open_question, r.suggested_approach, r.based_on_theme_ids, position],
        );
      }
      await c.query(
        `UPDATE analysis_runs
            SET status = 'complete', dropped_quote_count = $2,
                changes_since_earlier_sessions = $3::text[]
          WHERE id = $1`,
        [runId, result.dropped_quote_count, result.changes_since_earlier_sessions],
      );
      await c.query("UPDATE sessions SET status = 'complete', current_analysis_run_id = $2 WHERE id = $1", [
        sessionId,
        runId,
      ]);
    },
    pool,
  );

  logEvent("analysis_complete", { session_id: sessionId, run_id: runId, themes: result.themes.length });
  return { runId, status: "complete", result };
}
