import { BedrockLlmClient } from "./bedrock";
import { MockLlmClient } from "./mock";
import type { LlmClient } from "./types";

export type { LlmClient, LlmRequest } from "./types";

/**
 * Picks the model client from the environment.
 *   LLM_MODE=mock          -> fake canned results, no network (the default for local work)
 *   LLM_PROVIDER=bedrock   -> Claude on Amazon Bedrock (needs AWS, later phases)
 */
export function assertLlmSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (env.LLM_MODE === "mock" && env.NODE_ENV === "production") {
    throw new Error("LLM_MODE=mock is not allowed in a production build (it returns made-up analyses).");
  }
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient {
  assertLlmSafe(env);
  if (env.LLM_MODE === "mock") return new MockLlmClient();
  const provider = env.LLM_PROVIDER ?? "bedrock";
  if (provider === "bedrock") return new BedrockLlmClient(env.BEDROCK_MODEL_ID ?? "");
  throw new Error(`Unknown LLM_PROVIDER "${provider}". Only "bedrock" is built.`);
}

/** Low temperature by default (SPEC.md 6.5). Configurable with LLM_TEMPERATURE. */
export function llmTemperature(env: NodeJS.ProcessEnv = process.env): number {
  const t = Number(env.LLM_TEMPERATURE ?? 0.1);
  return Number.isFinite(t) && t >= 0 && t <= 1 ? t : 0.1;
}
