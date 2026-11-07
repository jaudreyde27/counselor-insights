import type { S3Client } from "@aws-sdk/client-s3";
import { isValidAudioKey } from "./audio-types";
import type { AudioStorage } from "./types";

/**
 * The private audio bucket on AWS S3. Written now, but NOT yet run against real AWS: it needs the
 * bucket from the infrastructure phase and AWS credentials. The bucket blocks all public access
 * and has encryption on; the only way in or out is these short-lived presigned links.
 * Credentials come from the environment (the task role when deployed). Nothing is stored here.
 */
export class S3AudioStorage implements AudioStorage {
  private client: Promise<S3Client> | undefined;

  constructor(
    private bucket: string,
    private region = process.env.AWS_REGION ?? "us-east-2",
  ) {
    if (!bucket) throw new Error("S3_AUDIO_BUCKET is not set. See .env.example.");
  }

  // The SDK is loaded only when S3 is actually used.
  private async s3(): Promise<S3Client> {
    this.client ??= import("@aws-sdk/client-s3").then((m) => new m.S3Client({ region: this.region }));
    return this.client;
  }

  private check(key: string) {
    if (!isValidAudioKey(key)) throw new Error("Invalid audio key.");
  }

  async createUploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    this.check(key);
    const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
    ]);
    // The browser must send the same Content-Type header, or S3 refuses the upload.
    return getSignedUrl(await this.s3(), new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), {
      expiresIn: expiresInSeconds,
    });
  }

  async createDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    this.check(key);
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
    ]);
    return getSignedUrl(await this.s3(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async exists(key: string): Promise<boolean> {
    this.check(key);
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      await (await this.s3()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    this.check(key);
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.s3()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
