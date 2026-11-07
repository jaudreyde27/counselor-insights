import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertStorageSafe, createAudioStorage, LocalAudioStorage } from "@/lib/storage";
import { audioKeyFor, audioTypeFor, extensionOf, isValidAudioKey } from "@/lib/storage/audio-types";

const ID = "3f1c2a9e-5b7d-4c1e-9a2b-1d2e3f4a5b6c";
const SECRET = "test-secret-with-enough-length";

describe("accepted recordings", () => {
  it("accepts mp3, m4a and wav, and returns one canonical content type for each", () => {
    expect(audioTypeFor("mp3", "audio/mpeg")).toEqual({ ext: "mp3", contentType: "audio/mpeg" });
    expect(audioTypeFor(".M4A", "audio/x-m4a")).toEqual({ ext: "m4a", contentType: "audio/mp4" });
    expect(audioTypeFor("m4a", "audio/mp4")).toEqual({ ext: "m4a", contentType: "audio/mp4" });
    expect(audioTypeFor("wav", "audio/x-wav")).toEqual({ ext: "wav", contentType: "audio/wav" });
    expect(audioTypeFor("wav", "")).toEqual({ ext: "wav", contentType: "audio/wav" }); // some browsers report no type
  });

  it("rejects other extensions and a type that does not match the extension", () => {
    for (const [ext, mime] of [["flac", "audio/flac"], ["ogg", ""], ["exe", "application/octet-stream"], ["mp3", "video/mp4"], ["wav", "audio/mpeg"], ["", ""]]) {
      expect(audioTypeFor(ext, mime), `${ext} ${mime}`).toBeNull();
    }
  });

  it("reads the extension from a file name", () => {
    expect(extensionOf("Interview Priya.WAV")).toBe("wav");
    expect(extensionOf("noextension")).toBe("");
  });

  it("builds keys from the session id only: no names", () => {
    const key = audioKeyFor(ID, "m4a");
    expect(key).toBe(`audio/${ID}.m4a`);
    expect(isValidAudioKey(key)).toBe(true);
    for (const bad of ["audio/Priya Nair.wav", "audio/../.env", `audio/${ID}.exe`, `other/${ID}.wav`, `audio/${ID}.wav/extra`, "/etc/passwd", `audio/${ID}`]) {
      expect(isValidAudioKey(bad), bad).toBe(false);
    }
  });
});

describe("local storage and its signed links (stand-in for S3 presigned URLs)", () => {
  let dir: string;
  let now: number;
  let storage: LocalAudioStorage;
  const key = audioKeyFor(ID, "wav");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audio-test-"));
    now = Date.UTC(2026, 10, 7, 12, 0, 0);
    storage = new LocalAudioStorage(dir, SECRET, "http://localhost:3000", () => now);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const parts = (url: string) => {
    const u = new URL(url);
    return { key: u.pathname.replace("/api/local-storage/", ""), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig"), ct: u.searchParams.get("ct") ?? "" };
  };

  it("an upload link expires after 15 minutes and works until then", async () => {
    const { exp, sig, ct, key: k } = parts(await storage.createUploadUrl(key, "audio/wav", 15 * 60));
    expect(k).toBe(key);
    expect(Number(exp) - Math.floor(now / 1000)).toBe(900);
    expect(storage.verify("PUT", key, exp, ct, sig)).toBe(true);
    now += 14 * 60 * 1000;
    expect(storage.verify("PUT", key, exp, ct, sig)).toBe(true);
    now += 2 * 60 * 1000;
    expect(storage.verify("PUT", key, exp, ct, sig)).toBe(false); // expired
  });

  it("a download link lasts 1 hour", async () => {
    const { exp, sig } = parts(await storage.createDownloadUrl(key, 3600));
    expect(Number(exp) - Math.floor(now / 1000)).toBe(3600);
    expect(storage.verify("GET", key, exp, "", sig)).toBe(true);
  });

  it("rejects a tampered link: other key, other method, other content type, other expiry, other secret, no signature", async () => {
    const { exp, sig, ct } = parts(await storage.createUploadUrl(key, "audio/wav", 900));
    const otherKey = audioKeyFor("00000000-0000-4000-8000-000000000000", "wav");
    expect(storage.verify("PUT", otherKey, exp, ct, sig)).toBe(false);
    expect(storage.verify("GET", key, exp, "", sig)).toBe(false); // an upload link cannot be used to download
    expect(storage.verify("PUT", key, exp, "audio/mpeg", sig)).toBe(false);
    expect(storage.verify("PUT", key, String(Number(exp) + 1000), ct, sig)).toBe(false);
    expect(storage.verify("PUT", key, exp, ct, "0".repeat(64))).toBe(false);
    expect(storage.verify("PUT", key, exp, ct, null)).toBe(false);
    expect(storage.verify("PUT", key, null, ct, sig)).toBe(false);
    expect(storage.verify("PUT", "audio/../x.wav", exp, ct, sig)).toBe(false);
    const other = new LocalAudioStorage(dir, "a-completely-different-secret", "http://localhost:3000", () => now);
    expect(other.verify("PUT", key, exp, ct, sig)).toBe(false);
  });

  it("refuses to make links for keys that are not audio/<session id>.<ext>", async () => {
    await expect(storage.createUploadUrl("audio/Priya.wav", "audio/wav", 900)).rejects.toThrow();
    await expect(storage.createDownloadUrl("../../etc/passwd", 900)).rejects.toThrow();
  });

  it("stores, finds, reads and deletes a file (and deleting a missing file is not an error)", async () => {
    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, Buffer.from("hello"));
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.read(key))?.toString()).toBe("hello");
    await storage.remove(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.remove(key)).resolves.toBeUndefined();
    expect(await storage.read(key)).toBeNull();
  });

  it("will not start with a weak signing secret", () => {
    expect(() => new LocalAudioStorage(dir, "short", "http://localhost:3000")).toThrow(/at least 16/);
  });
});

