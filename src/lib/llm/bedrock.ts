import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { LlmClient, LlmRequest } from "./types";

/**
 * Builds the exact payload sent to Bedrock (Converse API). Kept as a pure
 * function so a test can check that nothing but the prompt and transcript text
 * is in it. Forces a tool call so the reply has the JSON shape we need.
 * Bedrock prompt and response logging stays off (an AWS account setting).
 */
export function buildConverseInput(modelId: string, req: LlmRequest): ConverseCommandInput {
  return {
    modelId,
    system: [{ text: req.system }],
    messages: [{ role: "user", content: [{ text: req.user }] }],
    inferenceConfig: { temperature: req.temperature, maxTokens: 4096 },
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: req.schemaName,
            description: "Report the result in exactly this structure.",
            inputSchema: { json: req.jsonSchema as never },
          },
        },
      ],
      toolChoice: { tool: { name: req.schemaName } },
    },
  };
}

/**
 * Claude on Amazon Bedrock. NOT yet exercised against real AWS: Phase 1 runs on
 * the mock. Needs AWS credentials, a region with the model, and BEDROCK_MODEL_ID
 * set to a US-only inference profile id (never a "global" one).
 */
export class BedrockLlmClient implements LlmClient {
  private client: BedrockRuntimeClient;

  constructor(
    readonly modelId: string,
    region = process.env.AWS_REGION ?? "us-east-2",
  ) {
    if (!modelId) throw new Error("BEDROCK_MODEL_ID is not set. See .env.example.");
    if (/(^|\.)global\./i.test(modelId)) {
      throw new Error("Use a US-only inference profile, not a global one (SPEC.md section 3).");
    }
    this.client = new BedrockRuntimeClient({ region });
  }

  async completeJson(req: LlmRequest): Promise<unknown> {
    const out = await this.client.send(new ConverseCommand(buildConverseInput(this.modelId, req)));
    const blocks = out.output?.message?.content ?? [];
    const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
    if (!toolUse) throw new Error("Model reply had no structured result.");
    return toolUse.input;
  }
}
