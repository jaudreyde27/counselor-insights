import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidAudioKey } from "./audio-types";
import type { AudioStorage } from "./types";

type Method = "PUT" | "GET";

/**
 * Local stand-in for the private S3 bucket, for development only. Files go into a git-ignored
 * folder. The "presigned URLs" are real signed links to this app (see
 * src/app/api/local-storage/[...key]/route.ts): they carry an expiry and a signature, so they work
 * like S3's, and an expired or tampered link is refused.
 */
export class LocalAudioStorage implements AudioStorage {
  constructor(
    readonly dir: string,
    private secret: string,
    private baseUrl: string,
    private now: () => number = Date.now,
  ) {
    if (secret.length < 16) throw new Error("LOCAL_STORAGE_SECRET must be at least 16 characters.");
  }

  private sign(method: Method, key: string, exp: number, contentType: string): string {
    return createHmac("sha256", this.secret).update(`${method}\n${key}\n${exp}\n${contentType}`).digest("hex");
  }

  private url(method: Method, key: string, seconds: number, contentType = ""): string {
    const exp = Math.floor(this.now() / 1000) + seconds;
    const q = new URLSearchParams({ exp: String(exp), sig: this.sign(method, key, exp, contentType) });
    if (contentType) q.set("ct", contentType);
    return `${this.baseUrl}/api/local-storage/${key}?${q}`;
  }

  async createUploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    this.assertKey(key);
    return this.url("PUT", key, expiresInSeconds, contentType);
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    this.assertKey(key);
    return this.url("GET", key, expiresInSeconds);
  }

  /** Used by the route: is this link genuine and not expired? */
  verify(method: Method, key: string, exp: string | null, contentType: string, sig: string | null): boolean {
    if (!isValidAudioKey(key) || !exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < Math.floor(this.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(method, key, Number(exp), contentType), "hex");
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private assertKey(key: string) {
    if (!isValidAudioKey(key)) throw new Error("Invalid audio key.");
  }

  private file(key: string): string {
    this.assertKey(key); // only audio/<uuid>.<ext>, so no path tricks
    return path.join(this.dir, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, bytes);
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(key));
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.file(key))).isFile();
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
