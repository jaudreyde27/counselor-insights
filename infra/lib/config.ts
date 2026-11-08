/**
 * Settings for the deployment, passed as CDK context: `cdk deploy -c appHostname=... -c alertEmail=...`.
 * Nothing secret is ever a setting here: the AssemblyAI key and the webhook secret live in AWS
 * Secrets Manager (scripts/store-secret.sh). Every value is checked up front, with a plain message.
 */
export interface InfraConfig {
  /** The address the app lives at. */
  appHostname: string;
  /** Where alarm emails go. */
  alertEmail: string;
  /** Must be unique across all of AWS (the Cognito sign-in page address). */
  cognitoDomainPrefix: string;
  /** US-only Claude inference profile id from the Bedrock console. Never a "global" one. */
  bedrockModelId: string;
  /** Which image tag in the registry the app runs. The deploy workflow also pushes "latest". */
  imageTag: string;
  /** 1 normally. Use 0 for the very first deploy, before any image has been pushed. */
  desiredCount: 0 | 1;
  /** Last day the app is active (YYYY-MM-DD, Pacific). The app switches itself off after this day. */
  activeUntil: string;
  /** When the app server is scaled to zero (an exact moment, ISO 8601). Default: midnight Pacific after activeUntil. */
  scaleToZeroAt: string;
  region: string;
  /** "owner/name" of the GitHub repository allowed to deploy (optional until the repository exists). */
  githubRepo?: string;
  /** true: also create a deploy-only AWS user for GitHub Actions (for accounts that block the GitHub OIDC connection). */
  deployUser: boolean;
  /** If the AWS account already has a GitHub OIDC provider, its ARN (only one may exist per account). */
  githubOidcProviderArn?: string;
}

export const DEFAULTS = {
  appHostname: "studentcounseling.persimmon-care.com",
  imageTag: "latest",
  desiredCount: 1 as const,
  activeUntil: "2026-12-15",
  scaleToZeroAt: "2026-12-16T08:00:00Z", // midnight Pacific (PST, UTC-8) at the end of December 15, 2026
  region: "us-east-2",
};

const isRealDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** Builds and validates the settings. `get` reads one CDK context value (or returns undefined). */
export function buildConfig(get: (key: string) => unknown): InfraConfig {
  const str = (k: string, fallback?: string): string | undefined => {
    const v = get(k);
    return v === undefined || v === null || v === "" ? fallback : String(v).trim();
  };
  const problems: string[] = [];
  const need = (k: string, how: string): string => {
    const v = str(k);
    if (!v) problems.push(`Missing -c ${k}=...  (${how})`);
    return v ?? "";
  };

  const appHostname = str("appHostname", DEFAULTS.appHostname)!;
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(appHostname)) problems.push(`appHostname "${appHostname}" is not a valid host name.`);

  const alertEmail = need("alertEmail", "the email that gets alarm messages");
  if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) problems.push(`alertEmail "${alertEmail}" is not a valid email address.`);

  const cognitoDomainPrefix = need("cognitoDomainPrefix", "a short unique name for the sign-in page address, like my-team-counseling");
  if (cognitoDomainPrefix && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(cognitoDomainPrefix)) problems.push(`cognitoDomainPrefix "${cognitoDomainPrefix}" must be lowercase letters, numbers and hyphens.`);
  if (/aws|amazon|cognito/.test(cognitoDomainPrefix)) problems.push(`cognitoDomainPrefix "${cognitoDomainPrefix}" cannot contain "aws", "amazon" or "cognito".`);

  const bedrockModelId = need("bedrockModelId", "the US-only Claude inference profile id from the Bedrock console");
  if (bedrockModelId) {
    if (!/^[A-Za-z0-9._:-]+$/.test(bedrockModelId)) problems.push(`bedrockModelId "${bedrockModelId}" has characters a model id never has.`);
    if (/(^|\.)global\./i.test(bedrockModelId)) problems.push("bedrockModelId must be a US-only inference profile, never a global one.");
  }

  const desiredRaw = str("desiredCount", String(DEFAULTS.desiredCount))!;
  if (desiredRaw !== "0" && desiredRaw !== "1") problems.push(`desiredCount must be 0 or 1 (got "${desiredRaw}").`);

  const activeUntil = str("activeUntil", DEFAULTS.activeUntil)!;
  if (!isRealDate(activeUntil)) problems.push(`activeUntil "${activeUntil}" must be a real date like 2026-12-15.`);

  const scaleToZeroAt = str("scaleToZeroAt", DEFAULTS.scaleToZeroAt)!;
  if (Number.isNaN(Date.parse(scaleToZeroAt)) || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scaleToZeroAt)) problems.push(`scaleToZeroAt "${scaleToZeroAt}" must be an exact time like 2026-12-16T08:00:00Z.`);

  const githubRepo = str("githubRepo");
  if (githubRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) problems.push(`githubRepo "${githubRepo}" must look like owner/name.`);
  const githubOidcProviderArn = str("githubOidcProviderArn");
  const deployUserRaw = str("deployUser", "false")!.toLowerCase();
  if (deployUserRaw !== "true" && deployUserRaw !== "false") problems.push(`deployUser must be true or false (got "${deployUserRaw}").`);

  if (problems.length) {
    throw new Error(`The deployment settings need fixing:\n - ${problems.join("\n - ")}`);
  }
  return {
    appHostname,
    alertEmail,
    cognitoDomainPrefix,
    bedrockModelId,
    imageTag: str("imageTag", DEFAULTS.imageTag)!,
    desiredCount: desiredRaw === "0" ? 0 : 1,
    activeUntil,
    scaleToZeroAt,
    region: str("region", DEFAULTS.region)!,
    githubRepo,
    githubOidcProviderArn,
    deployUser: deployUserRaw === "true",
  };
}
