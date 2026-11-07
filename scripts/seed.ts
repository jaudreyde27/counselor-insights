// Usage: npm run db:seed            (adds demo data for the first dev counselor if they have none)
//        npm run db:seed -- --reset (clears the dev counselors' students first, then re-adds)
//
// Everything here is FICTIONAL: made-up students and the fictional
// fixture transcripts analysed by the mock AI. Needs the local database (npm run db:up, npm run db:migrate).
import { readFileSync } from "node:fs";
import path from "node:path";
import { runAnalysisForSession } from "../src/lib/analysis/run";
import { DEV_COUNSELORS } from "../src/lib/auth/dev";
import { loadCriteria } from "../src/lib/criteria";
import { createPastedSession } from "../src/lib/data/sessions";
import { createStudent } from "../src/lib/data/students";
import { findOrCreateCounselor, getPool, withCounselor } from "../src/lib/db";
import { MockLlmClient } from "../src/lib/llm/mock";

try {
  process.loadEnvFile(".env");
} catch {
  // rely on the environment
}

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.resolve("fixtures/transcripts", name), "utf8")) as Array<{
    speaker: "counselor" | "student";
    text: string;
  }>;

const DEMO = [
  {
    student: { full_name: "Daniel Okoye", school: "Stanford School of Engineering", degree_type: "masters", program_of_study: "Computer Science", country_of_origin: "Nigeria", notes: "Wants to become a software engineer after graduating. Prefers morning appointments." },
    sessions: [
      { date: "2026-10-14", file: "01-homesickness-career.json" },
      { date: "2026-11-04", file: "03-housing-conflict.json" },
    ],
  },
  {
    student: { full_name: "Sofia Marín", school: "Stanford Graduate School of Business", degree_type: "masters", program_of_study: "MBA", country_of_origin: "Colombia", notes: "Hopes to start a company back in Latin America. Still settling in during the first year." },
    sessions: [{ date: "2026-11-02", file: "02-visa-fear.json" }],
  },
  {
    student: { full_name: "Rahim Hussain", school: "Stanford Undergraduate", degree_type: "bachelors", program_of_study: "Economics", country_of_origin: "Bangladesh", notes: "Wants a career in economic policy. Plays on the cricket club team." },
    sessions: [
      { date: "2026-10-20", file: "04-theme-outside-taxonomy.json" },
      { date: "2026-11-05", file: "05-status-stated.json" },
    ],
  },
  {
    // No sessions yet: shows the "nothing analyzed yet" state.
    student: { full_name: "Priya Nair", school: "Stanford School of Medicine", degree_type: "masters", program_of_study: "Biomedical Informatics", country_of_origin: "India", notes: "Wants to work in clinical research. Arrived this term and is still finding housing." },
    sessions: [],
  },
] as const;

async function main() {
  const [first] = DEV_COUNSELORS;
  // Make sure both fake counselors exist (the second one is left empty, to show the empty state).
  for (const d of DEV_COUNSELORS) await findOrCreateCounselor(d.sub, d.email, d.displayName);
  const counselorId = await findOrCreateCounselor(first.sub, first.email, first.displayName);

  if (process.argv.includes("--reset")) {
    await withCounselor(counselorId, (c) => c.query("DELETE FROM students"));
    console.log("Cleared existing students.");
  }
  const existing = await withCounselor(counselorId, async (c) => (await c.query("SELECT count(*)::int AS n FROM students")).rows[0].n);
  if (existing > 0) {
    console.log(`${first.displayName} already has ${existing} student(s). Use --reset to start over.`);
    return;
  }

  const criteria = loadCriteria();
  const llm = new MockLlmClient();
  for (const d of DEMO) {
    const studentId = await withCounselor(counselorId, (c) => createStudent(c, counselorId, { ...d.student }));
    for (const s of d.sessions) {
      const sessionId = await withCounselor(counselorId, (c) =>
        createPastedSession(c, { counselorId, studentId, sessionDate: s.date, utterances: fixture(s.file) }),
      );
      const out = await runAnalysisForSession(counselorId, sessionId, { llm, criteria });
      console.log(`  ${d.student.full_name} · ${s.date} · ${s.file} -> ${out.status}`);
    }
  }
  console.log("Done. Start the app with: npm run dev");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
