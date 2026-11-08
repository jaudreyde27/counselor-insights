import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { App } from "./app";

/**
 * What a deploy needs, and nothing more: push the image, run the migration task, update the service. It cannot
 * create or delete infrastructure, read the database, touch the audio bucket, billing or the user pool.
 * Shared by the OIDC role (needs an AWS account that allows the GitHub connection) and the deploy-only user
 * (works on the free plan, where an account-level policy blocks the connection).
 */
function deployStatements(scope: Construct, app: App): iam.PolicyStatement[] {
  const stack = Stack.of(scope);
  const family = (td: { family: string }) => `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${td.family}:*`;
  return [
    // Push and pull images (listed out so the same list works for a role and for a user's managed policy).
    new iam.PolicyStatement({
      sid: "EcrPushPull",
      actions: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
      ],
      resources: [app.repository.repositoryArn],
    }),
    new iam.PolicyStatement({ sid: "EcrLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
    // Task definitions (these actions cannot be limited to one resource), then run and update only OUR things.
    new iam.PolicyStatement({ sid: "TaskDefinitions", actions: ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"], resources: ["*"] }),
    new iam.PolicyStatement({
      sid: "RunMigrationTask",
      actions: ["ecs:RunTask"],
      resources: [family(app.migrateTask)],
      conditions: { ArnEquals: { "ecs:cluster": app.cluster.clusterArn } },
    }),
    new iam.PolicyStatement({
      sid: "SeeAndStopTasks",
      actions: ["ecs:DescribeTasks", "ecs:StopTask"],
      resources: [`arn:aws:ecs:${stack.region}:${stack.account}:task/${app.cluster.clusterName}/*`],
    }),
    new iam.PolicyStatement({ sid: "UpdateService", actions: ["ecs:UpdateService", "ecs:DescribeServices"], resources: [app.service.serviceArn] }),
    // Hand ONLY these roles to ECS, and only to ECS.
    new iam.PolicyStatement({
      sid: "PassTaskRoles",
      actions: ["iam:PassRole"],
      resources: [app.appTask.taskRole.roleArn, app.appTask.executionRole!.roleArn, app.migrateTask.taskRole.roleArn, app.migrateTask.executionRole!.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    }),
    // Read the stack's outputs (subnets, security group, names) and the task logs.
    new iam.PolicyStatement({
      sid: "ReadStackOutputs",
      actions: ["cloudformation:DescribeStacks"],
      resources: [stack.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${stack.stackName}/*` })],
    }),
    new iam.PolicyStatement({
      sid: "ReadTaskLogs",
      actions: ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"],
      resources: [app.logGroup.logGroupArn, `${app.logGroup.logGroupArn}:*`],
    }),
  ];
}

/**
 * The role GitHub Actions uses to deploy (SPEC.md section 11), with NO stored AWS keys: GitHub proves who it
 * is with a short-lived OIDC token, and AWS lends it this role for up to an hour. Only the `main` branch of
 * the named repository can use it. Needs an AWS account that allows creating the GitHub OIDC provider.
 */
export class GithubDeploy extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: { repo: string; existingProviderArn?: string; app: App }) {
    super(scope, id);

    // Only one GitHub provider can exist per AWS account; reuse it if the account already has one.
    const providerArn = props.existingProviderArn
      ? props.existingProviderArn
      : new iam.OpenIdConnectProvider(this, "Provider", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        }).openIdConnectProviderArn;

    this.role = new iam.Role(this, "Role", {
      description: `Deploys ${props.repo} (main branch only)`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${props.repo}:ref:refs/heads/main`,
        },
      }),
    });
    for (const statement of deployStatements(this, props.app)) this.role.addToPolicy(statement);
  }
}

/**
 * A deploy-only AWS user for GitHub Actions, for accounts where the GitHub OIDC connection is blocked (the
 * free plan). It has NO password and no console access; the only way to use it is an access key, which is
 * created by hand, stored straight into GitHub's encrypted secrets, and deleted when the project ends
 * (docs/SHUTDOWN.md). This is a deliberate exception to "no stored AWS keys" (AGENTS.md / CLAUDE.md).
 */
export class GithubDeployUser extends Construct {
  readonly user: iam.User;

  constructor(scope: Construct, id: string, props: { app: App }) {
    super(scope, id);
    this.user = new iam.User(this, "User", { userName: "counselor-insights-github-deployer" });
    // A managed policy, not inline: AWS limits a user's inline policies to 2 KB in total, and this is larger.
    this.user.addManagedPolicy(new iam.ManagedPolicy(this, "Policy", { description: "Deploy-only permissions for GitHub Actions", statements: deployStatements(this, props.app) }));
  }
}
