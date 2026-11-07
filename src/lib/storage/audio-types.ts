/**
 * Which recordings are accepted, and how storage keys are built. No framework or Node imports,
 * so the browser form and the server share exactly the same rules.
 *
 * Accepted: audio/mpeg (.mp3), audio/mp4 and audio/x-m4a (.m4a), audio/wav (.wav).
 */
export const AUDIO_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
} as const;

export type AudioExt = keyof typeof AUDIO_TYPES;

// Browsers report these in slightly different ways for the same file.
const ACCEPTED_MIME: Record<AudioExt, string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
};

export function isAudioExt(ext: string): ext is AudioExt {
  return ext in AUDIO_TYPES;
}

/**
 * Checks a recording by its extension and (when the browser gives one) its type. Returns the
 * extension and the one canonical content type to upload with, or null if it is not accepted.
 * Only the extension is ever sent to the server, never the file name (a name could contain a
 * student's name).
 */
export function audioTypeFor(extension: string, mime: string): { ext: AudioExt; contentType: string } | null {
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (!isAudioExt(ext)) return null;
  const type = mime.toLowerCase().trim();
  if (type && !ACCEPTED_MIME[ext].includes(type)) return null;
  return { ext, contentType: AUDIO_TYPES[ext] };
}

/** "interview.M4A" -> "m4a". */
export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i < 0 ? "" : fileName.slice(i + 1).toLowerCase();
}

/** S3 key for a session's recording: no names, only the session id (SPEC.md step 1). */
export function audioKeyFor(sessionId: string, ext: AudioExt): string {
  return `audio/${sessionId}.${ext}`;
}

const KEY_PATTERN = /^audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|m4a|wav)$/;

export function isValidAudioKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export const UPLOAD_URL_SECONDS = 15 * 60; // the upload link lasts 15 minutes
export const DOWNLOAD_URL_SECONDS = 60 * 60; // the link AssemblyAI uses lasts 1 hour
