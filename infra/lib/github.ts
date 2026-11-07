import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { App } from "./app";

/**
 * The role GitHub Actions uses to deploy (SPEC.md section 11), with NO stored AWS keys: GitHub proves who it
 * is with a short-lived OIDC token, and AWS lends it this role for up to an hour. Only the `main` branch of
 * the named repository can use it, and it can do only what a deploy needs: push the image, run the
 * migration task, and update the service. It cannot create or delete infrastructure.
 */
export class GithubDeploy extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: { repo: string; existingProviderArn?: string; app: App }) {
    super(scope, id);
    const stack = Stack.of(this);
    const { app } = props;

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

    // Push and pull images.
    app.repository.grantPullPush(this.role);
    this.role.addToPolicy(new iam.PolicyStatement({ sid: "EcrLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));

    // Task definitions (these actions cannot be limited to one resource), then run and update only OUR things.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "TaskDefinitions",
        actions: ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
        resources: ["*"],
      }),
    );
    const family = (td: { family: string }) => `arn:aws:ecs:${stack.region}:${stack.account}:task-definition/${td.family}:*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunMigrationTask",
        actions: ["ecs:RunTask"],
        resources: [family(app.migrateTask)],
        conditions: { ArnEquals: { "ecs:cluster": app.cluster.clusterArn } },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SeeAndStopTasks",
        actions: ["ecs:DescribeTasks", "ecs:StopTask"],
        resources: [`arn:aws:ecs:${stack.region}:${stack.account}:task/${app.cluster.clusterName}/*`],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "UpdateService",
        actions: ["ecs:UpdateService", "ecs:DescribeServices"],
        resources: [app.service.serviceArn],
      }),
    );
    // Hand ONLY these roles to ECS, and only to ECS.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassTaskRoles",
        actions: ["iam:PassRole"],
        resources: [app.appTask.taskRole.roleArn, app.appTask.executionRole!.roleArn, app.migrateTask.taskRole.roleArn, app.migrateTask.executionRole!.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );
    // Read the stack's outputs (subnets, security group, names) and the task logs.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadStackOutputs",
        actions: ["cloudformation:DescribeStacks"],
        resources: [stack.formatArn({ service: "cloudformation", resource: "stack", resourceName: `${stack.stackName}/*` })],
      }),
    );
    app.logGroup.grantRead(this.role);
  }
}
