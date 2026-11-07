import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidAudioKey } from "../storage/audio-types";
import type { LocalAudioStorage } from "../storage";
import { logEvent } from "../log";
import type { CreateJobInput, RawUtterance, TranscriptResult, TranscriptionClient } from "./types";

interface Job {
  audioKey: string;
  readyAt: number;
}

/**
 * Local stand-in for AssemblyAI (TRANSCRIPTION_MODE=mock), for development and tests only. It does
 * NOT listen to the audio. It picks one of the fictional fixture transcripts:
 *   1. from a marker inside the file ("fixture-03", which the sample WAVs in fixtures/audio carry), else
 *   2. from a hash of the file's bytes.
 * (Never from the file name: names are not stored.) After a short delay it calls this app's real
 * webhook, with the secret header, exactly as AssemblyAI would. "Check status" works too, because
 * the job is saved to disk and reports "processing" until it is ready.
 */
export class MockTranscriptionClient implements TranscriptionClient {
  constructor(
    private storage: LocalAudioStorage,
    private opts: { delayMs?: number; fixturesDir?: string; fetchFn?: typeof fetch; autoWebhook?: boolean } = {},
  ) {}

  private get jobsDir() {
    return path.join(this.storage.dir, "jobs");
  }

  private jobFile(id: string) {
    if (!/^mock-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job id.");
    return path.join(this.jobsDir, `${id}.json`);
  }

  async createJob(input: CreateJobInput): Promise<{ id: string }> {
    const marker = "/api/local-storage/";
    const pathname = new URL(input.audioUrl).pathname;
    const audioKey = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
    if (!isValidAudioKey(audioKey)) throw new Error("Mock transcription needs a local audio link.");

    const id = `mock-${randomUUID()}`;
    const delay = this.opts.delayMs ?? 1500;
    await mkdir(this.jobsDir, { recursive: true });
    await writeFile(this.jobFile(id), JSON.stringify({ audioKey, readyAt: Date.now() + delay } satisfies Job));

    if (this.opts.autoWebhook !== false) {
      const send = this.opts.fetchFn ?? fetch;
      setTimeout(() => {
        send(input.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", [input.webhookHeaderName]: input.webhookSecret },
          body: JSON.stringify({ transcript_id: id, status: "completed" }),
        }).catch(() => logEvent("mock_webhook_call_failed", { job_id: id }));
      }, delay);
    }
    return { id };
  }

  async getTranscript(id: string): Promise<TranscriptResult> {
    let job: Job;
    try {
      job = JSON.parse(await readFile(this.jobFile(id), "utf8"));
    } catch {
      return { status: "error" };
    }
    if (Date.now() < job.readyAt) return { status: "processing" };
    return { status: "completed", utterances: await this.transcriptFor(job.audioKey) };
  }

  async deleteTranscript(id: string): Promise<void> {
    await rm(this.jobFile(id), { force: true });
  }

  /** Picks the fictional transcript for a recording. */
  private async transcriptFor(audioKey: string): Promise<RawUtterance[]> {
    const dir = this.opts.fixturesDir ?? path.resolve(process.cwd(), "fixtures", "transcripts");
    const files = (await readdir(/* turbopackIgnore: true */ dir)).filter((f) => f.endsWith(".json")).sort();
    const bytes = (await this.storage.read(audioKey)) ?? Buffer.alloc(0);

    const marker = /fixture-(\d{2})/.exec(bytes.toString("latin1"));
    const byMarker = marker && files.find((f) => f.startsWith(`${marker[1]}-`));
    const hash = createHash("sha256").update(bytes).digest();
    const file = byMarker ?? files[hash[0] % files.length];

    const lines = JSON.parse(await readFile(path.join(/* turbopackIgnore: true */ dir, file), "utf8")) as Array<{
      speaker: "counselor" | "student";
      text: string;
    }>;
    // Raw labels like the real service: the first speaker is "A", the other "B". Timings are made up.
    return lines.map((l, i) => ({
      speaker: l.speaker === "counselor" ? "A" : "B",
      text: l.text,
      start_ms: i * 6000,
      end_ms: i * 6000 + 5500,
    }));
  }
}
