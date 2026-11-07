import type { CreateJobInput, RawUtterance, TranscriptResult, TranscriptStatus, TranscriptionClient } from "./types";

/**
 * AssemblyAI over its REST API. Written to the current docs (checked November 2026) but NOT yet run
 * against the real service: it needs an AssemblyAI account and key (stored in AWS Secrets Manager
 * when deployed, never in a file or in chat).
 *
 * Submit:  POST /v2/transcript with audio_url, speaker_labels, speakers_expected, language_code,
 *          webhook_url, webhook_auth_header_name, webhook_auth_header_value.
 * Webhook: AssemblyAI POSTs { transcript_id, status } (status "completed" or "error") with our
 *          secret header, and expects a 2xx within 10 seconds. The text is fetched separately.
 * Fetch:   GET /v2/transcript/{id} -> status, utterances [{ speaker, text, start, end }] in ms.
 * Delete:  DELETE /v2/transcript/{id}.
 * General (not medical) English model: the default speech models are used.
 */
export class AssemblyAiClient implements TranscriptionClient {
  constructor(
    private apiKey: string,
    private baseUrl = process.env.ASSEMBLYAI_BASE_URL ?? "https://api.assemblyai.com",
  ) {
    if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not set.");
  }

  // Errors carry only a status code, never the response body (it could contain transcript text).
  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: this.apiKey, "content-type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new Error(`AssemblyAI request failed (${res.status}).`);
    return res.json();
  }

  async createJob(input: CreateJobInput): Promise<{ id: string }> {
    const out = (await this.call("/v2/transcript", {
      method: "POST",
      body: JSON.stringify({
        audio_url: input.audioUrl,
        speaker_labels: true,
        speakers_expected: 2,
        language_code: "en",
        webhook_url: input.webhookUrl,
        webhook_auth_header_name: input.webhookHeaderName,
        webhook_auth_header_value: input.webhookSecret,
      }),
    })) as { id?: string };
    if (!out.id) throw new Error("AssemblyAI did not return a transcript id.");
    return { id: out.id };
  }

  async getTranscript(id: string): Promise<TranscriptResult> {
    const t = (await this.call(`/v2/transcript/${encodeURIComponent(id)}`)) as {
      status?: string;
      utterances?: Array<{ speaker: string; text: string; start?: number; end?: number }> | null;
    };
    const status = (["queued", "processing", "completed", "error"] as const).includes(t.status as TranscriptStatus)
      ? (t.status as TranscriptStatus)
      : "error";
    if (status !== "completed") return { status };
    const utterances: RawUtterance[] = (t.utterances ?? []).map((u) => ({
      speaker: String(u.speaker),
      text: u.text,
      start_ms: u.start,
      end_ms: u.end,
    }));
    return { status, utterances };
  }

  async deleteTranscript(id: string): Promise<void> {
    await this.call(`/v2/transcript/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
