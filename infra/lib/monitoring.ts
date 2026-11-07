import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { App } from "./app";

/**
 * Monitoring (SPEC.md section 10): a 30-day log group (made in the App construct), a few alarms that email
 * you, and CloudTrail (a record of who did what in the AWS account). No transcript text is ever in the logs.
 * The email address must confirm its subscription (AWS sends a "confirm" message the first time).
 *
 * Deliberately NOT alarmed: "no healthy app task". After the scheduled scale to zero at the end of the
 * project there are none on purpose, and that alarm would email you every few minutes forever.
 */
export class Monitoring extends Construct {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[];
  readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: { alertEmail: string; app: App }) {
    super(scope, id);

    this.topic = new sns.Topic(this, "Alerts", { displayName: "Counselor Insights alarms" });
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    const notify = new cwActions.SnsAction(this.topic);
    const fiveMinutes = Duration.minutes(5);

    const lb = props.app.loadBalancer;
    const alarms = [
      new cloudwatch.Alarm(this, "LoadBalancer5xx", {
        alarmDescription: "The load balancer itself returned 5 or more server errors in 5 minutes.",
        metric: lb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, "App5xx", {
        alarmDescription: "The app returned 5 or more server errors in 5 minutes.",
        metric: lb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMinutes, statistic: "Sum" }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // A task that keeps failing its health check is the sign of a restart loop.
      new cloudwatch.Alarm(this, "TaskUnhealthy", {
        alarmDescription: "The app task has been failing its health check (it may be restarting).",
        metric: props.app.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1), statistic: "Maximum" }),
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const a of alarms) a.addAlarmAction(notify);
    this.alarms = alarms;

    // CloudTrail. Its log bucket holds no student data, so it is emptied automatically on `cdk destroy`.
    const trailBucket = new s3.Bucket(this, "TrailBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.trail = new cloudtrail.Trail(this, "Trail", {
      bucket: trailBucket,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });
  }
}
