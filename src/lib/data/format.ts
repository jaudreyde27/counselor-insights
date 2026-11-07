/** "2026-11-06" -> "Nov 6, 2026". Parsed as a plain calendar date so time zones never shift it. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export const SESSION_STATUS_LABEL: Record<string, string> = {
  created: "Created",
  awaiting_upload: "Awaiting upload",
  uploaded: "Uploaded",
  transcribing: "Transcribing",
  transcribed: "Transcribed",
  analyzing: "Analyzing",
  complete: "Complete",
  failed: "Failed",
};

/** Statuses where something is still happening and the page should keep refreshing. */
export const PROCESSING_STATUSES = ["created", "awaiting_upload", "uploaded", "transcribing", "transcribed", "analyzing"];

/** What the "in progress" banner says for each stage of a session. */
export function processingCopy(status: string | null): { title: string; text: string } {
  switch (status) {
    case "awaiting_upload":
      return { title: "Uploading the recording", text: "Waiting for the upload to finish. This page updates on its own." };
    case "uploaded":
    case "transcribing":
      return {
        title: "Transcribing the recording",
        text: "This can take a few minutes. This page updates on its own when the transcript is ready.",
      };
    default:
      return { title: "Analyzing the session", text: "This page updates on its own when the results are ready." };
  }
}
