#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { buildConfig } from "../lib/config";
import { CounselorInsightsStack } from "../lib/stack";

// Entry point for `cdk synth`, `cdk diff` and `cdk deploy`. Settings come in as context:
//   cdk deploy -c alertEmail=you@example.com -c cognitoDomainPrefix=my-team-counseling -c bedrockModelId=us.anthropic...
// See docs/AWS_SETUP.md for the full list. Missing or bad settings stop here with a plain message.
const app = new App();
const config = buildConfig((k) => app.node.tryGetContext(k));

new CounselorInsightsStack(app, "CounselorInsights", {
  config,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: "Counselor Insights prototype (class project). Deactivates after " + config.activeUntil + ".",
});