describe("storage settings", () => {
  it("the local stand-in is impossible to use in a production build", () => {
    expect(() => assertStorageSafe({ STORAGE_MODE: "local", NODE_ENV: "production" } as never)).toThrow(/not allowed in a production build/);
    expect(() => assertStorageSafe({ NODE_ENV: "production" } as never)).toThrow(); // local is the default, so also refused
    expect(() => assertStorageSafe({ STORAGE_MODE: "s3", NODE_ENV: "production" } as never)).not.toThrow();
    expect(() => assertStorageSafe({ STORAGE_MODE: "local", NODE_ENV: "development" } as never)).not.toThrow();
  });

  it("builds local storage in development and needs its secret", () => {
    expect(createAudioStorage({ STORAGE_MODE: "local", LOCAL_STORAGE_SECRET: SECRET, NODE_ENV: "development" } as never)).toBeInstanceOf(LocalAudioStorage);
    expect(() => createAudioStorage({ STORAGE_MODE: "local", NODE_ENV: "development" } as never)).toThrow(/LOCAL_STORAGE_SECRET/);
    expect(() => createAudioStorage({ STORAGE_MODE: "s3", S3_AUDIO_BUCKET: "", NODE_ENV: "development" } as never)).toThrow(/S3_AUDIO_BUCKET/);
    expect(() => createAudioStorage({ STORAGE_MODE: "ftp", NODE_ENV: "development" } as never)).toThrow(/Unknown STORAGE_MODE/);
  });
});

import { assertLlmSafe } from "@/lib/llm";
import { sslOption } from "@/lib/db-config";

describe("more production safety rules", () => {
  it("the mock AI is impossible to use in a production build", () => {
    expect(() => assertLlmSafe({ LLM_MODE: "mock", NODE_ENV: "production" } as never)).toThrow(/not allowed in a production build/);
    expect(() => assertLlmSafe({ LLM_MODE: "mock", NODE_ENV: "development" } as never)).not.toThrow();
    expect(() => assertLlmSafe({ NODE_ENV: "production" } as never)).not.toThrow();
  });

  it("DB_SSL=require turns on an encrypted database connection; otherwise it is off", () => {
    expect(sslOption({ DB_SSL: "require" } as never)).toEqual({ rejectUnauthorized: false });
    expect(sslOption({} as never)).toBeUndefined();
    expect(sslOption({ DB_SSL: "off" } as never)).toBeUndefined();
  });
});
