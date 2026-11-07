import { z } from "zod";

export type Speaker = "counselor" | "student";

/** One line of a transcript, as sent to the model and stored in the database. */
export interface Utterance {
  id: string;
  speaker: Speaker;
  text: string;
}

const evidenceSchema = z.object({
  utterance_id: z.string(),
  quote: z.string(),
});

/** What call 1 must return (themes only). Forced on the model through a tool schema, then validated again. */
export const call1Schema = z.object({
  themes: z.array(
    z.object({
      sub_driver_id: z.string().min(1),
      other_label: z.string().nullable(),
      title: z.string().min(1),
      interpretation: z.string().min(1),
      evidence: z.array(evidenceSchema).min(1),
    }),
  ),
});
export type Call1Output = z.infer<typeof call1Schema>;

/** What call 2 must return. */
export const call2Schema = z.object({
  recommendations: z.array(
    z.object({
      topic: z.string().min(1),
      open_question: z.string().min(1),
      suggested_approach: z.string().min(1),
      based_on_theme_ids: z.array(z.string()),
    }),
  ),
  changes_since_earlier_sessions: z.array(z.string()),
});
export type Call2Output = z.infer<typeof call2Schema>;

export interface Evidence {
  utterance_id: string;
  quote: string;
}

/** A theme that survived quote verification. `id` is assigned by us, not the model. */
export interface VerifiedTheme {
  id: string;
  sub_driver_id: string;
  /** Copied from the criteria config. "other" when the sub-driver is "other". */
  domain_id: string;
  other_label: string | null;
  title: string;
  interpretation: string;
  evidence: Evidence[];
}

export interface VerifiedRecommendation {
  topic: string;
  open_question: string;
  suggested_approach: string;
  based_on_theme_ids: string[];
}

/** Earlier-session theme passed to call 2 (no quotes, no student details). */
export interface EarlierTheme {
  session_date: string;
  sub_driver_id: string;
  domain_id: string;
  other_label: string | null;
  title: string;
  interpretation: string;
}

export interface AnalysisResult {
  themes: VerifiedTheme[];
  recommendations: VerifiedRecommendation[];
  changes_since_earlier_sessions: string[];
  /** Evidence items that failed verification. Saved on the run. */
  dropped_quote_count: number;
  /** Themes dropped for other reasons (no valid evidence, unknown sub-driver, status wording). */
  dropped_theme_count: number;
  dropped_recommendation_count: number;
}
