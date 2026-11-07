/**
 * When this prototype stops working.
 *
 * It is a class project (due December 2, 2026) and is switched off after December 15, 2026. From the
 * end of that day, Pacific time, every page, form and upload is refused, nobody can sign in, and no
 * student data is shown (see src/proxy.ts). The date can be changed with APP_ACTIVE_UNTIL (a
 * YYYY-MM-DD date, active through the END of that day); if it is not set the default below applies,
 * so the app cannot accidentally stay on forever. A malformed value switches the app OFF (it fails
 * closed), never on.
 *
 * This stops the app responding. It does NOT stop AWS charges or delete any data: see docs/SHUTDOWN.md.
 * No framework imports, so the rule can be tested directly.
 */
export const DEFAULT_ACTIVE_UNTIL = "2026-12-15";
export const APP_TIME_ZONE = "America/Los_Angeles";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, "tomorrow"). */
export function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** The last day the app is active (YYYY-MM-DD), or null if the setting is malformed. */
export function activeUntil(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.APP_ACTIVE_UNTIL ?? DEFAULT_ACTIVE_UNTIL).trim();
  return isValidDate(raw) ? raw : null;
}

/** Today's calendar date in Pacific time, as YYYY-MM-DD. Daylight-saving safe. */
export function pacificDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** True while the prototype is allowed to run. Active through the end of the last day, Pacific time. */
export function isAppActive(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): boolean {
  const last = activeUntil(env);
  if (!last) return false; // a malformed date switches the app off
  return pacificDate(now) <= last; // YYYY-MM-DD strings compare in date order
}

/** "December 15, 2026" for the notice page. */
export function formatEndDate(env: NodeJS.ProcessEnv = process.env): string {
  const last = activeUntil(env) ?? DEFAULT_ACTIVE_UNTIL;
  const [y, m, d] = last.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The page shown to everyone once the prototype has ended. Plain, no student data, not indexed. */
export function endedPageHtml(env: NodeJS.ProcessEnv = process.env): string {
  const end = formatEndDate(env);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Prototype ended</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#faf9f7;color:#1f2933;
       font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{display:flex;align-items:center;gap:8px;height:56px;padding:0 16px;background:#fff;border-bottom:1px solid #e4e7eb;font-weight:600;font-size:18px}
  .dot{width:14px;height:14px;border-radius:50%;background:#e8702a}
  main{flex:1;display:flex;align-items:center;justify-content:center;padding:24px 16px}
  .card{max-width:30rem;background:#fff;border:1px solid #e4e7eb;border-radius:12px;padding:24px}
  .label{font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#c85a1b}
  h1{margin:4px 0 8px;font-size:24px}
  p{margin:0;font-size:14px;line-height:1.6;color:#5f6c7b}
  footer{padding:12px;text-align:center;font-size:12px;color:#5f6c7b;background:#fff;border-top:1px solid #e4e7eb}
</style>
</head>
<body>
<header><span class="dot"></span>International Student Counseling</header>
<main><div class="card">
<div class="label">Prototype ended</div>
<h1>This prototype has been switched off</h1>
<p>It was built for a class project and was deactivated after ${end}. Sign-in, uploads and all student information are no longer available here.</p>
</div></main>
<footer>Prototype</footer>
</body>
</html>`;
}
