import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { Auth } from "./auth";
import type { InfraConfig } from "./config";
import type { Database } from "./database";
import type { Network } from "./network";
import type { Storage } from "./storage";

/** Names of the secrets made by scripts/store-secret.sh. They must exist BEFORE the app first starts. */
export const ASSEMBLYAI_KEY_SECRET = "counselor-insights/assemblyai-api-key";
// NOTE: never end a secret name with a hyphen plus exactly 6 characters (like "-secret"): AWS mistakes that for its own random suffix and denies access.
export const ASSEMBLYAI_WEBHOOK_SECRET = "counselor-insights/assemblyai-webhook-token";

/**
 * The app (SPEC.md section 10): a container registry, one Fargate task behind a load balancer with HTTPS
 * on the app's address, a one-off "migrate" task that applies the database migrations, a least-privilege
 * task role, and a scheduled scale to zero for the end of the project.
 */
export class App extends Construct {
  readonly repository: ecr.Repository;
  readonly cluster: ecs.Cluster;
  readonly service: ecs.FargateService;
  readonly appTask: ecs.FargateTaskDefinition;
  readonly migrateTask: ecs.FargateTaskDefinition;
  readonly taskRole: iam.Role;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly certificate: acm.Certificate;
  readonly logGroup: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: { config: InfraConfig; network: Network; database: Database; storage: Storage; auth: Auth },
  ) {
    super(scope, id);
    const { config, network, database, storage, auth } = props;
    const stack = Stack.of(this);

    this.repository = new ecr.Repository(this, "Repository", {
      repositoryName: "counselor-insights",
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 10, description: "Keep the 10 most recent images" }],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", { vpc: network.vpc });
    this.logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/counselor-insights/app",
      retention: logs.RetentionDays.ONE_MONTH, // 30 days
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- Task role: only what the app needs, nothing else ----
    this.taskRole = new iam.Role(this, "TaskRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
    storage.bucket.grantReadWrite(this.taskRole); // upload links, the check that a file exists, and delete
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeClaudeOnBedrock",
        actions: ["bedrock:InvokeModel"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          `arn:aws:bedrock:*:${stack.account}:inference-profile/us.anthropic.*`,
        ],
      }),
    );
    // The two AssemblyAI secrets and the database passwords are handed to the app by ECS as environment variables
    // (the task EXECUTION role reads them), so the app never needs permission to call Secrets Manager itself.

    const assemblyAiKey = secretsmanager.Secret.fromSecretNameV2(this, "AssemblyAiKey", ASSEMBLYAI_KEY_SECRET);
    const assemblyAiWebhook = secretsmanager.Secret.fromSecretNameV2(this, "AssemblyAiWebhook", ASSEMBLYAI_WEBHOOK_SECRET);

    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.X86_64, // what the GitHub build produces
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };
    const image = ecs.ContainerImage.fromEcrRepository(this.repository, config.imageTag);

    const dbEnv = {
      DB_HOST: database.instance.dbInstanceEndpointAddress,
      DB_PORT: "5432",
      POSTGRES_DB: database.databaseName,
      APP_DB_USER: "app_user",
      DB_SSL: "require", // RDS for Postgres 16 insists on an encrypted connection
    };

    // ---- The app ----
    this.appTask = new ecs.FargateTaskDefinition(this, "AppTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
      taskRole: this.taskRole,
    });
    this.appTask.addContainer("app", {
      image,
      essential: true,
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: "app" }),
      environment: {
        NODE_ENV: "production",
        AUTH_MODE: "cognito",
        COGNITO_REGION: stack.region,
        COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
        COGNITO_CLIENT_ID: auth.client.userPoolClientId,
        COGNITO_DOMAIN: auth.domain.baseUrl(),
        STORAGE_MODE: "s3",
        S3_AUDIO_BUCKET: storage.bucket.bucketName,
        AWS_REGION: stack.region,
        TRANSCRIPTION_MODE: "assemblyai",
        LLM_PROVIDER: "bedrock",
        BEDROCK_MODEL_ID: config.bedrockModelId,
        PROMPT_VERSION: "3",
        LLM_TEMPERATURE: "0.1",
        APP_BASE_URL: `https://${config.appHostname}`,
        APP_NAME: "International Student Counseling",
        APP_ACTIVE_UNTIL: config.activeUntil,
        ...dbEnv,
      },
      secrets: {
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(database.appPasswordSecret),
        ASSEMBLYAI_API_KEY: ecs.Secret.fromSecretsManager(assemblyAiKey),
        ASSEMBLYAI_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(assemblyAiWebhook),
      },
    });

    // ECS asks for these two secrets by their plain name (no random 6-character suffix), and the grant CDK writes
    // for an imported secret only matches "name-XXXXXX". Without this, the app fails to start with AccessDenied
    // (seen on the first real deploy, 2026-11-07). Allow exactly these two names, nothing broader.
    this.appTask.executionRole!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadAssemblyAiSecretsByName",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [ASSEMBLYAI_KEY_SECRET, ASSEMBLYAI_WEBHOOK_SECRET].map(
          (name) => `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:${name}`,
        ),
      }),
    );

    // ---- The one-off migration task (run before each deploy) ----
    this.migrateTask = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
    });
    this.migrateTask.addContainer("migrate", {
      image,
      essential: true,
      command: ["node", "dist/migrate.cjs"],
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: "migrate" }),
      environment: dbEnv,
      secrets: {
        // The administrator login is used ONLY here, to create tables and set the app_user password.
        POSTGRES_USER: ecs.Secret.fromSecretsManager(database.adminSecret, "username"),
        POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(database.adminSecret, "password"),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(database.appPasswordSecret),
      },
    });

    // ---- HTTPS on the app's address ----
    // DNS-validated certificate. The deploy pauses until the validation record is added in Cloudflare
    // (docs/AWS_SETUP.md step 9; scripts/dns-records.sh prints it).
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.appHostname,
      validation: acm.CertificateValidation.fromDns(),
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: network.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: network.albSg,
    });
    this.loadBalancer.addListener("Http", {
      port: 80,
      open: false, // the security group already controls who may connect
      defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
    });
    const https = this.loadBalancer.addListener("Https", {
      port: 443,
      open: false,
      certificates: [this.certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster: this.cluster,
      taskDefinition: this.appTask,
      desiredCount: config.desiredCount,
      assignPublicIp: true, // public subnets, no NAT gateway
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [network.appSg],
      healthCheckGracePeriod: Duration.seconds(60),
      // Zero-downtime updates: start the new task and wait until it is healthy before stopping the old one.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    this.targetGroup = https.addTargets("App", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: "/healthz", // returns "ok" and no data about students
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // ---- The end of the project ----
    // At the moment the app deactivates itself (APP_ACTIVE_UNTIL), scale the app server to zero so the compute bill stops
    // even if nobody remembers. The load balancer and database keep billing until `cdk destroy` (docs/SHUTDOWN.md).
    if (config.desiredCount === 1) {
      const scaling = this.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 1 });
      scaling.scaleOnSchedule("EndOfProject", {
        schedule: appscaling.Schedule.at(new Date(config.scaleToZeroAt)),
        minCapacity: 0,
        maxCapacity: 0,
      });
    }
  }
}
