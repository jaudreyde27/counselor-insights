/**
 * Logging for the whole app. Log IDs and event names only, never transcripts,
 * quotes, names, schools, countries or notes (SPEC.md rule 5).
 *
 * The values are restricted on purpose: only short id-like strings, numbers and
 * booleans get through. Anything else (a sentence, a name with a space, a long
 * string) is replaced with "[redacted]" so a careless call can't leak text.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export function logEvent(event: string, fields: LogFields = {}): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string" && !SAFE_STRING.test(value)) safe[key] = "[redacted]";
    else safe[key] = value;
  }
  // stderr, so command output (like `npm run analyze -- file --json`) stays clean.
  process.stderr.write(JSON.stringify({ event, ...safe }) + "\n");
}
