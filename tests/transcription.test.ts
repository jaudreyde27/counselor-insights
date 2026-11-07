import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalAudioStorage } from "@/lib/storage";
import { audioKeyFor } from "@/lib/storage/audio-types";
import { AssemblyAiClient } from "@/lib/transcription/assemblyai";
import { assertTranscriptionSafe } from "@/lib/transcription";
import { MockTranscriptionClient } from "@/lib/transcription/mock";
import { mapSpeakers } from "@/lib/transcription/speakers";
import { FIXTURE_NAMES, loadFixture } from "./helpers/llm";

describe("speaker mapping (first speaker = counselor, the other = student)", () => {
  const raw = [
    { speaker: "A", text: "How are you?", start_ms: 0, end_ms: 1000 },
    { speaker: "B", text: "Tired.", start_ms: 1100, end_ms: 2000 },
    { speaker: "A", text: "Tell me more.", start_ms: 2100, end_ms: 3000 },
  ];

  it("labels the first speaker counselor and the other student, keeping the service's own labels and times", () => {
    const { utterances, studentLabel } = mapSpeakers(raw);
    expect(studentLabel).toBe("B");
    expect(utterances.map((u) => u.speaker)).toEqual(["counselor", "student", "counselor"]);
    expect(utterances.map((u) => u.raw_speaker_label)).toEqual(["A", "B", "A"]);
    expect(utterances[1]).toMatchObject({ start_ms: 1100, end_ms: 2000, text: "Tired." });
  });

  it("does not assume the labels are A and B, only that the first to speak is the counselor", () => {
    const { utterances, studentLabel } = mapSpeakers([
      { speaker: "B", text: "Hello." },
      { speaker: "A", text: "Hi." },
    ]);
    expect(utterances.map((u) => u.speaker)).toEqual(["counselor", "student"]);
    expect(studentLabel).toBe("A");
  });

  it("treats a recording with one detected speaker as the student, drops empty lines, trims text, tolerates missing times", () => {
    const one = mapSpeakers([{ speaker: "A", text: "  I feel alone.  " }, { speaker: "A", text: "   " }]);
    expect(one.utterances).toEqual([{ speaker: "student", raw_speaker_label: "A", start_ms: null, end_ms: null, text: "I feel alone." }]);
    expect(mapSpeakers([])).toEqual({ utterances: [], studentLabel: null });
  });
});

describe("AssemblyAI client (request shapes, with a fake fetch: no network)", () => {
  type Call = { url: string; init: RequestInit };
  const calls: Call[] = [];
  let reply: { ok: boolean; status: number; body: unknown };
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    reply = { ok: true, status: 200, body: {} };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: reply.ok, status: reply.status, json: async () => reply.body } as Response;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = () => new AssemblyAiClient("test-key-not-real", "https://api.example.test");

  it("needs a key", () => {
    expect(() => new AssemblyAiClient("")).toThrow(/ASSEMBLYAI_API_KEY/);
  });

  it("submits a job with speaker labels on, two speakers, English, the webhook, and the secret header", async () => {
    reply.body = { id: "tr_123" };
    const out = await client().createJob({
      audioUrl: "https://bucket.example/audio.wav?sig=abc",
      webhookUrl: "https://app.example/api/webhooks/assemblyai",
      webhookHeaderName: "x-webhook-secret",
      webhookSecret: "the-secret",
    });
    expect(out).toEqual({ id: "tr_123" });
    expect(calls[0].url).toBe("https://api.example.test/v2/transcript");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("test-key-not-real");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      audio_url: "https://bucket.example/audio.wav?sig=abc",
      speaker_labels: true,
      speakers_expected: 2,
      language_code: "en",
      webhook_url: "https://app.example/api/webhooks/assemblyai",
      webhook_auth_header_name: "x-webhook-secret",
      webhook_auth_header_value: "the-secret",
    });
  });

  it("reads a finished transcript into utterances with times in milliseconds", async () => {
    reply.body = { status: "completed", utterances: [{ speaker: "A", text: "Hi.", start: 250, end: 900, confidence: 0.9, words: [] }] };
    expect(await client().getTranscript("tr_123")).toEqual({
      status: "completed",
      utterances: [{ speaker: "A", text: "Hi.", start_ms: 250, end_ms: 900 }],
    });
    expect(calls[0].url).toBe("https://api.example.test/v2/transcript/tr_123");
  });

  it("reports queued, processing and error without utterances, and treats an unknown status as an error", async () => {
    for (const status of ["queued", "processing", "error"]) {
      reply.body = { status, utterances: [{ speaker: "A", text: "ignore", start: 0, end: 1 }] };
      expect(await client().getTranscript("tr_1")).toEqual({ status });
    }
    reply.body = { status: "weird" };
    expect(await client().getTranscript("tr_1")).toEqual({ status: "error" });
  });

  it("deletes a transcript with DELETE", async () => {
    await client().deleteTranscript("tr_123");
    expect(calls[0].url).toBe("https://api.example.test/v2/transcript/tr_123");
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("errors carry only a status code, never the response body", async () => {
    reply = { ok: false, status: 400, body: { error: "audio says: Back home I was an accountant" } };
    const err = await client().getTranscript("tr_1").catch((e: Error) => e);
    expect((err as Error).message).toBe("AssemblyAI request failed (400).");
    expect((err as Error).message).not.toContain("accountant");
  });
});

