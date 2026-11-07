import { AssemblyAiClient } from "./assemblyai";
import { MockTranscriptionClient } from "./mock";
import { LocalAudioStorage, getAudioStorage } from "../storage";
import type { TranscriptionClient } from "./types";

export type { TranscriptionClient } from "./types";
export { WEBHOOK_HEADER_NAME } from "./types";

/** Throws if the local stand-in is switched on in a production build. Never allowed. */
export function assertTranscriptionSafe(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.TRANSCRIPTION_MODE ?? "mock") === "mock" && env.NODE_ENV === "production") {
    throw new Error("TRANSCRIPTION_MODE=mock is not allowed in a production build. Use TRANSCRIPTION_MODE=assemblyai.");
  }
}

/** TRANSCRIPTION_MODE=mock (default, local only) or assemblyai. */
export function createTranscriptionClient(env: NodeJS.ProcessEnv = process.env): TranscriptionClient {
  assertTranscriptionSafe(env);
  const mode = env.TRANSCRIPTION_MODE ?? "mock";
  if (mode === "assemblyai") return new AssemblyAiClient(env.ASSEMBLYAI_API_KEY ?? "");
  if (mode === "mock") {
    const storage = getAudioStorage();
    if (!(storage instanceof LocalAudioStorage)) {
      throw new Error("TRANSCRIPTION_MODE=mock needs STORAGE_MODE=local.");
    }
    return new MockTranscriptionClient(storage);
  }
  throw new Error(`Unknown TRANSCRIPTION_MODE "${mode}". Use "mock" or "assemblyai".`);
}

let shared: TranscriptionClient | undefined;
export function getTranscriptionClient(): TranscriptionClient {
  shared ??= createTranscriptionClient();
  return shared;
}
