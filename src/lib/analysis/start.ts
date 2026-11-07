import { getCriteria } from "../criteria";
import { withCounselor } from "../db";
import { isAppActive } from "../lifecycle";
import { createLlmClient } from "../llm";
import { logEvent } from "../log";
import { runAnalysisForSession } from "./run";

/**
 * Runs the analysis for a session in the background (the page polls the session
 * status). Never throws: a problem ends with the session marked `failed`, so the
 * counselor can press "Re-run analysis". Only codes are logged, never messages.
 */
export async function startAnalysis(counselorId: string, sessionId: string): Promise<void> {
  if (!isAppActive()) {
    logEvent("analysis_skipped_deactivated"); // after the end date no model calls are made
    return;
  }
  try {
    await runAnalysisForSession(counselorId, sessionId, { llm: createLlmClient(), criteria: getCriteria() });
  } catch {
    logEvent("analysis_job_error", { session_id: sessionId });
    try {
      await withCounselor(counselorId, (c) =>
        c.query(
          `UPDATE sessions SET status = 'failed',
                  error_message = 'Analysis could not start. Check the LLM settings, then press "Re-run analysis".'
            WHERE id = $1 AND status IN ('transcribed','analyzing')`,
          [sessionId],
        ),
      );
    } catch {
      // Nothing more we can safely do; the failure was already logged.
    }
  }
}
