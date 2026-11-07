import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Criteria } from "../criteria";
import { OTHER_SUB_DRIVER_ID } from "../criteria";
import { llmTemperature, type LlmClient, type LlmRequest } from "../llm";
import { logEvent } from "../log";
import { call1SystemPrompt, call2SystemPrompt, promptVersion } from "./prompts";
import { mentionsImmigrationStatus } from "./status-guard";
import {
  call1Schema,
  call2Schema,
  type AnalysisResult,
  type EarlierTheme,
  type Utterance,
  type VerifiedRecommendation,
  type VerifiedTheme,
} from "./types";
import { verifyEvidence } from "./verify";

export interface AnalyzeDeps {
  llm: LlmClient;
  criteria: Criteria;
  /** Defaults to PROMPT_VERSION from the environment. */
  promptVersion?: string;
  /** Defaults to LLM_TEMPERATURE from the environment (low). */
  temperature?: number;
}

export interface AnalyzeInput {
  /** This session's stored utterances. The only student content the model sees. */
  utterances: Utterance[];
  /** Verified themes from earlier sessions of the same student (no quotes, no student details). */
  earlierThemes?: EarlierTheme[];
}

export class AnalysisError extends Error {
  constructor(
    readonly code: "call1_invalid_output" | "call2_invalid_output",
    message: string,
  ) {
    super(message);
  }
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema; // tool input schemas don't take the draft marker
  return json;
}

/** Calls the model, validates the reply, and retries once if it does not match the schema. */
async function callValidated<S extends z.ZodType>(
  llm: LlmClient,
  req: LlmRequest,
  schema: S,
  failCode: AnalysisError["code"],
): Promise<z.infer<S>> {
  let user = req.user;
  let lastProblem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.completeJson({ ...req, user });
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Only field paths and rule names go back to the model, never any content.
    lastProblem = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ");
    logEvent("llm_invalid_output", { schema: req.schemaName, attempt: attempt + 1 });
    user = `${req.user}\n\nYour previous reply did not match the required structure (${lastProblem}). Reply again, following the structure exactly.`;
  }
  throw new AnalysisError(failCode, `The model's reply did not match the required structure after one retry.`);
}

/**
 * Runs call 1 (themes), verifies every quote in code, then runs
 * call 2 (recommendations) on the verified themes. Touches no database and no UI,
 * so it can be used by `npm run analyze` and by evals.
 */
export async function analyzeTranscript(input: AnalyzeInput, deps: AnalyzeDeps): Promise<AnalysisResult> {
  const { llm, criteria } = deps;
  const version = deps.promptVersion ?? promptVersion();
  const temperature = deps.temperature ?? llmTemperature();
  const earlier = input.earlierThemes ?? [];

  // ---- Call 1: themes. Input: utterances only. ----
  const call1 = await callValidated(
    llm,
    {
      schemaName: "report_themes",
      system: call1SystemPrompt(criteria, version),
      user: JSON.stringify({
        utterances: input.utterances.map((u) => ({ id: u.id, speaker: u.speaker, text: u.text })),
      }),
      jsonSchema: jsonSchemaFor(call1Schema),
      temperature,
    },
    call1Schema,
    "call1_invalid_output",
  );

  // ---- Verification, in code (SPEC.md 6.3) ----
  let droppedQuotes = 0;
  let droppedThemes = 0;
  const themes: VerifiedTheme[] = [];

  for (const t of call1.themes) {
    const check = verifyEvidence(t.evidence, input.utterances);
    droppedQuotes += check.dropped.length;

    const sub = criteria.subDriver(t.sub_driver_id);
    const isOther = t.sub_driver_id === OTHER_SUB_DRIVER_ID;
    const otherLabel = isOther ? t.other_label?.trim() || "Other" : null;
    const wording = [t.title, t.interpretation, otherLabel ?? ""].join(" ");

    if ((!sub && !isOther) || check.kept.length === 0 || mentionsImmigrationStatus(wording)) {
      droppedThemes++;
      continue;
    }
    themes.push({
      id: randomUUID(),
      sub_driver_id: t.sub_driver_id,
      domain_id: sub ? sub.domain_id : OTHER_SUB_DRIVER_ID,
      other_label: otherLabel,
      title: t.title,
      interpretation: t.interpretation,
      evidence: check.kept,
    });
  }

  logEvent("analysis_call1_done", {
    themes: themes.length,
    dropped_quotes: droppedQuotes,
    dropped_themes: droppedThemes,
  });

  // ---- Call 2: recommendations. Input: verified themes only. ----
  let recommendations: VerifiedRecommendation[] = [];
  let changes: string[] = [];
  let droppedRecs = 0;

  if (themes.length > 0) {
    const domainLabel = (id: string) => criteria.domain(id)?.label ?? "Other";
    const subLabel = (t: { sub_driver_id: string; other_label: string | null }) =>
      criteria.subDriver(t.sub_driver_id)?.label ?? t.other_label ?? "Other";

    const call2 = await callValidated(
      llm,
      {
        schemaName: "report_recommendations",
        system: call2SystemPrompt(version),
        user: JSON.stringify({
          this_session: themes.map((t) => ({
            theme_id: t.id,
            domain: domainLabel(t.domain_id),
            sub_driver: subLabel(t),
            title: t.title,
            interpretation: t.interpretation,
            quote: t.evidence[0].quote,
          })),
          earlier_sessions: earlier.map((e) => ({
            session_date: e.session_date,
            domain: domainLabel(e.domain_id),
            sub_driver: subLabel(e),
            title: e.title,
            interpretation: e.interpretation,
          })),
        }),
        jsonSchema: jsonSchemaFor(call2Schema),
        temperature,
      },
      call2Schema,
      "call2_invalid_output",
    );

    const realIds = new Set(themes.map((t) => t.id));
    for (const r of call2.recommendations) {
      const ids = [...new Set(r.based_on_theme_ids)];
      const wording = [r.topic, r.open_question, r.suggested_approach].join(" ");
      if (ids.length === 0 || !ids.every((id) => realIds.has(id)) || mentionsImmigrationStatus(wording)) {
        droppedRecs++;
        continue;
      }
      recommendations.push({ ...r, based_on_theme_ids: ids });
    }
    recommendations = recommendations.slice(0, 2); // at most two, the most important first
    changes =
      earlier.length === 0 // a first session has no earlier sessions to compare with
        ? []
        : call2.changes_since_earlier_sessions.map((c) => c.trim()).filter((c) => c && !mentionsImmigrationStatus(c));
  }

  logEvent("analysis_call2_done", { recommendations: recommendations.length, dropped_recommendations: droppedRecs });

  return {
    themes,
    recommendations,
    changes_since_earlier_sessions: changes,
    dropped_quote_count: droppedQuotes,
    dropped_theme_count: droppedThemes,
    dropped_recommendation_count: droppedRecs,
  };
}
