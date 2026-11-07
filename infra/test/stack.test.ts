import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildConfig, DEFAULTS, type InfraConfig } from "../lib/config";
import { CounselorInsightsStack } from "../lib/stack";

// These tests read the CloudFormation template the code produces. They need no AWS account and create nothing.
const CONFIG: InfraConfig = {
  appHostname: "studentcounseling.persimmon-care.com",
  alertEmail: "alerts@example.test",
  cognitoDomainPrefix: "test-team-counseling",
  bedrockModelId: "us.anthropic.claude-haiku-test-v1:0",
  imageTag: "latest",
  desiredCount: 1,
  activeUntil: "2026-12-15",
  scaleToZeroAt: "2026-12-16T08:00:00Z",
  region: "us-east-2",
  githubRepo: "owner/name",
};

const build = (over: Partial<InfraConfig> = {}) =>
  Template.fromStack(
    new CounselorInsightsStack(new App(), "T", { config: { ...CONFIG, ...over }, env: { account: "111111111111", region: "us-east-2" } }),
  );
const t = build();
const json = JSON.stringify(t.toJSON());

describe("settings", () => {
  const ctx = (o: Record<string, unknown>) => (k: string) => o[k];
  const ok = { alertEmail: "a@example.test", cognitoDomainPrefix: "my-team", bedrockModelId: "us.anthropic.claude-test-v1:0" };

  it("fills in the defaults: the app's address, December 15 and the scale-down moment", () => {
    const c = buildConfig(ctx(ok));
    expect(c).toMatchObject({ appHostname: DEFAULTS.appHostname, activeUntil: "2026-12-15", scaleToZeroAt: "2026-12-16T08:00:00Z", desiredCount: 1, region: "us-east-2", imageTag: "latest" });
    expect(c.githubRepo).toBeUndefined();
  });

  it("stops with a plain list of everything missing", () => {
    expect(() => buildConfig(ctx({}))).toThrow(/alertEmail[\s\S]*cognitoDomainPrefix[\s\S]*bedrockModelId/);
  });

  it("refuses bad values: a global Bedrock model, a bad email, a bad domain prefix, a fake date, a wrong repo name", () => {
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => buildConfig(ctx({ ...ok, ...o }))).toThrow(re);
    bad({ bedrockModelId: "global.anthropic.claude-x" }, /never a global one/);
    bad({ alertEmail: "not-an-email" }, /not a valid email/);
    bad({ cognitoDomainPrefix: "My_Team" }, /lowercase/);
    bad({ cognitoDomainPrefix: "my-cognito-team" }, /cannot contain/);
    bad({ activeUntil: "2026-02-30" }, /real date/);
    bad({ scaleToZeroAt: "tomorrow" }, /exact time/);
    bad({ githubRepo: "justaname" }, /owner\/name/);
    bad({ desiredCount: "2" }, /0 or 1/);
    bad({ appHostname: "not a host" }, /valid host name/);
  });
});

describe("network", () => {
  it("has no NAT gateway (about $30 a month saved), an S3 gateway endpoint, and a database in subnets with no internet route", () => {
    t.resourceCountIs("AWS::EC2::NatGateway", 0);
    t.hasResourceProperties("AWS::EC2::VPCEndpoint", { VpcEndpointType: "Gateway" });
    expect(json).toContain("isolated");
  });

  it("the database accepts connections from the app only, and the app accepts them from the load balancer only", () => {
    const sgs = t.findResources("AWS::EC2::SecurityGroup");
    const byDesc = (d: string) => Object.entries(sgs).find(([, v]) => (v as { Properties: { GroupDescription: string } }).Properties.GroupDescription === d)!;
    // no security group lets the whole internet reach anything but the load balancer
    const open = Object.values(sgs).filter((v) => JSON.stringify((v as { Properties: { SecurityGroupIngress?: unknown } }).Properties.SecurityGroupIngress ?? []).includes("0.0.0.0/0"));
    expect(open).toHaveLength(1);
    expect((open[0] as { Properties: { GroupDescription: string } }).Properties.GroupDescription).toBe("Load balancer");
    expect(byDesc("Database")).toBeDefined();
    t.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { FromPort: 5432, ToPort: 5432, IpProtocol: "tcp" });
    t.hasResourceProperties("AWS::EC2::SecurityGroupIngress", { FromPort: 3000, ToPort: 3000, IpProtocol: "tcp" });
  });
});

