/** One structured-output request. Prompts, schemas and verification don't depend on the provider. */
export interface LlmRequest {
  /** "report_themes" (call 1) or "report_recommendations" (call 2). */
  schemaName: "report_themes" | "report_recommendations";
  /** System prompt, loaded from prompts/. */
  system: string;
  /** User message: JSON containing only transcript text or earlier verified themes. */
  user: string;
  /** JSON Schema the reply must follow. */
  jsonSchema: Record<string, unknown>;
  temperature: number;
}

export interface LlmClient {
  /** Recorded on every analysis run so results can be reproduced. */
  readonly modelId: string;
  /** Returns the model's structured reply, not yet validated. */
  completeJson(req: LlmRequest): Promise<unknown>;
}
