import type { PoolClient } from "pg";

/**
 * Closes out sessions that can no longer finish on their own, so nothing stays "in progress"
 * forever (SPEC.md section 5: if the task restarts mid-run the session shows `failed` and the
 * counselor can press "Re-run analysis"). Only this counselor's rows are touched (row-level security).
 *  - an upload link lasts 15 minutes, so an upload still waiting after 30 minutes was abandoned;
 *  - an analysis with no sign of life for 15 minutes was interrupted (for example by a restart).
 * A recording that is still "transcribing" is left alone: "Check status" fetches it if the webhook never came.
 */
export async function expireStaleSessions(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE sessions SET status = 'failed',
            error_message = 'The upload was not completed. Please add the session again.'
      WHERE status = 'awaiting_upload' AND created_at < now() - interval '30 minutes'`,
  );
  await client.query(
    `UPDATE analysis_runs SET status = 'failed'
      WHERE status = 'running' AND created_at < now() - interval '15 minutes'`,
  );
  await client.query(
    `UPDATE sessions SET status = 'failed',
            error_message = 'The analysis was interrupted. Press "Re-run analysis" to try again.'
      WHERE status = 'analyzing'
        AND NOT EXISTS (SELECT 1 FROM analysis_runs r
                         WHERE r.session_id = sessions.id AND r.created_at > now() - interval '15 minutes')`,
  );
}