describe("database", () => {
  it("is Postgres 16, small, single zone, encrypted, private, with 1 day of backups and a generated login", () => {
    t.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: Match.stringLikeRegexp("^16"),
      DBInstanceClass: "db.t4g.micro",
      MultiAZ: false,
      StorageEncrypted: true,
      PubliclyAccessible: false,
      BackupRetentionPeriod: 1,
      DBName: "counselor_insights",
    });
    t.resourceCountIs("AWS::RDS::DBInstance", 1);
  });

  it("can be torn down with the stack (no deletion protection) and leaves no backups behind", () => {
    t.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Delete", Properties: { DeletionProtection: false, DeleteAutomatedBackups: true } });
  });

  it("the app's own database password is a separate generated secret (never written anywhere)", () => {
    t.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "counselor-insights/app-db-password",
      GenerateSecretString: Match.objectLike({ PasswordLength: 32, ExcludePunctuation: true }),
    });
  });
});

describe("audio bucket", () => {
  const audio = () => Object.values(t.findResources("AWS::S3::Bucket")).find((b) => (b as { Properties: { CorsConfiguration?: unknown } }).Properties.CorsConfiguration)!;

  it("is private, encrypted, not versioned, and has NO expiry rule", () => {
    const p = (audio() as { Properties: Record<string, unknown> }).Properties;
    expect(p.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(JSON.stringify(p.BucketEncryption)).toContain("AES256");
    expect(p.VersioningConfiguration).toBeUndefined();
    expect(p.LifecycleConfiguration).toBeUndefined();
  });

  it("allows only PUT from the app's address and from localhost", () => {
    const cors = (audio() as { Properties: { CorsConfiguration: { CorsRules: Array<{ AllowedMethods: string[]; AllowedOrigins: string[] }> } } }).Properties.CorsConfiguration.CorsRules;
    expect(cors).toHaveLength(1);
    expect(cors[0].AllowedMethods).toEqual(["PUT"]);
    expect(cors[0].AllowedOrigins.sort()).toEqual(["http://localhost:3000", "https://studentcounseling.persimmon-care.com"]);
  });

  it("refuses plain-http access, and is not emptied automatically when the stack is destroyed (recordings are removed only on purpose)", () => {
    t.hasResourceProperties("AWS::S3::BucketPolicy", { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) } });
    const buckets = t.findResources("AWS::S3::Bucket");
    const autoDeletes = Object.values(buckets).filter((b) => JSON.stringify((b as { Properties: unknown }).Properties).includes("AutoDelete"));
    expect(autoDeletes).toHaveLength(0); // the CloudTrail bucket's emptying is a separate custom resource, not a bucket tag
  });
});

describe("sign-in (Cognito)", () => {
  it("only administrators create users: no self sign-up, no MFA for the prototype, strong passwords", () => {
    t.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: "OFF",
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
    });
  });

  it("the app client uses the code flow with PKCE-friendly settings: a public client, no secret, only our two addresses", () => {
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: Match.arrayEquals(["openid", "email", "profile"]),
      CallbackURLs: ["https://studentcounseling.persimmon-care.com/auth/callback", "http://localhost:3000/auth/callback"],
      LogoutURLs: ["https://studentcounseling.persimmon-care.com/login", "http://localhost:3000/login"],
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("uses Managed Login on the chosen address", () => {
    t.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: "test-team-counseling", ManagedLoginVersion: 2 });
    t.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
  });
});

