import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { Network } from "./network";

/**
 * RDS Postgres 16: small, one zone, encrypted, in isolated subnets, not publicly reachable, with 1 day of
 * automatic backups. The administrator login is made by AWS and kept in Secrets Manager (nobody sees it).
 * The app itself connects as the limited `app_user` role (so row-level security applies); that role's
 * password is a separate generated secret, which the migration task sets on the database.
 */
export class Database extends Construct {
  readonly instance: rds.DatabaseInstance;
  readonly adminSecret: secretsmanager.ISecret;
  readonly appPasswordSecret: secretsmanager.Secret;
  readonly databaseName = "counselor_insights";

  constructor(scope: Construct, id: string, props: { network: Network }) {
    super(scope, id);

    this.instance = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.network.dbSg],
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName: this.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret("counselor_admin"),
      backupRetention: Duration.days(1), // the free plan allows at most 1 day (AWS refused 7 on 2026-11-07)
      autoMinorVersionUpgrade: true,
      deletionProtection: false, // a class project: `cdk destroy` must be able to remove it (see docs/SHUTDOWN.md)
      removalPolicy: RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
    });
    this.adminSecret = this.instance.secret!;

    this.appPasswordSecret = new secretsmanager.Secret(this, "AppDbPassword", {
      secretName: "counselor-insights/app-db-password",
      description: "Password for the limited app_user database login",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
