import { describe, expect, it } from "vitest";
import { parsePastedTranscript } from "@/lib/transcript";
import { FIXTURE_NAMES, loadFixture } from "./helpers/llm";

describe("pasted transcript parser", () => {
  it("parses Counselor: and Student: lines into ordered utterances", () => {
    const r = parsePastedTranscript("Counselor: Hello.\nStudent: Hi there.\nCounselor: How are you?");
    expect(r).toEqual({
      ok: true,
      utterances: [
        { speaker: "counselor", text: "Hello." },
        { speaker: "student", text: "Hi there." },
        { speaker: "counselor", text: "How are you?" },
      ],
    });
  });

  it("accepts any capitalization, extra spaces, and Windows line endings", () => {
    const r = parsePastedTranscript("  COUNSELOR :  Hello.\r\nstudent:Hi.\r\n");
    expect(r).toEqual({
      ok: true,
      utterances: [
        { speaker: "counselor", text: "Hello." },
        { speaker: "student", text: "Hi." },
      ],
    });
  });

  it("ignores blank lines and joins unlabeled lines to the previous turn", () => {
    const r = parsePastedTranscript("Counselor: Hello.\n\nStudent: It was hard\nand long.\n\n");
    expect(r).toEqual({
      ok: true,
      utterances: [
        { speaker: "counselor", text: "Hello." },
        { speaker: "student", text: "It was hard and long." },
      ],
    });
  });

  it("keeps colons inside the text", () => {
    const r = parsePastedTranscript("Student: My rent is due: Friday.");
    expect(r).toMatchObject({ ok: true, utterances: [{ text: "My rent is due: Friday." }] });
  });

  it("rejects text that starts without a speaker label, and says which line", () => {
    const r = parsePastedTranscript("Hello there\nStudent: Hi.");
    expect(r).toEqual({ ok: false, error: 'Line 1 must start with "Counselor:" or "Student:".' });
  });

  it("rejects empty input and input with no student lines", () => {
    expect(parsePastedTranscript("  \n ").ok).toBe(false);
    expect(parsePastedTranscript("Counselor: Hello.\nCounselor: Anyone there?").ok).toBe(false);
  });

  it("round-trips every fixture written as pasted text", () => {
    for (const name of FIXTURE_NAMES) {
      const lines = loadFixture(name);
      const text = lines.map((l) => `${l.speaker === "student" ? "Student" : "Counselor"}: ${l.text}`).join("\n");
      const r = parsePastedTranscript(text);
      expect(r.ok, name).toBe(true);
      if (r.ok) expect(r.utterances).toEqual(lines.map(({ speaker, text }) => ({ speaker, text })));
    }
  });
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseTranscriptFile } from "@/lib/transcript";

describe("uploaded transcript files", () => {
  it("reads a .txt file in the Counselor:/Student: format", () => {
    const r = parseTranscriptFile("session.txt", "Counselor: Hello.\nStudent: Hi.\n");
    expect(r).toEqual({
      ok: true,
      utterances: [
        { speaker: "counselor", text: "Hello." },
        { speaker: "student", text: "Hi." },
      ],
    });
  });

  it("reads a .json file (the format npm run analyze uses), even if it has no .json name", () => {
    const json = JSON.stringify([
      { speaker: "counselor", text: " Hello. " },
      { speaker: "student", text: "Hi." },
    ]);
    const expected = { ok: true, utterances: [{ speaker: "counselor", text: "Hello." }, { speaker: "student", text: "Hi." }] };
    expect(parseTranscriptFile("session.json", json)).toEqual(expected);
    expect(parseTranscriptFile("session.txt", json)).toEqual(expected);
  });

  it("ignores a byte-order mark at the start of the file", () => {
    expect(parseTranscriptFile("a.txt", "﻿Student: Hi.").ok).toBe(true);
  });

  it("rejects bad files with a plain message", () => {
    expect(parseTranscriptFile("a.json", "{not json")).toEqual({ ok: false, error: "That JSON file could not be read." });
    expect(parseTranscriptFile("a.json", "[]").ok).toBe(false);
    expect(parseTranscriptFile("a.json", JSON.stringify([{ speaker: "robot", text: "x" }])).ok).toBe(false);
    expect(parseTranscriptFile("a.json", JSON.stringify([{ speaker: "counselor", text: "x" }])).ok).toBe(false); // no student
    expect(parseTranscriptFile("a.txt", "just some words").ok).toBe(false);
    expect(parseTranscriptFile("a.txt", "Student: " + "x".repeat(200_001))).toEqual({
      ok: false,
      error: "That transcript file is too large.",
    });
  });

  it("the ready-made upload files in fixtures/upload match the fixtures exactly", () => {
    const files = readdirSync(path.resolve("fixtures/upload")).filter((f) => f.endsWith(".txt"));
    expect(files.length).toBe(FIXTURE_NAMES.length);
    for (const f of files) {
      const txt = readFileSync(path.resolve("fixtures/upload", f), "utf8");
      const parsed = parseTranscriptFile(f, txt);
      expect(parsed.ok, f).toBe(true);
      const json = loadFixture(f.replace(/\.txt$/, ".json")).map(({ speaker, text }) => ({ speaker, text }));
      if (parsed.ok) expect(parsed.utterances, f).toEqual(json);
    }
  });
});
