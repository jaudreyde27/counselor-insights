import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { getPool } from "../db";
import { logEvent } from "../log";
import { finishTranscription, type AudioDeps } from "./process";
import { WEBHOOK_HEADER_NAME } from "./types";

const bodySchema = z.object({ transcript_id: z.string().min(1).max(200), status: z.string() });

/** Compares secrets without leaking how many characters matched (SHA-256 first, so lengths are equal). */
export function secretsMatch(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Which session and counselor a transcript id belongs to. Uses the narrow database function (migration 0008). */
export async function findSessionForTranscript(
  transcriptId: string,
  pool: Pool = getPool(),
): Promise<{ sessionId: string; counselorId: string } | null> {
  const { rows } = await pool.query<{ o_session_id: string; o_counselor_id: string }>(
    "SELECT * FROM find_session_for_transcript($1)",
    [transcriptId],
  );
  return rows[0] ? { sessionId: rows[0].o_session_id, counselorId: rows[0].o_counselor_id } : null;
}

/**
 * POST /api/webhooks/assemblyai. Rejects anything without the right secret header (401), then
 * answers 200 right away and does the real work afterwards through `schedule` (AssemblyAI waits
 * only 10 seconds for a reply). The body holds only a transcript id and a status, never text.
 */
export async function handleTranscriptionWebhook(
  request: Request,
  deps: AudioDeps,
  schedule: (work: () => Promise<unknown>) => void,
): Promise<Response> {
  if (!deps.webhookSecret) return new Response("Webhook is not configured", { status: 500 }); // never accept when unconfigured
  if (!secretsMatch(request.headers.get(WEBHOOK_HEADER_NAME), deps.webhookSecret)) {
    logEvent("webhook_rejected");
    return new Response("Unauthorized", { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const found = await findSessionForTranscript(body.transcript_id, deps.pool);
  if (!found) {
    logEvent("webhook_unknown_transcript"); // answered 200 so the sender stops retrying
    return new Response(null, { status: 200 });
  }

  schedule(async () => {
    try {
      const outcome = await finishTranscription(found.counselorId, found.sessionId, deps);
      logEvent("webhook_processed", { session_id: found.sessionId, outcome });
    } catch {
      logEvent("webhook_processing_error", { session_id: found.sessionId });
    }
  });
  return new Response(null, { status: 200 });
}