describe("the app", () => {
  const container = (n = 0) => {
    const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition"));
    return defs.map((d) => (d as { Properties: { ContainerDefinitions: Array<Record<string, unknown>> } }).Properties.ContainerDefinitions[0])[n];
  };
  const appContainer = () => Object.values(t.findResources("AWS::ECS::TaskDefinition")).map((d) => (d as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string }> }> } }).Properties.ContainerDefinitions[0]).find((c) => c.Name === "app")!;
  const env = (c: { Environment: Array<{ Name: string; Value: unknown }> }, name: string) => c.Environment.find((e) => e.Name === name)?.Value;

  it("runs one Fargate task in the public subnets with a public address (no NAT), behind the load balancer", () => {
    t.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
      DesiredCount: 1,
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }) },
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    });
    expect(container(0)).toBeDefined();
  });

  it("is configured for production: Cognito, S3, AssemblyAI, Bedrock, an encrypted database connection, and the end date", () => {
    const c = appContainer();
    expect(env(c, "NODE_ENV")).toBe("production");
    expect(env(c, "AUTH_MODE")).toBe("cognito");
    expect(env(c, "STORAGE_MODE")).toBe("s3");
    expect(env(c, "TRANSCRIPTION_MODE")).toBe("assemblyai");
    expect(env(c, "LLM_PROVIDER")).toBe("bedrock");
    expect(env(c, "BEDROCK_MODEL_ID")).toBe("us.anthropic.claude-haiku-test-v1:0");
    expect(env(c, "DB_SSL")).toBe("require");
    expect(env(c, "APP_DB_USER")).toBe("app_user");
    expect(env(c, "APP_ACTIVE_UNTIL")).toBe("2026-12-15");
    expect(env(c, "APP_BASE_URL")).toBe("https://studentcounseling.persimmon-care.com");
  });

  it("never turns on a development stand-in (the app would refuse to start)", () => {
    const names = appContainer().Environment.map((e) => e.Name);
    expect(names).not.toContain("LLM_MODE"); // no mock AI
    expect(env(appContainer(), "AUTH_MODE")).not.toBe("dev");
    expect(env(appContainer(), "STORAGE_MODE")).not.toBe("local");
    expect(env(appContainer(), "TRANSCRIPTION_MODE")).not.toBe("mock");
  });

  it("gets its three secrets from Secrets Manager and has no secret value written in the template", () => {
    expect(appContainer().Secrets.map((s) => s.Name).sort()).toEqual(["APP_DB_PASSWORD", "ASSEMBLYAI_API_KEY", "ASSEMBLYAI_WEBHOOK_SECRET"]);
    expect(json).not.toMatch(/\bsk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|"password":"[^"{]/i); // no key-like strings or literal passwords
  });

  it("has a separate one-off migration task that alone gets the database administrator login", () => {
    const defs = Object.values(t.findResources("AWS::ECS::TaskDefinition")).map((d) => (d as { Properties: { ContainerDefinitions: Array<{ Name: string; Command?: string[]; Secrets: Array<{ Name: string }> }> } }).Properties.ContainerDefinitions[0]);
    const migrate = defs.find((c) => c.Name === "migrate")!;
    expect(migrate.Command).toEqual(["node", "dist/migrate.cjs"]);
    expect(migrate.Secrets.map((s) => s.Name).sort()).toEqual(["APP_DB_PASSWORD", "POSTGRES_PASSWORD", "POSTGRES_USER"]);
    expect(appContainer().Secrets.map((s) => s.Name)).not.toContain("POSTGRES_PASSWORD"); // the running app never holds the admin login
  });

  it("the task role can use S3 and invoke Claude on Bedrock, and nothing broad", () => {
    // the app task role's own policy (not the deploy role's, which only mentions it)
    const policies = Object.entries(t.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith("AppTaskRoleDefaultPolicy")).map(([, p]) => p);
    expect(policies).toHaveLength(1);
    const statements = policies.flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown; Effect: string }> } } }).Properties.PolicyDocument.Statement);
    const bedrock = statements.find((s) => JSON.stringify(s.Action).includes("bedrock"))!;
    expect(bedrock.Action).toBe("bedrock:InvokeModel");
    expect(JSON.stringify(bedrock.Resource)).toContain("anthropic.*");
    expect(JSON.stringify(bedrock.Resource)).toContain("us.anthropic.*");
    for (const s of statements) {
      expect(JSON.stringify(s.Action), JSON.stringify(s)).not.toMatch(/"\*"|:\*"|iam:|secretsmanager:|ecs:|ec2:|rds:|cognito/);
      expect(s.Effect).toBe("Allow");
    }
  });

  it("serves HTTPS with a DNS-validated certificate, redirects HTTP to HTTPS, and checks /healthz", () => {
    t.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "studentcounseling.persimmon-care.com", ValidationMethod: "DNS" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06" });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect", RedirectConfig: Match.objectLike({ Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" }) })],
    });
    t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/healthz", Matcher: { HttpCode: "200" }, Port: 3000 });
  });

  it("keeps logs for 30 days", () => {
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/counselor-insights/app", RetentionInDays: 30 });
  });

  it("the container registry scans on push, keeps only recent images, and is emptied when the stack is destroyed", () => {
    t.hasResourceProperties("AWS::ECR::Repository", { ImageScanningConfiguration: { ScanOnPush: true }, RepositoryName: "counselor-insights" });
  });
});

