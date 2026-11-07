/** One spoken turn as the transcription service reports it. `speaker` is its own label ("A", "B"). */
export interface RawUtterance {
  speaker: string;
  text: string;
  start_ms?: number;
  end_ms?: number;
}

export type TranscriptStatus = "queued" | "processing" | "completed" | "error";

export interface TranscriptResult {
  status: TranscriptStatus;
  /** Present when completed. */
  utterances?: RawUtterance[];
}

export interface CreateJobInput {
  /** Short-lived link to the recording. */
  audioUrl: string;
  /** Where the service calls when it is done. */
  webhookUrl: string;
  /** Header the service must send back, so the app can reject anyone else. */
  webhookHeaderName: string;
  webhookSecret: string;
}

/** Provider-neutral transcription: the real one is AssemblyAI, the local stand-in is a mock. */
export interface TranscriptionClient {
  createJob(input: CreateJobInput): Promise<{ id: string }>;
  getTranscript(id: string): Promise<TranscriptResult>;
  /** Removes the transcript from the provider once we have saved it. Best effort. */
  deleteTranscript(id: string): Promise<void>;
}

/** Header AssemblyAI is told to send on its webhook call. */
export const WEBHOOK_HEADER_NAME = "x-webhook-secret";
