// Development only: the local stand-in for S3's presigned links. Refused unless STORAGE_MODE=local,
// and never available in a production build. Every request needs a valid, unexpired signature.
import { assertStorageSafe, getAudioStorage, LocalAudioStorage } from "@/lib/storage";
import { AUDIO_TYPES } from "@/lib/storage/audio-types";

export const dynamic = "force-dynamic";

function storage(): LocalAudioStorage | null {
  assertStorageSafe();
  const s = getAudioStorage();
  return s instanceof LocalAudioStorage ? s : null;
}

async function keyOf(ctx: { params: Promise<{ key: string[] }> }): Promise<string> {
  return (await ctx.params).key.join("/");
}

export async function PUT(request: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const s = storage();
  const key = await keyOf(ctx);
  const url = new URL(request.url);
  const contentType = url.searchParams.get("ct") ?? "";
  if (!s || !Object.values<string>(AUDIO_TYPES).includes(contentType)) return new Response("Not found", { status: 404 });
  if (!s.verify("PUT", key, url.searchParams.get("exp"), contentType, url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  // Like S3, the upload must use exactly the Content-Type the link was made for.
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim() !== contentType) {
    return new Response("Wrong content type", { status: 403 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0) return new Response("Empty file", { status: 400 });
  await s.put(key, bytes);
  return new Response(null, { status: 200 });
}

export async function GET(request: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const s = storage();
  const key = await keyOf(ctx);
  const url = new URL(request.url);
  if (!s) return new Response("Not found", { status: 404 });
  if (!s.verify("GET", key, url.searchParams.get("exp"), "", url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const bytes = await s.read(key);
  if (!bytes) return new Response("Not found", { status: 404 });
  const ext = key.split(".").pop() as keyof typeof AUDIO_TYPES;
  return new Response(new Uint8Array(bytes), { headers: { "content-type": AUDIO_TYPES[ext] } });
}