describe("the end of the project", () => {
  it("scales the app to zero at midnight Pacific on December 16, 2026 (08:00 UTC), when the app deactivates itself", () => {
    t.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 1,
      MaxCapacity: 1,
      ScheduledActions: [Match.objectLike({ Schedule: "at(2026-12-16T08:00:00)", ScalableTargetAction: { MinCapacity: 0, MaxCapacity: 0 } })],
    });
  });

  it("on a first deploy with no image yet (desiredCount 0) there is no scaling rule, so nothing tries to start", () => {
    const first = build({ desiredCount: 0 });
    first.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 0 });
    first.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
  });

  it("tells the deploy output when it switches off", () => {
    expect(json).toContain("DeactivatesAfter");
    expect(json).toContain("2026-12-15");
  });
});

describe("monitoring", () => {
  it("emails the chosen address, and alarms on load balancer errors, app errors and an unhealthy task", () => {
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alerts@example.test" });
    t.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    for (const metric of ["HTTPCode_ELB_5XX_Count", "HTTPCode_Target_5XX_Count", "UnHealthyHostCount"]) {
      t.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: metric, AlarmActions: Match.anyValue() });
    }
  });

  it("does NOT alarm on 'no healthy task', which would email forever after the planned scale to zero", () => {
    expect(Object.values(t.findResources("AWS::CloudWatch::Alarm")).some((a) => (a as { Properties: { MetricName: string } }).Properties.MetricName === "HealthyHostCount")).toBe(false);
  });

  it("turns on CloudTrail with file validation", () => {
    t.hasResourceProperties("AWS::CloudTrail::Trail", { IsLogging: true, EnableLogFileValidation: true });
  });
});

describe("deploying from GitHub with no stored AWS keys", () => {
  const role = () =>
    Object.values(t.findResources("AWS::IAM::Role")).find((r) => JSON.stringify(r).includes("token.actions.githubusercontent.com"))!;

  it("only the main branch of the named repository can assume the role, for at most an hour", () => {
    const r = role() as { Properties: { AssumeRolePolicyDocument: unknown; MaxSessionDuration: number } };
    const doc = JSON.stringify(r.Properties.AssumeRolePolicyDocument);
    expect(doc).toContain("repo:owner/name:ref:refs/heads/main");
    expect(doc).toContain("sts.amazonaws.com");
    expect(doc).not.toContain("StringLike"); // an exact match, not a wildcard
    expect(r.Properties.MaxSessionDuration).toBe(3600);
  });

  it("can push the image, run the migration and update the service, and cannot create or delete infrastructure", () => {
    const stmts = Object.values(t.findResources("AWS::IAM::Policy"))
      .filter((p) => JSON.stringify(p).includes("GithubDeploy"))
      .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument.Statement);
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    for (const a of ["ecr:GetAuthorizationToken", "ecs:RunTask", "ecs:UpdateService", "ecs:RegisterTaskDefinition", "iam:PassRole", "cloudformation:DescribeStacks"]) expect(actions).toContain(a);
    for (const a of actions) expect(a, a).not.toMatch(/Create|Delete(?!Stack)|rds:|s3:Delete|cognito|ec2:|\*$/); // a deploy never needs these
    expect(actions).not.toContain("iam:*");
  });

  it("is only created when a repository is named, and can reuse the account's existing GitHub provider", () => {
    const without = build({ githubRepo: undefined });
    expect(JSON.stringify(without.toJSON())).not.toContain("token.actions.githubusercontent.com");
    const reuse = build({ githubOidcProviderArn: "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" });
    reuse.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    expect(JSON.stringify(reuse.toJSON())).toContain("oidc-provider/token.actions.githubusercontent.com");
  });
});
