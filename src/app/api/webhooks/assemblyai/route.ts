import { after } from "next/server";
import { defaultAudioDeps } from "@/lib/transcription/process";
import { handleTranscriptionWebhook } from "@/lib/transcription/webhook";

export const dynamic = "force-dynamic";

// Called by AssemblyAI (or, locally, by the mock) when a transcript is ready.
export async function POST(request: Request) {
  return handleTranscriptionWebhook(request, defaultAudioDeps(), (work) => after(work));
}
