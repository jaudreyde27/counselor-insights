// Usage: npm run fixtures:audio
// Writes tiny SILENT placeholder WAV files to fixtures/audio/, one per fictional fixture transcript.
// Each carries a hidden "fixture-0N" note so the local stand-in transcriber (TRANSCRIPTION_MODE=mock)
// knows which fictional transcript to return. They contain no speech: real recordings are made by the team.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function wav(note: string): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2); // one second of 16-bit silence
  const text = Buffer.from(note + "\0", "latin1");
  const comment = Buffer.concat([text, Buffer.alloc(text.length % 2)]); // chunks are padded to even length
  const infoBody = Buffer.concat([Buffer.from("INFO"), Buffer.from("ICMT"), u32(comment.length), comment]);
  const fmt = Buffer.concat([u16(1), u16(1), u32(rate), u32(rate * 2), u16(2), u16(16)]);
  const chunks = Buffer.concat([
    Buffer.from("fmt "), u32(fmt.length), fmt,
    Buffer.from("LIST"), u32(infoBody.length), infoBody,
    Buffer.from("data"), u32(data.length), data,
  ]);
  return Buffer.concat([Buffer.from("RIFF"), u32(4 + chunks.length), Buffer.from("WAVE"), chunks]);
}
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

mkdirSync("fixtures/audio", { recursive: true });
for (const f of readdirSync("fixtures/transcripts").filter((x) => x.endsWith(".json"))) {
  const name = f.replace(/\.json$/, "");
  writeFileSync(path.join("fixtures/audio", `${name}.wav`), wav(`fixture-${name}`));
  console.log(`fixtures/audio/${name}.wav`);
}
