import type { Pool } from "pg";
import { startAnalysis } from "../analysis/start";
import { getPool, withCounselor } from "../db";
import { isAppActive } from "../lifecycle";
import { logEvent } from "../log";
import { appBaseUrl, getAudioStorage, type AudioStorage } from "../storage";
import { DOWNLOAD_URL_SECONDS } from "../storage/audio-types";
import { mapSpeakers } from "./speakers";
import { getTranscriptionClient, WEBHOOK_HEADER_NAME, type TranscriptionClient } from "./index";

export interface AudioDeps {
  storage: AudioStorage;
  transcription: TranscriptionClient;
  /** Shared secret AssemblyAI sends back on the webhook call. */
  webhookSecret: string;
  baseUrl: string;
  pool?: Pool;
  /** Runs the analysis once a transcript is saved. Defaults to the real analysis job. */
  analyze?: (counselorId: string, sessionId: string) => Promise<void>;
}

/** The app's real dependencies, built from the environment. */
export function defaultAudioDeps(): AudioDeps {
  const webhookSecret = process.env.ASSEMBLYAI_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("ASSEMBLYAI_WEBHOOK_SECRET is not set. See .env.example.");
  return {
    storage: getAudioStorage(),
    transcription: getTranscriptionClient(),
    webhookSecret,
    baseUrl: appBaseUrl(),
  };
}

export const webhookUrl = (baseUrl: string) => `${baseUrl}/api/webhooks/assemblyai`;

async function markFailed(counselorId: string, sessionId: string, message: string, pool?: Pool): Promise<void> {
  await withCounselor(
    counselorId,
    (c) => c.query("UPDATE sessions SET status = 'failed', error_message = $2 WHERE id = $1", [sessionId, message]),
    pool ?? getPool(),
  );
}

export type StartOutcome = "transcribing" | "failed" | "ignored";

/**
 * After a recording is uploaded (or when retrying a failed session): checks the file is really in
 * storage (a HeadObject on S3), then asks the transcription service for a speaker-labelled
 * transcript, giving it a short-lived link to the audio and the webhook address.
 * Session status: awaiting_upload | failed -> uploaded -> transcribing (or failed).
 */
export async function startTranscription(counselorId: string, sessionId: string, deps: AudioDeps): Promise<StartOutcome> {
  if (!isAppActive()) return "ignored"; // after the end date no transcription is started
  const pool = deps.pool ?? getPool();
  const s = await withCounselor(
    counselorId,
    async (c) =>
      (await c.query<{ status: string; source: string; audio_s3_key: string | null }>(
        "SELECT status, source, audio_s3_key FROM sessions WHERE id = $1",
        [sessionId],
      )).rows[0],
    pool,
  );
  if (!s || s.source !== "audio" || !s.audio_s3_key) return "ignored";
  if (!["awaiting_upload", "uploaded", "failed"].includes(s.status)) return "ignored";

  if (!(await deps.storage.exists(s.audio_s3_key))) {
    await markFailed(counselorId, sessionId, "The upload did not finish. Please add the session again.", pool);
    logEvent("upload_missing", { session_id: sessionId });
    return "failed";
  }

  await withCounselor(
    counselorId,
    (c) => c.query("UPDATE sessions SET status = 'uploaded', error_message = NULL WHERE id = $1", [sessionId]),
    pool,
  );
  try {
    const audioUrl = await deps.storage.createDownloadUrl(s.audio_s3_key, DOWNLOAD_URL_SECONDS);
    const job = await deps.transcription.createJob({
      audioUrl,
      webhookUrl: webhookUrl(deps.baseUrl),
      webhookHeaderName: WEBHOOK_HEADER_NAME,
      webhookSecret: deps.webhookSecret,
    });
    await withCounselor(
      counselorId,
      (c) =>
        c.query("UPDATE sessions SET status = 'transcribing', assemblyai_transcript_id = $2 WHERE id = $1", [
          sessionId,
          job.id,
        ]),
      pool,
    );
    logEvent("transcription_started", { session_id: sessionId });
    return "transcribing";
  } catch {
    // Only a code is logged, and a plain message saved. The error itself is never kept (it could name content).
    await markFailed(counselorId, sessionId, 'Transcription could not be started. Press "Re-run analysis" to try again.', pool);
    logEvent("transcription_start_failed", { session_id: sessionId });
    return "failed";
  }
}

export type FinishOutcome = "saved" | "pending" | "failed" | "ignored";

/**
 * Fetches the finished transcript, saves it as utterances (with speakers mapped), marks the session
 * `transcribed`, starts the analysis, and deletes the transcript from the provider. Called from the
 * webhook and from the "Check status" button, and safe to call twice: only a session that is
 * still `transcribing` is processed, and it is locked while saving.
 */
export async function finishTranscription(counselorId: string, sessionId: string, deps: AudioDeps): Promise<FinishOutcome> {
  if (!isAppActive()) return "ignored";
  const pool = deps.pool ?? getPool();
  const analyze = deps.analyze ?? startAnalysis;

  const s = await withCounselor(
    counselorId,
    async (c) =>
      (await c.query<{ status: string; assemblyai_transcript_id: string | null }>(
        "SELECT status, assemblyai_transcript_id FROM sessions WHERE id = $1",
        [sessionId],
      )).rows[0],
    pool,
  );
  if (!s || s.status !== "transcribing" || !s.assemblyai_transcript_id) return "ignored";
  const transcriptId = s.assemblyai_transcript_id;

  let result;
  try {
    result = await deps.transcription.getTranscript(transcriptId);
  } catch {
    logEvent("transcript_fetch_failed", { session_id: sessionId });
    return "pending"; // the service may be briefly unavailable; Check status can try again
  }
  if (result.status === "queued" || result.status === "processing") return "pending";
  if (result.status === "error") {
    await markFailed(counselorId, sessionId, 'Transcription failed. Press "Re-run analysis" to try again.', pool);
    logEvent("transcription_failed", { session_id: sessionId });
    return "failed";
  }

  const { utterances, studentLabel } = mapSpeakers(result.utterances ?? []);
  if (utterances.length === 0) {
    await markFailed(counselorId, sessionId, "The recording had no speech that could be transcribed.", pool);
    logEvent("transcript_empty", { session_id: sessionId });
    return "failed";
  }

  const saved = await withCounselor(
    counselorId,
    async (c) => {
      // Lock the row and re-check: the webhook and "Check status" may arrive together.
      const cur = await c.query<{ status: string }>("SELECT status FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      if (cur.rows[0]?.status !== "transcribing") return false;
      await c.query("DELETE FROM utterances WHERE session_id = $1", [sessionId]);
      for (const [idx, u] of utterances.entries()) {
        await c.query(
          `INSERT INTO utterances (session_id, idx, speaker, raw_speaker_label, start_ms, end_ms, text)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sessionId, idx, u.speaker, u.raw_speaker_label, u.start_ms, u.end_ms, u.text],
        );
      }
      await c.query("UPDATE sessions SET status = 'transcribed', student_speaker_label = $2, error_message = NULL WHERE id = $1", [
        sessionId,
        studentLabel,
      ]);
      return true;
    },
    pool,
  );
  if (!saved) return "ignored";
  logEvent("transcript_saved", { session_id: sessionId, utterances: utterances.length });

  // Remove our copy from the provider (if their plan allows it). A failure here never matters to the counselor.
  deps.transcription.deleteTranscript(transcriptId).catch(() => logEvent("provider_delete_failed", { session_id: sessionId }));

  await analyze(counselorId, sessionId);
  return "saved";
}