describe("local stand-in transcriber", () => {
  let dir: string;
  let storage: LocalAudioStorage;
  const secret = "test-secret-with-enough-length";
  const ID = "3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c";
  const key = audioKeyFor(ID, "wav");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mock-transcribe-"));
    storage = new LocalAudioStorage(dir, secret, "http://localhost:3000");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const job = async (mock: MockTranscriptionClient) =>
    mock.createJob({
      audioUrl: await storage.createDownloadUrl(key, 3600),
      webhookUrl: "http://localhost:3000/api/webhooks/assemblyai",
      webhookHeaderName: "x-webhook-secret",
      webhookSecret: "s",
    });

  it("reports processing until ready, then the fixture transcript chosen by the marker inside the file (not its name)", async () => {
    await storage.put(key, Buffer.concat([Buffer.from("RIFF....WAVE"), Buffer.from("fixture-03-housing-conflict"), Buffer.alloc(100)]));
    const mock = new MockTranscriptionClient(storage, { delayMs: 150, autoWebhook: false });
    const { id } = await job(mock);
    expect(id).toMatch(/^mock-/);
    expect(await mock.getTranscript(id)).toEqual({ status: "processing" });
    await new Promise((r) => setTimeout(r, 200));
    const done = await mock.getTranscript(id);
    expect(done.status).toBe("completed");
    const expected = loadFixture(FIXTURE_NAMES.find((n) => n.startsWith("03"))!);
    expect(done.utterances!.map((u) => u.text)).toEqual(expected.map((u) => u.text));
    expect(done.utterances!.map((u) => u.speaker)).toEqual(expected.map((u) => (u.speaker === "counselor" ? "A" : "B")));
    expect(done.utterances![0]).toMatchObject({ start_ms: 0, end_ms: 5500 });
  });

  it("without a marker it still returns one of the fictional transcripts, the same one for the same bytes", async () => {
    await storage.put(key, Buffer.from("not really audio, no marker here"));
    const mock = new MockTranscriptionClient(storage, { delayMs: 0, autoWebhook: false });
    const a = await mock.getTranscript((await job(mock)).id);
    const b = await mock.getTranscript((await job(mock)).id);
    expect(a.status).toBe("completed");
    expect(a.utterances!.length).toBeGreaterThan(5);
    expect(b.utterances).toEqual(a.utterances);
  });

  it("calls the webhook with the secret header and only a transcript id and status", async () => {
    await storage.put(key, Buffer.from("fixture-01"));
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const mock = new MockTranscriptionClient(storage, {
      delayMs: 20,
      fetchFn: (async (url: string, init: RequestInit) => {
        sent.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const { id } = await job(mock);
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://localhost:3000/api/webhooks/assemblyai");
    expect((sent[0].init.headers as Record<string, string>)["x-webhook-secret"]).toBe("s");
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ transcript_id: id, status: "completed" });
  });

  it("deleting removes the job, and an unknown job reports an error", async () => {
    await storage.put(key, Buffer.from("fixture-02"));
    const mock = new MockTranscriptionClient(storage, { delayMs: 0, autoWebhook: false });
    const { id } = await job(mock);
    await mock.deleteTranscript(id);
    expect(await mock.getTranscript(id)).toEqual({ status: "error" });
    await expect(mock.getTranscript("../../etc/passwd")).resolves.toEqual({ status: "error" }); // bad ids never touch the disk
  });

  it("refuses anything but a local audio link", async () => {
    const mock = new MockTranscriptionClient(storage, { autoWebhook: false });
    await expect(
      mock.createJob({ audioUrl: "https://example.com/other.wav", webhookUrl: "x", webhookHeaderName: "h", webhookSecret: "s" }),
    ).rejects.toThrow();
  });
});

describe("transcription settings", () => {
  it("the mock transcriber is impossible to use in a production build", () => {
    expect(() => assertTranscriptionSafe({ TRANSCRIPTION_MODE: "mock", NODE_ENV: "production" } as never)).toThrow(/not allowed in a production build/);
    expect(() => assertTranscriptionSafe({ NODE_ENV: "production" } as never)).toThrow(); // mock is the default
    expect(() => assertTranscriptionSafe({ TRANSCRIPTION_MODE: "assemblyai", NODE_ENV: "production" } as never)).not.toThrow();
    expect(() => assertTranscriptionSafe({ TRANSCRIPTION_MODE: "mock", NODE_ENV: "development" } as never)).not.toThrow();
  });
});
