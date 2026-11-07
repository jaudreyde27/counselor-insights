import path from "node:path";
import { LocalAudioStorage } from "./local";
import { S3AudioStorage } from "./s3";
import type { AudioStorage } from "./types";

export type { AudioStorage } from "./types";
export { LocalAudioStorage } from "./local";

/** Public address of this app, used to build links (and the webhook address AssemblyAI calls). */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Throws if the local stand-in is switched on in a production build. Never allowed. */
export function assertStorageSafe(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.STORAGE_MODE ?? "local") === "local" && env.NODE_ENV === "production") {
    throw new Error("STORAGE_MODE=local is not allowed in a production build. Use STORAGE_MODE=s3.");
  }
}

/** Builds the storage the environment asks for: STORAGE_MODE=local (default) or s3. */
export function createAudioStorage(env: NodeJS.ProcessEnv = process.env): AudioStorage {
  assertStorageSafe(env);
  const mode = env.STORAGE_MODE ?? "local";
  if (mode === "s3") return new S3AudioStorage(env.S3_AUDIO_BUCKET ?? "");
  if (mode === "local") {
    const secret = env.LOCAL_STORAGE_SECRET;
    if (!secret) throw new Error("LOCAL_STORAGE_SECRET is not set. See .env.example.");
    return new LocalAudioStorage(path.resolve(/* turbopackIgnore: true */ env.LOCAL_STORAGE_DIR ?? ".local-audio"), secret, appBaseUrl(env));
  }
  throw new Error(`Unknown STORAGE_MODE "${mode}". Use "local" or "s3".`);
}

let shared: AudioStorage | undefined;
/** The app-wide storage, created once. */
export function getAudioStorage(): AudioStorage {
  shared ??= createAudioStorage();
  return shared;
}
