// Usage: npm run analyze -- <path-to-transcript.json> [--json]
//
// Runs analysis calls 1 and 2 on a transcript fixture WITHOUT touching the
// database or the UI, and prints the verified result.
// Fixture format: a JSON array of { "speaker": "counselor" | "student", "text": "..." }.
// Uses LLM_MODE=mock (the default in .env.example) unless you configure Bedrock.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { analyzeTranscript } from "../src/lib/analysis/analyze";
import type { AnalysisResult, Utterance } from "../src/lib/analysis/types";
import { loadCriteria } from "../src/lib/criteria";
import { createLlmClient } from "../src/lib/llm";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on variables already in the environment.
}

const fixtureSchema = z.array(z.object({ speaker: z.enum(["counselor", "student"]), text: z.string().min(1) })).min(1);

function printReadable(result: AnalysisResult, utterances: Utterance[], criteria: ReturnType<typeof loadCriteria>) {
  const lineOf = (id: string) => utterances.findIndex((u) => u.id === id) + 1;
  const out: string[] = [];

  out.push(`THEMES (${result.themes.length})`);
  for (const t of result.themes) {
    const domain = criteria.domain(t.domain_id)?.label ?? "Other";
    const sub = criteria.subDriver(t.sub_driver_id)?.label ?? t.other_label ?? "Other";
    out.push(`\n[${domain} > ${sub}] ${t.title}`);
    out.push(`  ${t.interpretation}`);
    for (const e of t.evidence) out.push(`  line ${lineOf(e.utterance_id)}: "${e.quote}"`);
  }

  out.push(`\nRECOMMENDATIONS (${result.recommendations.length})`);
  for (const r of result.recommendations) {
    out.push(`\n* ${r.topic}`);
    out.push(`  Conversation starter: ${r.open_question}`);
    out.push(`  Suggested approach: ${r.suggested_approach}`);
  }
  if (result.changes_since_earlier_sessions.length) {
    out.push("\nCHANGES SINCE EARLIER SESSIONS");
    for (const c of result.changes_since_earlier_sessions) out.push(`- ${c}`);
  }
  out.push(
    `\nChecks: ${result.dropped_quote_count} quote(s) failed verification, ` +
      `${result.dropped_theme_count} theme(s) and ${result.dropped_recommendation_count} recommendation(s) dropped.`,
  );
  console.log(out.join("\n"));
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run analyze -- <path-to-transcript.json> [--json]");
    process.exit(1);
  }

  const lines = fixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const utterances: Utterance[] = lines.map((l, i) => ({ id: `u${i + 1}`, speaker: l.speaker, text: l.text }));
  const criteria = loadCriteria();
  const llm = createLlmClient();

  if (process.env.LLM_MODE === "mock") console.error("(Using the mock AI: canned results, no network.)");
  const result = await analyzeTranscript({ utterances }, { llm, criteria });

  if (asJson) console.log(JSON.stringify(result, null, 2));
  else printReadable(result, utterances, criteria);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
