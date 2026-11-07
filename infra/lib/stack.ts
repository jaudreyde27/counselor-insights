import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { App } from "./app";
import { Auth } from "./auth";
import type { InfraConfig } from "./config";
import { Database } from "./database";
import { GithubDeploy } from "./github";
import { Monitoring } from "./monitoring";
import { Network } from "./network";
import { Storage } from "./storage";

/**
 * Everything in one stack, so one `cdk deploy` makes it and one `cdk destroy` removes it (docs/SHUTDOWN.md).
 * Nothing here has been deployed yet: see docs/AWS_SETUP.md.
 */
export class CounselorInsightsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { config: InfraConfig }) {
    super(scope, id, props);
    const { config } = props;

    const network = new Network(this, "Network");
    const database = new Database(this, "Database", { network });
    const storage = new Storage(this, "Storage", { appHostname: config.appHostname });
    const auth = new Auth(this, "Auth", { appHostname: config.appHostname, domainPrefix: config.cognitoDomainPrefix });
    const app = new App(this, "App", { config, network, database, storage, auth });
    new Monitoring(this, "Monitoring", { alertEmail: config.alertEmail, app });

    let deployRole: GithubDeploy | undefined;
    if (config.githubRepo) {
      deployRole = new GithubDeploy(this, "GithubDeploy", {
        repo: config.githubRepo,
        existingProviderArn: config.githubOidcProviderArn,
        app,
      });
    }

    // ---- Outputs: what the deploy workflow, the DNS step and the .env need ----
    const out = (id: string, value: string, description: string) => new CfnOutput(this, id, { value, description });
    out("Hostname", config.appHostname, "Where the app lives");
    out("LoadBalancerDnsName", app.loadBalancer.loadBalancerDnsName, "DNS step 9b: point the CNAME for the hostname here (DNS only, not proxied)");
    out("CertificateArn", app.certificate.certificateArn, "scripts/dns-records.sh reads the validation record from this certificate (DNS step 9a)");
    out("RepositoryUri", app.repository.repositoryUri, "Where the deploy workflow pushes the image");
    out("ClusterName", app.cluster.clusterName, "ECS cluster");
    out("ServiceName", app.service.serviceName, "ECS service");
    out("AppTaskFamily", app.appTask.family, "Task definition family for the app");
    out("MigrateTaskFamily", app.migrateTask.family, "Task definition family for the one-off migration");
    out("PublicSubnetIds", network.vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds.join(","), "Where the migration task runs");
    out("AppSecurityGroupId", network.appSg.securityGroupId, "Security group for the migration task");
    out("UserPoolId", auth.userPool.userPoolId, "Cognito user pool (create counselors here)");
    out("UserPoolClientId", auth.client.userPoolClientId, "Cognito app client");
    out("CognitoDomain", auth.domain.baseUrl(), "Cognito sign-in page address");
    out("AudioBucketName", storage.bucket.bucketName, "Private bucket holding recordings");
    out("DeactivatesAfter", config.activeUntil, "The app switches itself off after the end of this day (Pacific time)");
    out("ScaledToZeroAt", config.scaleToZeroAt, "The app server is scaled to zero at this moment");
    if (deployRole) out("GithubDeployRoleArn", deployRole.role.roleArn, "Put this in the GitHub repository variable AWS_DEPLOY_ROLE_ARN");
  }
}
