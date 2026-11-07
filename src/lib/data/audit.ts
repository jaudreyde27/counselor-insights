import type { PoolClient } from "pg";

/** Fixed event names only. Student names and any other text never go in `action`. */
export type AuditAction =
  | "student_created"
  | "session_created"
  | "audio_uploaded"
  | "check_status"
  | "view_student"
  | "view_session"
  | "rerun_analysis"
  | "swap_speakers"
  | "delete_student";

export async function audit(
  client: PoolClient,
  counselorId: string,
  action: AuditAction,
  ids: { studentId?: string | null; sessionId?: string | null } = {},
): Promise<void> {
  await client.query("INSERT INTO audit_events (counselor_id, student_id, session_id, action) VALUES ($1,$2,$3,$4)", [
    counselorId,
    ids.studentId ?? null,
    ids.sessionId ?? null,
    action,
  ]);
}
