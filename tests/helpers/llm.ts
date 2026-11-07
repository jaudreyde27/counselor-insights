import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Utterance } from "@/lib/analysis/types";
import type { LlmClient, LlmRequest } from "@/lib/llm";

export const FIXTURE_NAMES = readdirSync(path.resolve("fixtures/transcripts"))
  .filter((f) => f.endsWith(".json"))
  .sort();

/** Loads a fixture with simple ids u1, u2, ... */
export function loadFixture(name: string): Utterance[] {
  const lines = JSON.parse(readFileSync(path.resolve("fixtures/transcripts", name), "utf8")) as Array<{
    speaker: "counselor" | "student";
    text: string;
  }>;
  return lines.map((l, i) => ({ id: `u${i + 1}`, speaker: l.speaker, text: l.text }));
}

/** A fake model that returns whatever the test scripts, and records every request. */
export class ScriptedLlm implements LlmClient {
  readonly modelId = "scripted";
  readonly requests: LlmRequest[] = [];
  constructor(private replies: { report_themes?: unknown[]; report_recommendations?: unknown[] }) {}

  async completeJson(req: LlmRequest): Promise<unknown> {
    this.requests.push(req);
    const queue = this.replies[req.schemaName] ?? [];
    // Reuse the last scripted reply if the pipeline asks again (for example a retry).
    const idx = Math.min(this.requests.filter((r) => r.schemaName === req.schemaName).length - 1, queue.length - 1);
    return queue[idx];
  }
}

export const validCall2 = (themeId: string) => ({
  recommendations: [
    { topic: "t", open_question: "q?", suggested_approach: "a", based_on_theme_ids: [themeId] },
  ],
  changes_since_earlier_sessions: [],
});
