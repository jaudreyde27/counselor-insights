import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

/**
 * Network (SPEC.md section 10). Two zones. The database sits in ISOLATED subnets (no route to the
 * internet at all). The app runs in PUBLIC subnets with public addresses and tight security groups,
 * which avoids the cost of a NAT gateway (about $30 a month). An S3 gateway endpoint keeps S3
 * traffic on AWS's own network.
 */
export class Network extends Construct {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly appSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.20.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: true },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // The load balancer: open to the world on 80 (which only redirects) and 443, and talks only to the app.
    this.albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc: this.vpc, description: "Load balancer", allowAllOutbound: false });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP (redirects to HTTPS)");
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    // The app: reachable only from the load balancer, on its one port. It may call out (AssemblyAI, Bedrock, Cognito).
    this.appSg = new ec2.SecurityGroup(this, "AppSg", { vpc: this.vpc, description: "App tasks", allowAllOutbound: true });
    this.appSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), "From the load balancer only");
    this.albSg.addEgressRule(this.appSg, ec2.Port.tcp(3000), "To the app only");

    // The database: reachable only from the app, and it cannot call out at all.
    this.dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc: this.vpc, description: "Database", allowAllOutbound: false });
    this.dbSg.addIngressRule(this.appSg, ec2.Port.tcp(5432), "From the app only");
  }
}
