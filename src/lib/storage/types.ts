/** Where session recordings live. Local folder in development, a private S3 bucket when deployed. */
export interface AudioStorage {
  /** A short-lived link the browser uploads the file to with one PUT. */
  createUploadUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  /** A short-lived link the transcription service downloads the file from. */
  createDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Is the object there? (S3 HeadObject.) */
  exists(key: string): Promise<boolean>;
  /** Deletes the object. Not an error if it is already gone. */
  remove(key: string): Promise<void>;
}
