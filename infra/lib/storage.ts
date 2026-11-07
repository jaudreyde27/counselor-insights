import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * The audio bucket (SPEC.md step 2): private, encrypted, all public access blocked, versioning off, and NO
 * lifecycle expiry. Recordings stay until deleted by hand. The only way in or out is a presigned link.
 * CORS lets the browser PUT a recording from the app's address and from localhost.
 * It is not auto-emptied on `cdk destroy`: a non-empty bucket makes the destroy stop, so recordings are only
 * ever removed deliberately (docs/SHUTDOWN.md, step 2).
 */
export class Storage extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: { appHostname: string }) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, "Audio", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [`https://${props.appHostname}`, "http://localhost:3000"],
          allowedHeaders: ["Content-Type"],
          exposedHeaders: ["ETag"],
          maxAge: Duration.hours(1).toSeconds(),
        },
      ],
    });
  }
}
